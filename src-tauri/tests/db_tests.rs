use darkslide_core::types::Adjustments;
use darkslide_lib::db::{Db, resolve_db_path, validate_schema};
use darkslide_lib::{
    auto_session_name, create_session_internal, remove_images_from_session, rename_session_internal,
};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::TempDir;

/// Drive an async fn from a sync test.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Runtime::new().unwrap().block_on(future)
}

struct TestDb {
    _dir: TempDir,
    db: Db,
}

impl TestDb {
    fn new() -> Self {
        let dir = TempDir::new().expect("tempdir");
        let path: PathBuf = dir.path().join("test.sqlite");
        let db = Db::open(path).expect("Db::open");
        Self { _dir: dir, db }
    }
}

fn sample_values() -> Vec<f32> {
    vec![0.1, 0.2, 0.3, 0.4]
}

#[test]
fn opens_and_migrates_empty_db() {
    let tdb = TestDb::new();
    let luts = block_on(tdb.db.load_luts()).expect("load_luts");
    assert!(luts.is_empty(), "fresh DB should have no luts");
}

#[test]
fn store_and_load_lut_roundtrip() {
    let tdb = TestDb::new();
    let values = sample_values();
    block_on(
        tdb.db
            .store_lut("test.cube".into(), values.clone(), values.len() as u32),
    )
    .expect("store_lut");

    let loaded = block_on(tdb.db.load_lut(1))
        .expect("load_lut")
        .expect("lut id=1");
    assert_eq!(loaded.id, 1);
    assert_eq!(loaded.name, "test.cube");
    assert_eq!(loaded.values, values);
    assert_eq!(loaded.size, values.len());
}

#[test]
fn load_lut_meta_does_not_fetch_values() {
    let tdb = TestDb::new();
    let values = sample_values();
    block_on(
        tdb.db
            .store_lut("test.cube".into(), values.clone(), values.len() as u32),
    )
    .expect("store_lut");

    let meta = block_on(tdb.db.load_lut_meta()).expect("load_lut_meta");
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].id, 1);
    assert_eq!(meta[0].name, "test.cube");
}

#[test]
fn load_missing_lut_returns_none() {
    let tdb = TestDb::new();
    let loaded = block_on(tdb.db.load_lut(999)).expect("load_lut");
    assert!(
        loaded.is_none(),
        "nonexistent id should map to None, not Err"
    );
}

#[test]
fn store_multiple_and_list_all() {
    let tdb = TestDb::new();
    let v = sample_values();
    block_on(tdb.db.store_lut("a".into(), v.clone(), 4)).unwrap();
    block_on(tdb.db.store_lut("b".into(), v.clone(), 4)).unwrap();
    block_on(tdb.db.store_lut("c".into(), v, 4)).unwrap();

    let luts = block_on(tdb.db.load_luts()).expect("load_luts");
    assert_eq!(luts.len(), 3);
    let names: Vec<String> = luts.into_iter().map(|l| l.name).collect();
    assert_eq!(names, vec!["a", "b", "c"]);
}

#[test]
fn delete_lut_removes_only_target() {
    let tdb = TestDb::new();
    let v = sample_values();
    block_on(tdb.db.store_lut("a".into(), v.clone(), 4)).unwrap();
    block_on(tdb.db.store_lut("b".into(), v.clone(), 4)).unwrap();
    block_on(tdb.db.store_lut("c".into(), v, 4)).unwrap();

    block_on(tdb.db.delete_lut(2)).expect("delete_lut");

    let luts = block_on(tdb.db.load_luts()).expect("load_luts");
    assert_eq!(luts.len(), 2);
    let names: Vec<String> = luts.into_iter().map(|l| l.name).collect();
    assert_eq!(names, vec!["a", "c"]);

    assert!(block_on(tdb.db.load_lut(2)).expect("load_lut").is_none());
}

#[test]
fn delete_nonexistent_lut_is_noop() {
    let tdb = TestDb::new();
    block_on(tdb.db.delete_lut(42)).expect("delete_lut");
    assert!(block_on(tdb.db.load_luts()).expect("load_luts").is_empty());
}

