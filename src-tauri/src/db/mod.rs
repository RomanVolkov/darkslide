use darkslide_core::types::Adjustments;
use include_dir::{Dir, include_dir};
use log::debug;
use rusqlite::{Connection, OptionalExtension, params};
use rusqlite_migration::Migrations;
use std::{
    fs::{self},
    os::unix::raw::time_t,
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tauri::Manager;

static MIGRATIONS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/db/migrations");
static MIGRATIONS: LazyLock<Migrations<'static>> =
    LazyLock::new(|| Migrations::from_directory(&MIGRATIONS_DIR).unwrap());
static DB_NAME: &str = "darkslide.sqlite";

type Job = Box<dyn FnOnce(&mut rusqlite::Connection) + Send + 'static>;

#[derive(Clone)]
pub struct Db {
    tx: std::sync::mpsc::Sender<Job>,
    path: PathBuf,
    is_ephemeral: bool,
}

pub struct Lut {
    pub id: u32,
    pub name: String,
    pub values: Vec<f32>,
    pub size: usize,
    pub created_at: time_t,
}

pub struct LutMeta {
    pub id: u32,
    pub name: String,
}

pub struct ImageRecord {
    pub id: uuid::Uuid,
    pub current_path: Option<Box<std::path::Path>>,
    pub file_size: u64,
    pub adjustments: Adjustments,
}

impl ImageRecord {
    /// Maps a `SELECT uuid, current_path, file_size, adjustments` row into an
    /// `ImageRecord`. Shared by all image-record queries so the column order
    /// and JSON/UUID parsing live in one place.
    fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        let uuid_str: String = row.get(0)?;
        let path_str: String = row.get(1)?;
        let adj_json: String = row.get(3)?;
        Ok(Self {
            id: uuid::Uuid::parse_str(&uuid_str).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
            current_path: Some(Box::from(std::path::Path::new(&path_str))),
            file_size: row.get::<_, u32>(2)? as u64,
            adjustments: parse_adjustments(&adj_json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
        })
    }
}

/// A persistent editing session (tmux-style): an ordered list of image paths.
#[derive(serde::Serialize)]
pub struct Session {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub paths: Vec<String>,
}

/// Lightweight session row for the palette list view.
#[derive(serde::Serialize)]
pub struct SessionSummary {
    pub id: i64,
    pub name: String,
    pub image_count: usize,
    pub updated_at: String,
}

/// RFC3339 timestamp with microsecond precision, used for `created_at` /
/// `updated_at`. UTC so lexical ordering matches chronological ordering.
fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

/// Deserialize a persisted adjustments JSON blob, migrating the legacy singular
/// `curve` field into `curves.rgb`.
pub fn parse_adjustments(json: &str) -> Result<Adjustments, serde_json::Error> {
    let mut value: serde_json::Value = serde_json::from_str(json)?;
    migrate_legacy_curve(&mut value);
    serde_json::from_value(value)
}

/// Move a legacy top-level `"curve"` array into `curves.rgb` when no `curves`
/// object is present, then drop the stale key.
fn migrate_legacy_curve(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if obj.contains_key("curves") {
        obj.remove("curve");
        return;
    }
    if let Some(legacy) = obj.remove("curve") {
        obj.insert("curves".to_string(), serde_json::json!({ "rgb": legacy }));
    }
}

/// Detect schema drift between the on-disk DB and what the current migration
/// set *should* have produced.
///
/// `rusqlite_migration` only tracks which migration numbers were applied, not
/// the SQL that actually ran. If a DB was created by an older build — or
/// hand-edited with the same migration number but different SQL — `to_latest`
/// is a no-op and the app boots against a drifted schema. To catch this we
/// replay all migrations against a fresh in-memory DB and compare the
/// resulting table shapes against the on-disk DB. The source of truth is the
/// migration files themselves, so no hand-maintained list can drift away
/// from them.
pub fn validate_schema(conn: &Connection) -> Result<(), String> {
    let mut ref_conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    MIGRATIONS
        .to_latest(&mut ref_conn)
        .map_err(|e| format!("reference schema: {}", e))?;

    let ref_tables = user_tables(&ref_conn)?;

    for table in &ref_tables {
        let expected = column_names(&ref_conn, table)?;
        let actual = column_names_opt(conn, table)?;
        match actual {
            None => {
                return Err(format!(
                    "schema drift: expected table `{}` is missing. \
                     Database was created or modified by an incompatible build; \
                     delete the file and restart.",
                    table
                ));
            }
            Some(actual) if actual != expected => {
                return Err(format!(
                    "schema drift: table `{}` columns mismatch.\n  expected: {:?}\n  actual:   {:?}\n\
                     Database was created or modified by an incompatible build; \
                     delete the file and restart.",
                    table, expected, actual
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn user_tables(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%' \
             AND substr(name,1,1) != '_'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut v = Vec::new();
    for r in rows {
        v.push(r.map_err(|e| e.to_string())?);
    }
    Ok(v)
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    match column_names_opt(conn, table)? {
        Some(c) => Ok(c),
        None => Err(format!("table `{}` not found", table)),
    }
}

fn column_names_opt(conn: &Connection, table: &str) -> Result<Option<Vec<String>>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut v = Vec::new();
    for r in rows {
        v.push(r.map_err(|e| e.to_string())?);
    }
    Ok(if v.is_empty() { None } else { Some(v) })
}

pub fn resolve_db_path(app_data_dir: &Path, is_scenario: bool) -> (PathBuf, bool) {
    if let Ok(custom) = std::env::var("DARKSLIDE_DB_PATH") {
        let is_ephemeral = is_scenario
            || std::env::var("DARKSLIDE_DB_EPHEMERAL")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
        return (PathBuf::from(custom), is_ephemeral);
    }

    if is_scenario {
        let temp_db = std::env::temp_dir().join(format!("darkslide_profile_{}.sqlite", uuid::Uuid::new_v4()));
        return (temp_db, true);
    }

    if let Ok(env_val) = std::env::var("DARKSLIDE_ENV") {
        if env_val.eq_ignore_ascii_case("release") {
            return (app_data_dir.join("darkslide_release.sqlite"), false);
        }
        if env_val.eq_ignore_ascii_case("dev") {
            return (app_data_dir.join("darkslide_dev.sqlite"), false);
        }
    }

    if cfg!(debug_assertions) {
        return (app_data_dir.join("darkslide_dev.sqlite"), false);
    }

    (app_data_dir.join(DB_NAME), false)
}

impl Db {
    pub fn new(app: &tauri::App, is_scenario: bool) -> Result<Self, String> {
        let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let (db_path, is_ephemeral) = resolve_db_path(&app_dir, is_scenario);
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        Self::open_with_options(db_path, is_ephemeral)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_ephemeral(&self) -> bool {
        self.is_ephemeral
    }

    pub fn cleanup_if_ephemeral(&self) -> Result<(), String> {
        if !self.is_ephemeral {
            return Ok(());
        }
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let _ = self.tx.send(Box::new(move |conn| {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            let _ = done_tx.send(());
        }));
        let _ = done_rx.recv_timeout(std::time::Duration::from_millis(500));
        let path = &self.path;
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        if wal.exists() {
            let _ = fs::remove_file(wal);
        }
        let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
        if shm.exists() {
            let _ = fs::remove_file(shm);
        }
        Ok(())
    }

    /// Open (and migrate) the SQLite DB at `db_path`. Also validates the
    /// on-disk schema against the schema produced by replaying the current
    /// migration set against a fresh in-memory DB, so silent drift fails
    /// loudly. Used by `Db::new` and by tests.
    pub fn open(db_path: PathBuf) -> Result<Self, String> {
        Self::open_with_options(db_path, false)
    }

    pub fn open_with_options(db_path: PathBuf, is_ephemeral: bool) -> Result<Self, String> {
        debug!("{}", db_path.to_string_lossy());

        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        let pending = MIGRATIONS
            .pending_migrations(&conn)
            .map_err(|e| e.to_string())?;
        debug!("count of MIGRATIONS: {}", pending);
        MIGRATIONS.to_latest(&mut conn).map_err(|e| e.to_string())?;
        validate_schema(&conn)?;

        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        std::thread::spawn(move || {
            for job in rx {
                job(&mut conn);
            }
        });

        Ok(Self {
            tx,
            path: db_path,
            is_ephemeral,
        })
    }

    async fn call<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut rusqlite::Connection) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();

        self.tx
            .send(Box::new(move |conn| {
                let res = f(conn);
                let _ = reply_tx.send(res);
            }))
            .map_err(|_| "db thread is gone".to_string())?;

        reply_rx.await.map_err(|e| e.to_string())?
    }

    pub async fn store_lut(&self, name: String, values: Vec<f32>, size: u32) -> Result<(), String> {
        self.call(move |conn| {
            let bytes: &[u8] = bytemuck::cast_slice(&values);
            conn.execute(
                "INSERT INTO lut (name, lut_values, lut_size)  VALUES (?1, ?2, ?3  )",
                params![name, bytes, size],
            )
            .map_err(|e| e.to_string())
            .map(|_| ())
        })
        .await
    }

    pub async fn delete_lut(&self, id: u32) -> Result<(), String> {
        self.call(move |conn| {
            conn.execute("DELETE FROM lut where id = ?1", params![id])
                .map_err(|e| e.to_string())
                .map(|_| ())
        })
        .await
    }

    pub async fn load_lut(&self, id: u32) -> Result<Option<Lut>, String> {
        self.call(move |conn| {
            let mut cmd = conn
                .prepare("SELECT id, name, lut_values, lut_size, created_at from lut WHERE id = ?1")
                .map_err(|e| e.to_string())?;

            let lut_result = cmd.query_one([id], |row| {
                let raw_bytes: Vec<u8> = row.get(2)?;
                Ok(Lut {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    values: bytemuck::cast_slice(&raw_bytes).to_vec(),
                    size: row.get::<_, i64>(3)? as usize,
                    created_at: row.get(4)?,
                })
            });

            match lut_result {
                Ok(lut) => Ok(Some(lut)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
        .await
    }

    pub async fn load_luts(&self) -> Result<Vec<Lut>, String> {
        self.call(move |conn| {
            let mut cmd = conn
                .prepare("SELECT id, name, lut_values, lut_size, created_at from lut")
                .map_err(|e| e.to_string())?;

            let lut_iter = cmd
                .query_map([], |row| {
                    let raw_bytes: Vec<u8> = row.get(2)?;
                    Ok(Lut {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        values: bytemuck::cast_slice(&raw_bytes).to_vec(),
                        size: row.get::<_, i64>(3)? as usize,
                        created_at: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;

            let mut values: Vec<Lut> = Vec::new();
            for item in lut_iter {
                values.push(item.map_err(|e| e.to_string())?);
            }

            Ok(values)
        })
        .await
    }

    /// Load only LUT metadata (`id` and `name`) without fetching the potentially
    /// large `lut_values` blob. Used for UI list views.
    pub async fn load_lut_meta(&self) -> Result<Vec<LutMeta>, String> {
        self.call(move |conn| {
            let mut cmd = conn
                .prepare("SELECT id, name from lut")
                .map_err(|e| e.to_string())?;

            let meta_iter = cmd
                .query_map([], |row| {
                    Ok(LutMeta {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                })
                .map_err(|e| e.to_string())?;

            let mut values: Vec<LutMeta> = Vec::new();
            for item in meta_iter {
                values.push(item.map_err(|e| e.to_string())?);
            }

            Ok(values)
        })
        .await
    }

    // Images

    // 1. Search by UUID
    pub async fn find_image_by_uuid(&self, id: uuid::Uuid) -> Result<Option<ImageRecord>, String> {
        self.call(move |conn| {
            let mut cmd = conn
                .prepare(
                    "SELECT uuid, current_path, file_size, adjustments \
                 FROM image_record WHERE uuid = ?1",
                )
                .map_err(|e| e.to_string())?;

            let result = cmd.query_one([id.to_string()], ImageRecord::from_row);

            match result {
                Ok(rec) => Ok(Some(rec)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
        .await
    }

    // 2. Search by current_path + file_size
    pub async fn find_image_by_path_and_size(
        &self,
        current_path: &std::path::Path,
        file_size: u64,
    ) -> Result<Option<ImageRecord>, String> {
        let path = (*current_path).to_owned();

        self.call(move |conn| {
            let mut cmd = conn
                .prepare(
                    "SELECT uuid, current_path, file_size, adjustments \
                 FROM image_record WHERE current_path = ?1 AND file_size = ?2",
                )
                .map_err(|e| e.to_string())?;

            let path_str = path.to_string_lossy();
            let result = cmd.query_one(
                params![path_str.as_ref(), file_size as i64],
                ImageRecord::from_row,
            );

            match result {
                Ok(rec) => Ok(Some(rec)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
        .await
    }

    // 3. Generate (insert) a new record. Returns the created record with its
    // fresh UUID and default adjustments.
    pub async fn create_image_record(
        &self,
        current_path: Option<&std::path::Path>,
        file_size: u64,
    ) -> Result<ImageRecord, String> {
        let id = uuid::Uuid::new_v4();
        let adjustments = Adjustments::default();
        let path_str = current_path
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let adj_json = serde_json::to_string(&adjustments).map_err(|e| e.to_string())?;
        let path = current_path.map(Box::from);

        self.call(move |conn| {
            conn.execute(
                "INSERT INTO image_record (uuid, current_path, file_size, adjustments) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![id.to_string(), path_str, file_size as i64, adj_json],
            )
            .map_err(|e| match &e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    format!("uuid collision: record {} already exists", id)
                }
                _ => e.to_string(),
            })?;

            Ok(ImageRecord {
                id,
                current_path: path,
                file_size,
                adjustments,
            })
        })
        .await
    }

    // 4. Update path by UUID (MOVE detected)
    pub async fn update_image_path(
        &self,
        id: uuid::Uuid,
        new_path: &std::path::Path,
    ) -> Result<(), String> {
        let path_str = new_path.to_string_lossy().into_owned();
        self.call(move |conn| {
            let affected = conn
                .execute(
                    "UPDATE image_record SET current_path = ?1 WHERE uuid = ?2",
                    params![path_str, id.to_string()],
                )
                .map_err(|e| e.to_string())?;
            if affected == 0 {
                Err(format!("no image_record found for uuid {}", id))
            } else {
                Ok(())
            }
        })
        .await
    }

    // 5. Fork: create new record with a new UUID, copying adjustments from source (DUPLICATE)
    pub async fn fork_image_record(
        &self,
        source_id: uuid::Uuid,
        new_id: uuid::Uuid,
        new_path: &std::path::Path,
        file_size: u64,
    ) -> Result<ImageRecord, String> {
        let path_str = new_path.to_string_lossy().into_owned();
        let new_path_box = Box::from(new_path.to_path_buf());

        self.call(move |conn| {
            let mut cmd = conn
                .prepare("SELECT adjustments FROM image_record WHERE uuid = ?1")
                .map_err(|e| e.to_string())?;

            let adj_json: String = cmd
                .query_row(params![source_id.to_string()], |row| row.get(0))
                .map_err(|e| e.to_string())?;

            let adjustments: Adjustments =
                parse_adjustments(&adj_json).map_err(|e| e.to_string())?;

            // Persist the migrated JSON (legacy `curve`/absolute temperature
            // rewritten) rather than the raw source row.
            let migrated_json =
                serde_json::to_string(&adjustments).map_err(|e| e.to_string())?;

            conn.execute(
                "INSERT INTO image_record (uuid, current_path, file_size, adjustments) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![new_id.to_string(), path_str, file_size as i64, migrated_json],
            )
            .map_err(|e| e.to_string())?;

            Ok(ImageRecord {
                id: new_id,
                current_path: Some(new_path_box),
                file_size,
                adjustments,
            })
        })
        .await
    }

    // 6. Replace UUID in an existing record (HEAL: xattr UUID was lost)
    pub async fn update_image_uuid(
        &self,
        old_id: uuid::Uuid,
        new_id: uuid::Uuid,
    ) -> Result<(), String> {
        self.call(move |conn| {
            let affected = conn
                .execute(
                    "UPDATE image_record SET uuid = ?1 WHERE uuid = ?2",
                    params![new_id.to_string(), old_id.to_string()],
                )
                .map_err(|e| e.to_string())?;
            if affected == 0 {
                Err(format!("no image_record found for uuid {}", old_id))
            } else {
                Ok(())
            }
        })
        .await
    }

    // 7. Update adjustments by UUID
    pub async fn update_adjustments(
        &self,
        id: uuid::Uuid,
        adjustments: &Adjustments,
    ) -> Result<(), String> {
        let adj_json = serde_json::to_string(adjustments).map_err(|e| e.to_string())?;
        self.call(move |conn| {
            let affected = conn
                .execute(
                    "UPDATE image_record SET adjustments = ?1 WHERE uuid = ?2",
                    params![adj_json, id.to_string()],
                )
                .map_err(|e| e.to_string())?;
            if affected == 0 {
                Err(format!("no image_record found for uuid {}", id))
            } else {
                Ok(())
            }
        })
        .await
    }

    pub async fn clear_all_image_records(&self) -> Result<(), String> {
        self.call(move |conn| {
            conn.execute("DELETE FROM image_record", [])
                .map_err(|e| e.to_string())?;
            conn.execute_batch("VACUUM;")
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn insert_image_record_with_uuid(
        &self,
        id: uuid::Uuid,
        current_path: Option<&std::path::Path>,
        file_size: u64,
    ) -> Result<(), String> {
        let adjustments = Adjustments::default();
        let path_str = current_path
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let adj_json = serde_json::to_string(&adjustments).map_err(|e| e.to_string())?;
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO image_record (uuid, current_path, file_size, adjustments) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![id.to_string(), path_str, file_size as i64, adj_json],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    // Sessions

    /// Insert a session with the given name and ordered paths. Returns the new
    /// row id.
    pub async fn create_session(&self, name: String, paths: Vec<String>) -> Result<i64, String> {
        let paths_json = serde_json::to_string(&paths).map_err(|e| e.to_string())?;
        let ts = now_ts();
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO session (name, created_at, updated_at, paths) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![name, ts, ts, paths_json],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// List sessions most-recently-updated first (palette MRU order).
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        self.call(move |conn| {
            let mut cmd = conn
                .prepare(
                    "SELECT id, name, paths, updated_at FROM session \
                     ORDER BY updated_at DESC, id DESC",
                )
                .map_err(|e| e.to_string())?;

            let iter = cmd
                .query_map([], |row| {
                    let paths_json: String = row.get(2)?;
                    let image_count = serde_json::from_str::<Vec<String>>(&paths_json)
                        .map(|v| v.len())
                        .unwrap_or(0);
                    Ok(SessionSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        image_count,
                        updated_at: row.get(3)?,
                    })
                })
                .map_err(|e| e.to_string())?;

            let mut values: Vec<SessionSummary> = Vec::new();
            for item in iter {
                values.push(item.map_err(|e| e.to_string())?);
            }
            Ok(values)
        })
        .await
    }

    /// Find an existing session whose images match `paths` as an exact set (order-independent).
    /// If multiple matches exist, the most recently updated one is returned.
    pub async fn find_matching_session(&self, paths: Vec<String>) -> Result<Option<SessionSummary>, String> {
        if paths.is_empty() {
            return Ok(None);
        }
        self.call(move |conn| {
            let mut cmd = conn
                .prepare(
                    "SELECT id, name, paths, updated_at FROM session \
                     ORDER BY updated_at DESC, id DESC",
                )
                .map_err(|e| e.to_string())?;

            let candidate_len = paths.len();
            let candidate_set: std::collections::HashSet<&String> = paths.iter().collect();

            let iter = cmd
                .query_map([], |row| {
                    let id: i64 = row.get(0)?;
                    let name: String = row.get(1)?;
                    let paths_json: String = row.get(2)?;
                    let updated_at: String = row.get(3)?;
                    Ok((id, name, paths_json, updated_at))
                })
                .map_err(|e| e.to_string())?;

            for item in iter {
                let (id, name, paths_json, updated_at) = item.map_err(|e| e.to_string())?;
                let existing_paths: Vec<String> = match serde_json::from_str(&paths_json) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if existing_paths.len() != candidate_len {
                    continue;
                }
                if existing_paths.iter().all(|p| candidate_set.contains(p)) {
                    return Ok(Some(SessionSummary {
                        id,
                        name,
                        image_count: existing_paths.len(),
                        updated_at,
                    }));
                }
            }
            Ok(None)
        })
        .await
    }

    /// Touch a session by bumping `updated_at` to now.
    pub async fn touch_session(&self, id: i64) -> Result<(), String> {
        let ts = now_ts();
        self.call(move |conn| {
            conn.execute(
                "UPDATE session SET updated_at = ?1 WHERE id = ?2",
                params![ts, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    /// Return a session's paths in load order. Bumps `updated_at` so the
    /// palette reflects true recency (an attach counts as a touch). A missing
    /// session yields an empty list.
    pub async fn get_session_paths(&self, id: i64) -> Result<Vec<String>, String> {
        let ts = now_ts();
        self.call(move |conn| {
            let paths_json: Option<String> = conn
                .query_row("SELECT paths FROM session WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;

            let Some(json) = paths_json else {
                return Ok(Vec::new());
            };

            conn.execute(
                "UPDATE session SET updated_at = ?1 WHERE id = ?2",
                params![ts, id],
            )
            .map_err(|e| e.to_string())?;

            serde_json::from_str(&json).map_err(|e| e.to_string())
        })
        .await
    }

    /// Rename a session and bump `updated_at`.
    pub async fn rename_session(&self, id: i64, name: String) -> Result<(), String> {
        let ts = now_ts();
        self.call(move |conn| {
            let affected = conn
                .execute(
                    "UPDATE session SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![name, ts, id],
                )
                .map_err(|e| e.to_string())?;
            if affected == 0 {
                Err(format!("no session found for id {}", id))
            } else {
                Ok(())
            }
        })
        .await
    }

    /// Delete a session. Missing ids are a no-op.
    pub async fn delete_session(&self, id: i64) -> Result<(), String> {
        self.call(move |conn| {
            conn.execute("DELETE FROM session WHERE id = ?1", [id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    /// Remove paths from a session's membership (in load order). Unknown paths
    /// are ignored, and a request that removes nothing is a true no-op. When the
    /// last path is removed the session row itself is deleted (tmux semantics).
    pub async fn remove_paths_from_session(&self, id: i64, paths: Vec<String>) -> Result<(), String> {
        let ts = now_ts();
        self.call(move |conn| {
            let paths_json: Option<String> = conn
                .query_row("SELECT paths FROM session WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;

            let Some(json) = paths_json else {
                return Ok(());
            };

            let mut current: Vec<String> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let before = current.len();
            let to_remove: std::collections::HashSet<&String> = paths.iter().collect();
            current.retain(|p| !to_remove.contains(p));

            if current.is_empty() {
                conn.execute("DELETE FROM session WHERE id = ?1", [id])
                    .map_err(|e| e.to_string())?;
            } else if current.len() != before {
                let new_json = serde_json::to_string(&current).map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE session SET paths = ?1, updated_at = ?2 WHERE id = ?3",
                    params![new_json, ts, id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
    }
}