#[test]
fn detects_missing_table_drift() {
    let conn = Connection::open_in_memory().expect("open_in_memory");
    match validate_schema(&conn) {
        Ok(_) => panic!("should detect drift"),
        Err(e) => assert!(e.contains("schema drift"), "unexpected message: {}", e),
    }
}

#[test]
fn detects_column_mismatch_drift() {
    let conn = Connection::open_in_memory().expect("open_in_memory");
    conn.execute_batch("CREATE TABLE lut (id INTEGER PRIMARY KEY, wrong_col TEXT);")
        .unwrap();
    match validate_schema(&conn) {
        Ok(_) => panic!("should detect drift"),
        Err(e) => {
            assert!(e.contains("schema drift"), "unexpected message: {}", e);
            assert!(e.contains("lut"), "should name the drifted table: {}", e);
        }
    }
}

#[test]
fn create_and_find_image_by_uuid() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/img1.cr3");
    let rec = block_on(tdb.db.create_image_record(Some(path), 12345)).expect("create_image_record");
    assert_eq!(rec.file_size, 12345);
    assert_eq!(rec.current_path.as_deref(), Some(path));
    assert_eq!(
        serde_json::to_string(&rec.adjustments).unwrap(),
        serde_json::to_string(&Adjustments::default()).unwrap()
    );

    let loaded = block_on(tdb.db.find_image_by_uuid(rec.id))
        .expect("find_image_by_uuid")
        .expect("record should exist");
    assert_eq!(loaded.id, rec.id);
    assert_eq!(loaded.file_size, rec.file_size);
    assert_eq!(loaded.current_path.as_deref(), Some(path));
    assert_eq!(
        serde_json::to_string(&loaded.adjustments).unwrap(),
        serde_json::to_string(&rec.adjustments).unwrap()
    );
}

#[test]
fn find_image_by_path_and_size_matches() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/img2.cr3");
    let rec = block_on(tdb.db.create_image_record(Some(path), 999)).expect("create_image_record");

    let loaded = block_on(tdb.db.find_image_by_path_and_size(path, 999))
        .expect("find_image_by_path_and_size")
        .expect("record should exist");
    assert_eq!(loaded.id, rec.id);
}

#[test]
fn find_image_by_path_and_size_rejects_size_mismatch() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/img3.cr3");
    block_on(tdb.db.create_image_record(Some(path), 999)).expect("create_image_record");

    let loaded = block_on(tdb.db.find_image_by_path_and_size(path, 1000))
        .expect("find_image_by_path_and_size");
    assert!(loaded.is_none(), "size mismatch should yield None");
}

#[test]
fn find_missing_image_by_uuid_returns_none() {
    let tdb = TestDb::new();
    let loaded = block_on(tdb.db.find_image_by_uuid(uuid::Uuid::new_v4())).expect("find");
    assert!(loaded.is_none());
}

#[test]
fn update_adjustments_roundtrip() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/img4.cr3");
    let rec = block_on(tdb.db.create_image_record(Some(path), 1)).expect("create_image_record");

    let adj = darkslide_core::types::Adjustments {
        rotation: 90,
        lut_intensity: 50,
        ..Default::default()
    };
    block_on(tdb.db.update_adjustments(rec.id, &adj)).expect("update_adjustments");

    let loaded = block_on(tdb.db.find_image_by_uuid(rec.id))
        .expect("find")
        .expect("record should exist");
    assert_eq!(loaded.adjustments.rotation, 90);
    assert_eq!(loaded.adjustments.lut_intensity, 50);
}

#[test]
fn update_adjustments_missing_uuid_errors() {
    let tdb = TestDb::new();
    let res = block_on(
        tdb.db
            .update_adjustments(uuid::Uuid::new_v4(), &Adjustments::default()),
    );
    assert!(res.is_err(), "updating nonexistent uuid should error");
}

#[test]
fn open_rejects_missing_parent_dir() {
    let bad = PathBuf::from("/nonexistent/dir/that/cannot/exist/db.sqlite");
    match Db::open(bad) {
        Ok(_) => panic!("should fail to open"),
        Err(e) => assert!(!e.is_empty()),
    }
}

#[test]
fn update_image_path_roundtrip() {
    let tdb = TestDb::new();
    let old_path = std::path::Path::new("/tmp/old.cr3");
    let new_path = std::path::Path::new("/tmp/new.cr3");
    let rec =
        block_on(tdb.db.create_image_record(Some(old_path), 100)).expect("create_image_record");

    block_on(tdb.db.update_image_path(rec.id, new_path)).expect("update_image_path");

    let loaded = block_on(tdb.db.find_image_by_uuid(rec.id))
        .expect("find")
        .expect("record should exist");
    assert_eq!(loaded.current_path.as_deref(), Some(new_path));
    assert_eq!(loaded.file_size, 100);
}

#[test]
fn update_image_path_missing_uuid_errors() {
    let tdb = TestDb::new();
    let res = block_on(
        tdb.db
            .update_image_path(uuid::Uuid::new_v4(), std::path::Path::new("/tmp/x.cr3")),
    );
    assert!(
        res.is_err(),
        "updating path for nonexistent uuid should error"
    );
}

#[test]
fn update_image_uuid_roundtrip() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/img.cr3");
    let rec = block_on(tdb.db.create_image_record(Some(path), 200)).expect("create_image_record");
    let old_id = rec.id;
    let new_id = uuid::Uuid::new_v4();

    block_on(tdb.db.update_image_uuid(old_id, new_id)).expect("update_image_uuid");

    let old_lookup = block_on(tdb.db.find_image_by_uuid(old_id)).expect("find old");
    assert!(old_lookup.is_none(), "old UUID should no longer exist");

    let loaded = block_on(tdb.db.find_image_by_uuid(new_id))
        .expect("find new")
        .expect("record should exist at new UUID");
    assert_eq!(loaded.id, new_id);
    assert_eq!(loaded.file_size, 200);
    assert_eq!(loaded.current_path.as_deref(), Some(path));
}

#[test]
fn update_image_uuid_missing_old_errors() {
    let tdb = TestDb::new();
    let res = block_on(
        tdb.db
            .update_image_uuid(uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
    );
    assert!(
        res.is_err(),
        "updating uuid for nonexistent record should error"
    );
}

#[test]
fn fork_image_record_creates_independent_copy() {
    let tdb = TestDb::new();
    let old_path = std::path::Path::new("/tmp/original.cr3");
    let new_path = std::path::Path::new("/tmp/duplicate.cr3");
    let rec =
        block_on(tdb.db.create_image_record(Some(old_path), 300)).expect("create_image_record");

    let adj = darkslide_core::types::Adjustments {
        rotation: 180,
        light: darkslide_core::types::Light {
            exposure: 0.5,
            ..Default::default()
        },
        ..Default::default()
    };
    block_on(tdb.db.update_adjustments(rec.id, &adj)).expect("update_adjustments");

    let new_id = uuid::Uuid::new_v4();
    let forked = block_on(tdb.db.fork_image_record(rec.id, new_id, new_path, 400))
        .expect("fork_image_record");

    assert_eq!(forked.id, new_id);
    assert_eq!(forked.current_path.as_deref(), Some(new_path));
    assert_eq!(forked.file_size, 400);
    assert_eq!(forked.adjustments.rotation, 180);
    assert_eq!(forked.adjustments.light.exposure, 0.5);

    let original = block_on(tdb.db.find_image_by_uuid(rec.id))
        .expect("find original")
        .expect("original should still exist");
    assert_eq!(original.current_path.as_deref(), Some(old_path));
    assert_eq!(original.file_size, 300);
    assert_eq!(original.adjustments.rotation, 180);
    assert_eq!(original.adjustments.light.exposure, 0.5);
}

#[test]
fn fork_image_record_missing_source_errors() {
    let tdb = TestDb::new();
    let res = block_on(tdb.db.fork_image_record(
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        std::path::Path::new("/tmp/x.cr3"),
        0,
    ));
    assert!(res.is_err(), "forking from nonexistent source should error");
}

static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn resolve_db_path_env_precedence() {
    let _lock = ENV_MUTEX.lock().unwrap();
    let dir = TempDir::new().expect("tempdir");
    let app_dir = dir.path();

    unsafe {
        std::env::remove_var("DARKSLIDE_DB_PATH");
        std::env::remove_var("DARKSLIDE_DB_EPHEMERAL");
        std::env::remove_var("DARKSLIDE_ENV");
    }

    let (path_dev, ephem_dev) = resolve_db_path(app_dir, false);
    assert!(!ephem_dev);
    assert_eq!(path_dev, app_dir.join("darkslide_dev.sqlite"));

    unsafe {
        std::env::set_var("DARKSLIDE_ENV", "release");
    }
    let (path_rel, ephem_rel) = resolve_db_path(app_dir, false);
    assert!(!ephem_rel);
    assert_eq!(path_rel, app_dir.join("darkslide_release.sqlite"));

    unsafe {
        std::env::set_var("DARKSLIDE_ENV", "dev");
    }
    let (path_dev2, ephem_dev2) = resolve_db_path(app_dir, false);
    assert!(!ephem_dev2);
    assert_eq!(path_dev2, app_dir.join("darkslide_dev.sqlite"));

    unsafe {
        std::env::remove_var("DARKSLIDE_ENV");
    }

    let (path_scen, ephem_scen) = resolve_db_path(app_dir, true);
    assert!(ephem_scen);
    assert!(path_scen.to_string_lossy().contains("darkslide_profile_"));

    let custom_path = dir.path().join("custom.sqlite");
    unsafe {
        std::env::set_var("DARKSLIDE_DB_PATH", custom_path.to_str().unwrap());
    }
    let (path_custom, ephem_custom) = resolve_db_path(app_dir, false);
    assert_eq!(path_custom, custom_path);
    assert!(!ephem_custom);

    let (path_custom_scen, ephem_custom_scen) = resolve_db_path(app_dir, true);
    assert_eq!(path_custom_scen, custom_path);
    assert!(ephem_custom_scen);

    unsafe {
        std::env::set_var("DARKSLIDE_DB_EPHEMERAL", "1");
    }
    let (_, ephem_custom_flag) = resolve_db_path(app_dir, false);
    assert!(ephem_custom_flag);

    unsafe {
        std::env::remove_var("DARKSLIDE_DB_PATH");
        std::env::remove_var("DARKSLIDE_DB_EPHEMERAL");
        std::env::remove_var("DARKSLIDE_ENV");
    }
}

#[test]
fn cleanup_if_ephemeral_removes_files() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("ephemeral.sqlite");
    let db = Db::open_with_options(path.clone(), true).expect("open ephemeral");
    assert!(path.exists());
    assert!(db.is_ephemeral());

    let wal = dir.path().join("ephemeral.sqlite-wal");
    let shm = dir.path().join("ephemeral.sqlite-shm");
    std::fs::write(&wal, b"wal data").unwrap();
    std::fs::write(&shm, b"shm data").unwrap();
    assert!(wal.exists());
    assert!(shm.exists());

    db.cleanup_if_ephemeral().expect("cleanup");
    assert!(!path.exists());
    assert!(!wal.exists());
    assert!(!shm.exists());

    let persistent_path = dir.path().join("persistent.sqlite");
    let persistent_db = Db::open_with_options(persistent_path.clone(), false).expect("open persistent");
    assert!(persistent_path.exists());
    assert!(!persistent_db.is_ephemeral());

    persistent_db.cleanup_if_ephemeral().expect("cleanup no-op");
    assert!(persistent_path.exists());
}

#[test]
fn clear_all_image_records_removes_all_records() {
    let tdb = TestDb::new();
    let path = std::path::Path::new("/tmp/test.jpg");
    let rec1 = block_on(tdb.db.create_image_record(Some(path), 100)).expect("create rec1");
    let rec2 = block_on(tdb.db.create_image_record(Some(path), 200)).expect("create rec2");

    assert!(block_on(tdb.db.find_image_by_uuid(rec1.id)).unwrap().is_some());
    assert!(block_on(tdb.db.find_image_by_uuid(rec2.id)).unwrap().is_some());

    block_on(tdb.db.clear_all_image_records()).expect("clear");

    assert!(block_on(tdb.db.find_image_by_uuid(rec1.id)).unwrap().is_none());
    assert!(block_on(tdb.db.find_image_by_uuid(rec2.id)).unwrap().is_none());

    let new_uid = uuid::Uuid::new_v4();
    block_on(tdb.db.insert_image_record_with_uuid(new_uid, Some(path), 300)).expect("insert with uuid");
    let reloaded = block_on(tdb.db.find_image_by_uuid(new_uid)).unwrap().expect("found");
    assert_eq!(reloaded.id, new_uid);
    assert_eq!(reloaded.file_size, 300);
}

const BASE_JSON: &str = r#"{
    "light": {"exposure":0,"contrast":0,"highlights":0,"shadows":0,"whites":0,"blacks":0,"brightness":0},
    "color": {"temperature":0,"tint":0},
    "hsl": {"hue":0,"saturation":0,"vibrance":0},
    "detail": {"black_point":0,"texture":0,"clarity":0,"sharpen":{"amount":0,"radius":0},"grain":{"amount":0,"size":0,"roughness":0}},
    "%CURVES%":"CURVE_VALUE",
    "rotation":0,
    "lut_id":null,
    "lut_intensity":0
}"#;

#[test]
fn parse_adjustments_migrates_legacy_curve_into_curves_rgb() {
    let json = BASE_JSON
        .replace("\"%CURVES%\":\"CURVE_VALUE\"", r#""curve":[{"x":0.0,"y":0.0},{"x":128.0,"y":60.0},{"x":255.0,"y":255.0}]"#);
    let adj = darkslide_lib::db::parse_adjustments(&json).expect("parse legacy");

    assert_eq!(adj.curves.rgb.len(), 3);
    assert_eq!(adj.curves.rgb[1].y, 60.0);
    // Per-channel curves default to the identity (two endpoints).
    assert_eq!(adj.curves.red.len(), 2);
    assert_eq!(adj.curves.red[0].x, 0.0);
}

#[test]
fn parse_adjustments_prefers_new_curves_over_legacy_curve() {
    let json = BASE_JSON.replace(
        "\"%CURVES%\":\"CURVE_VALUE\"",
        r#""curves":{"rgb":[{"x":0.0,"y":0.0},{"x":255.0,"y":255.0}],"red":[],"green":[],"blue":[]},"curve":[{"x":0.0,"y":0.0}]"#,
    );
    let adj = darkslide_lib::db::parse_adjustments(&json).expect("parse new");

    assert_eq!(adj.curves.rgb.len(), 2);
}

// Sessions

fn session_paths(n: usize) -> Vec<String> {
    (0..n)
        .map(|i| format!("/tmp/session_img_{}.cr3", i))
        .collect()
}

/// Millisecond gap so microsecond-precision timestamps differ between writes.
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(3));
}

#[test]
fn session_crud_roundtrip() {
    let tdb = TestDb::new();
    let paths = session_paths(3);

    let id = block_on(tdb.db.create_session("iceland · Sep 16".into(), paths.clone()))
        .expect("create_session");
    assert!(id > 0);

    let listed = block_on(tdb.db.list_sessions()).expect("list_sessions");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].name, "iceland · Sep 16");
    assert_eq!(listed[0].image_count, 3);

    assert_eq!(
        block_on(tdb.db.get_session_paths(id)).expect("get_session_paths"),
        paths
    );

    block_on(tdb.db.rename_session(id, "renamed".into())).expect("rename_session");
    let listed = block_on(tdb.db.list_sessions()).expect("list_sessions");
    assert_eq!(listed[0].name, "renamed");

    block_on(tdb.db.delete_session(id)).expect("delete_session");
    assert!(block_on(tdb.db.list_sessions()).expect("list_sessions").is_empty());
    assert!(
        block_on(tdb.db.get_session_paths(id))
            .expect("get_session_paths")
            .is_empty()
    );
}

#[test]
fn list_sessions_is_mru_ordered() {
    let tdb = TestDb::new();
    let a = block_on(tdb.db.create_session("a".into(), session_paths(1))).unwrap();
    tick();
    let b = block_on(tdb.db.create_session("b".into(), session_paths(1))).unwrap();

    let listed = block_on(tdb.db.list_sessions()).expect("list_sessions");
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), vec![b, a]);

    tick();
    block_on(tdb.db.get_session_paths(a)).expect("touch a");

    let listed = block_on(tdb.db.list_sessions()).expect("list_sessions");
    assert_eq!(
        listed.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![a, b],
        "attaching a session should move it to the top (MRU)"
    );
}

#[test]
fn rename_session_bumps_updated_at() {
    let tdb = TestDb::new();
    let id = block_on(tdb.db.create_session("a".into(), session_paths(1))).unwrap();
    let before = block_on(tdb.db.list_sessions()).unwrap()[0].updated_at.clone();

    tick();
    block_on(tdb.db.rename_session(id, "b".into())).unwrap();

    let after = block_on(tdb.db.list_sessions()).unwrap()[0].updated_at.clone();
    assert!(after > before, "rename should bump updated_at: {before} -> {after}");
}

#[test]
fn rename_missing_session_errors() {
    let tdb = TestDb::new();
    let res = block_on(tdb.db.rename_session(999, "x".into()));
    assert!(res.is_err(), "renaming a missing session should error");
}

#[test]
fn remove_paths_partial_keeps_remaining_and_bumps() {
    let tdb = TestDb::new();
    let paths = session_paths(3);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();
    let before = block_on(tdb.db.list_sessions()).unwrap()[0].updated_at.clone();

    tick();
    block_on(tdb.db.remove_paths_from_session(id, vec![paths[1].clone()])).expect("remove");

    let after = block_on(tdb.db.list_sessions()).unwrap()[0].updated_at.clone();
    assert!(after > before, "removal should bump updated_at");

    let remaining = block_on(tdb.db.get_session_paths(id)).expect("paths");
    assert_eq!(remaining, vec![paths[0].clone(), paths[2].clone()]);
}

#[test]
fn remove_last_path_deletes_session_row() {
    let tdb = TestDb::new();
    let paths = session_paths(1);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();

    block_on(tdb.db.remove_paths_from_session(id, paths)).expect("remove all");

    assert!(
        block_on(tdb.db.list_sessions()).expect("list").is_empty(),
        "emptied session row should be deleted"
    );
}

#[test]
fn remove_unknown_paths_is_noop() {
    let tdb = TestDb::new();
    let paths = session_paths(2);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();
    let before = block_on(tdb.db.list_sessions()).unwrap()[0].updated_at.clone();

    tick();
    block_on(tdb.db.remove_paths_from_session(id, vec!["/tmp/nope.cr3".into()])).expect("remove");

    let listed = block_on(tdb.db.list_sessions()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].updated_at, before, "no-op removal should not bump");
    assert_eq!(
        block_on(tdb.db.get_session_paths(id)).expect("paths"),
        paths
    );
}

#[test]
fn remove_paths_from_unknown_session_is_noop() {
    let tdb = TestDb::new();
    let res = block_on(tdb.db.remove_paths_from_session(999, vec!["/tmp/a.cr3".into()]));
    assert!(res.is_ok(), "unknown session removal should be a no-op");
}

#[test]
fn delete_unknown_session_is_noop() {
    let tdb = TestDb::new();
    assert!(block_on(tdb.db.delete_session(999)).is_ok());
}

#[test]
fn validate_schema_rejects_db_missing_session_table() {
    let tdb = TestDb::new();
    {
        let conn = Connection::open(tdb.db.path()).expect("second connection");
        conn.execute_batch("DROP TABLE session;").expect("drop session");
    }
    match validate_schema(&Connection::open(tdb.db.path()).expect("reopen")) {
        Ok(_) => panic!("missing session table should be detected"),
        Err(e) => {
            assert!(e.contains("schema drift"), "unexpected message: {}", e);
            assert!(e.contains("session"), "should name the session table: {}", e);
        }
    }
}

// Session command helpers (free functions backing the Tauri commands)

#[test]
fn auto_session_name_uses_parent_folder_and_date() {
    let name = auto_session_name("/photos/iceland/IMG_0001.cr3");
    assert!(
        name.starts_with("iceland · "),
        "expected parent folder prefix, got {name:?}"
    );
    // A trailing " <day>" number is appended after the month.
    let tail = name.trim_start_matches("iceland · ");
    assert!(!tail.is_empty());
}

#[test]
fn auto_session_name_falls_back_without_parent() {
    assert!(auto_session_name("IMG_0001.cr3").starts_with("session · "));
}

#[test]
fn create_session_internal_creates_named_session() {
    let tdb = TestDb::new();
    let paths = vec!["/photos/iceland/IMG_0001.cr3".to_string()];

    let res = block_on(create_session_internal(paths.clone(), false, &tdb.db))
        .expect("create")
        .expect("some res");

    let listed = block_on(tdb.db.list_sessions()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, res.id);
    assert_eq!(listed[0].image_count, 1);
    assert!(listed[0].name.starts_with("iceland · "));
    assert_eq!(res.name, listed[0].name);
    assert_eq!(res.is_existing, false);
    assert_eq!(block_on(tdb.db.get_session_paths(res.id)).unwrap(), paths);
}

#[test]
fn create_session_internal_deduplicates_existing_session() {
    let tdb = TestDb::new();
    let paths = vec![
        "/photos/norway/IMG_0001.cr3".to_string(),
        "/photos/norway/IMG_0002.cr3".to_string(),
    ];

    let first = block_on(create_session_internal(paths.clone(), false, &tdb.db))
        .expect("first create")
        .expect("some res");
    assert!(!first.is_existing);

    block_on(tdb.db.rename_session(first.id, "Custom Trip Name".to_string())).unwrap();

    let scrambled = vec![paths[1].clone(), paths[0].clone()];
    let second = block_on(create_session_internal(scrambled, false, &tdb.db))
        .expect("second create")
        .expect("some res");
    assert!(second.is_existing);
    assert_eq!(second.id, first.id);
    assert_eq!(second.name, "Custom Trip Name");

    let listed = block_on(tdb.db.list_sessions()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, first.id);
    assert_eq!(listed[0].name, "Custom Trip Name");
}

#[test]
fn create_session_internal_skips_scenario_mode() {
    let tdb = TestDb::new();
    let res = block_on(create_session_internal(
        vec!["/photos/a.cr3".to_string()],
        true,
        &tdb.db,
    ));
    assert_eq!(res.unwrap(), None, "scenario mode must not create sessions");
    assert!(block_on(tdb.db.list_sessions()).unwrap().is_empty());
}

#[test]
fn create_session_internal_skips_empty_paths() {
    let tdb = TestDb::new();
    let res = block_on(create_session_internal(vec![], false, &tdb.db));
    assert_eq!(res.unwrap(), None);
    assert!(block_on(tdb.db.list_sessions()).unwrap().is_empty());
}

#[test]
fn rename_session_internal_rejects_blank_and_keeps_old_name() {
    let tdb = TestDb::new();
    let id = block_on(tdb.db.create_session("orig".into(), session_paths(1))).unwrap();

    for blank in ["", "   ", "\t\n"] {
        let res = block_on(rename_session_internal(id, blank.to_string(), &tdb.db));
        assert!(res.is_err(), "blank name {blank:?} should be rejected");
    }
    assert_eq!(block_on(tdb.db.list_sessions()).unwrap()[0].name, "orig");
}

#[test]
fn rename_session_internal_trims_valid_name() {
    let tdb = TestDb::new();
    let id = block_on(tdb.db.create_session("orig".into(), session_paths(1))).unwrap();

    block_on(rename_session_internal(id, "  trip  ".into(), &tdb.db)).expect("rename");
    assert_eq!(block_on(tdb.db.list_sessions()).unwrap()[0].name, "trip");
}

fn base_images(entries: &[(&str, &str)]) -> Mutex<HashMap<String, PathBuf>> {
    Mutex::new(
        entries
            .iter()
            .map(|(id, path)| (id.to_string(), PathBuf::from(path)))
            .collect(),
    )
}

#[test]
fn remove_images_from_session_updates_membership_before_unload() {
    let tdb = TestDb::new();
    let paths = session_paths(2);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();
    let base = base_images(&[("id1", &paths[0]), ("id2", &paths[1])]);

    block_on(remove_images_from_session(
        &["id1".to_string()],
        Some(id),
        &base,
        &tdb.db,
    ))
    .expect("remove membership");

    assert_eq!(
        block_on(tdb.db.get_session_paths(id)).unwrap(),
        vec![paths[1].clone()],
        "membership should be updated from base_images paths"
    );
}

#[test]
fn remove_images_from_session_without_session_is_noop() {
    let tdb = TestDb::new();
    let paths = session_paths(1);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();
    let base = base_images(&[("id1", &paths[0])]);

    block_on(remove_images_from_session(&["id1".to_string()], None, &base, &tdb.db))
        .expect("noop");

    assert_eq!(block_on(tdb.db.get_session_paths(id)).unwrap(), paths);
}

#[test]
fn remove_images_from_session_ignores_ids_not_in_base_images() {
    let tdb = TestDb::new();
    let paths = session_paths(1);
    let id = block_on(tdb.db.create_session("s".into(), paths.clone())).unwrap();
    let base = base_images(&[("id1", &paths[0])]);

    block_on(remove_images_from_session(
        &["missing".to_string()],
        Some(id),
        &base,
        &tdb.db,
    ))
    .expect("noop");

    assert_eq!(block_on(tdb.db.get_session_paths(id)).unwrap(), paths);
}

#[test]
fn find_matching_session_matches_exact_and_scrambled_paths() {
    let tdb = TestDb::new();
    let paths = vec![
        "/path/to/a.jpg".to_string(),
        "/path/to/b.jpg".to_string(),
        "/path/to/c.jpg".to_string(),
    ];
    let id = block_on(tdb.db.create_session("trip".into(), paths.clone())).unwrap();

    // Exact order
    let found = block_on(tdb.db.find_matching_session(paths.clone()))
        .unwrap()
        .expect("should find session");
    assert_eq!(found.id, id);
    assert_eq!(found.name, "trip");
    assert_eq!(found.image_count, 3);

    // Scrambled order
    let scrambled = vec![
        "/path/to/c.jpg".to_string(),
        "/path/to/a.jpg".to_string(),
        "/path/to/b.jpg".to_string(),
    ];
    let found_scrambled = block_on(tdb.db.find_matching_session(scrambled))
        .unwrap()
        .expect("should match scrambled paths");
    assert_eq!(found_scrambled.id, id);
}

#[test]
fn find_matching_session_rejects_subsets_and_supersets() {
    let tdb = TestDb::new();
    let paths = vec![
        "/path/to/a.jpg".to_string(),
        "/path/to/b.jpg".to_string(),
    ];
    block_on(tdb.db.create_session("two".into(), paths.clone())).unwrap();

    // Subset
    let subset = vec!["/path/to/a.jpg".to_string()];
    assert!(block_on(tdb.db.find_matching_session(subset)).unwrap().is_none());

    // Superset
    let superset = vec![
        "/path/to/a.jpg".to_string(),
        "/path/to/b.jpg".to_string(),
        "/path/to/extra.jpg".to_string(),
    ];
    assert!(block_on(tdb.db.find_matching_session(superset)).unwrap().is_none());

    // Empty
    assert!(block_on(tdb.db.find_matching_session(vec![])).unwrap().is_none());
}

#[test]
fn find_matching_session_selects_most_recently_updated() {
    let tdb = TestDb::new();
    let paths = vec!["/path/to/x.jpg".to_string(), "/path/to/y.jpg".to_string()];

    let id1 = block_on(tdb.db.create_session("older".into(), paths.clone())).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(15));
    let id2 = block_on(tdb.db.create_session("newer".into(), paths.clone())).unwrap();

    // id2 was created later, so updated_at is newer
    let found = block_on(tdb.db.find_matching_session(paths.clone()))
        .unwrap()
        .expect("should find matching session");
    assert_eq!(found.id, id2);
    assert_eq!(found.name, "newer");

    // Touch id1 so it becomes newer
    std::thread::sleep(std::time::Duration::from_millis(15));
    block_on(tdb.db.touch_session(id1)).unwrap();

    let found_after_touch = block_on(tdb.db.find_matching_session(paths))
        .unwrap()
        .expect("should find touched session");
    assert_eq!(found_after_touch.id, id1);
    assert_eq!(found_after_touch.name, "older");
}


