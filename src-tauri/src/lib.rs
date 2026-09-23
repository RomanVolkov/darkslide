use darkslide_core::types::Adjustments;
use darkslide_core::lut;
use chrono::Datelike;

use log::LevelFilter;
use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;
use std::{collections::HashMap, sync::Arc, sync::Mutex};

use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use tokio::task::JoinSet;

use log::debug;


pub mod cli;
pub mod db;
pub mod image_resolver;
pub mod io;
pub mod render;
pub mod types;
pub mod utils;

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn load_images_batch(
    app: tauri::AppHandle,
    files: Vec<String>,
    state: tauri::State<'_, types::AppState>,
) -> Result<tauri::ipc::Response, String> {
    let total = files.len();
    log::info!("load_images_batch: total={}", total);

    let mut set = JoinSet::new();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(10));
    let repo = image_resolver::ImageResolver::new(state.db_instance.clone());

    // Submit every file to the blocking thread pool immediately — they all
    // start decoding in parallel without waiting for each other.
    for f in files {
        let repo_copy = repo.clone();
        let semaphore_clone = semaphore.clone();
        set.spawn(async move {
            let _permit = semaphore_clone.acquire().await.unwrap();

            let path: PathBuf = std::path::PathBuf::from(f.clone());
            let metadata = match fs::metadata(path.as_path()) {
                Ok(m) => m,
                Err(e) => {
                    log::error!("skipping {} — metadata failed: {}", f, e);
                    return Ok(None);
                }
            };
            let file_size = metadata.len();

            let (image_uuid, adjustments) =
                repo_copy.resolve(path.as_path(), file_size).await?;
            let image_id = image_uuid.to_string();

            Ok(Some((image_id, path, adjustments)))
        });
    }

    let mut decoded: Vec<(String, std::path::PathBuf, Adjustments)> = Vec::with_capacity(total);

    // Await each handle in turn. Because all tasks were submitted above before
    // we started waiting, they're already running in parallel on the thread
    // pool. We emit a progress event from this async context (sequential, no
    // lock contention) as each one completes.
    while let Some(join_result) = set.join_next().await {
        match join_result.map_err(|e| e.to_string())? {
            Ok(Some(item)) => decoded.push(item),
            Ok(None) => { /* decode failure — already logged inside task */ }
            Err(e) => return Err(e),
        }
        let _ = app.emit(
            "load-progress",
            types::LoadProgress {
                done: decoded.len(),
                total,
            },
        );
    }

    decoded.sort_by(|a, b| {
        let name_a = a.1.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let name_b = b.1.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        utils::natural_cmp(name_a, name_b)
    });

    // Pack the binary response before moving images into the state cache.
    let packed = utils::pack_images(&decoded);

    // Lock once for the whole batch insert.
    let mut bases = state.base_images.lock().unwrap();
    for (id, path, _) in decoded {
        bases.insert(id.clone(), path);
    }

    Ok(tauri::ipc::Response::new(packed))
}

/// Desktop preview render
/// Encodes RGBA buffer + histogram into tauri::ipc::Response
#[tauri::command]
async fn render_preview(
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    state: tauri::State<'_, types::AppState>,
) -> Result<tauri::ipc::Response, std::string::String> {
    log::info!("render_preview: id={}", id);
    let uid = uuid::Uuid::parse_str(id.as_str()).map_err(|e| e.to_string())?;
    let payload = render::render_preview(uid, &adjustments, &state).await?;
    Ok(tauri::ipc::Response::new(payload))
}

/// Desktop thumbnail render
/// Encodes RGBA buffer into tauri::ipc::Response: [width u32 LE][height u32 LE][RGBA bytes...]
#[tauri::command]
async fn render_thumbnail(
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    state: tauri::State<'_, types::AppState>,
) -> Result<tauri::ipc::Response, std::string::String> {
    log::info!("render_thumbnail: id={}", id);
    let uid = uuid::Uuid::parse_str(id.as_str()).map_err(|e| e.to_string())?;
    let payload = render::render_thumbnail(uid, &adjustments, &state).await?;
    Ok(tauri::ipc::Response::new(payload))
}

/// Batch thumbnail render
/// Returns a single binary IPC response:
///   [count: u32 LE]
///   for each thumbnail: [width u32 LE][height u32 LE][RGBA bytes...]
#[tauri::command]
async fn render_thumbnails_batch(
    files: Vec<ThumbnailBatchItem>,
    state: tauri::State<'_, types::AppState>,
) -> Result<tauri::ipc::Response, std::string::String> {
    log::info!("render_thumbnails_batch: count={}", files.len());

    let items: Vec<_> = files
        .into_iter()
        .map(|item| {
            let uid = uuid::Uuid::parse_str(item.id.as_str()).map_err(|e| e.to_string())?;
            Ok(render::ThumbnailRequest {
                id: uid,
                adjustments: item.adjustments,
                quality: item.quality,
                max_dim: item.max_dim,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let thumbnails = render::render_thumbnails_tiered(&items, &state).await?;
    let payload = render::pack_thumbnails_batch(thumbnails);
    Ok(tauri::ipc::Response::new(payload))
}

/// Estimate auto white balance (gray-world + white-patch) from the ungraded
/// base image. Returns relative temperature/tint offsets for the sliders.
#[tauri::command]
async fn auto_white_balance(
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    state: tauri::State<'_, types::AppState>,
) -> Result<darkslide_core::color::auto_wb::AutoWb, String> {
    let uid = uuid::Uuid::parse_str(id.as_str()).map_err(|e| e.to_string())?;
    let base_images = state.base_images.clone();
    let base_images_cache = state.base_images_cache.clone();
    let img = tauri::async_runtime::spawn_blocking(move || {
        render::load_or_decode_image(&uid, base_images, base_images_cache, Some(256))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(darkslide_core::color::auto_wb::auto_white_balance(
        &img,
        &adjustments.as_shot_wb,
    ))
}

fn default_thumb_max_dim() -> u32 {
    darkslide_core::THUMBNAIL_MAX_DIM
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailBatchItem {
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    #[serde(default)]
    quality: Option<String>,
    #[serde(alias = "max_dim", default = "default_thumb_max_dim")]
    max_dim: u32,
}

pub static EXPORT_SEMAPHORE: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| {
        let limit = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(4)
            .max(1);
        Arc::new(tokio::sync::Semaphore::new(limit))
    });

pub async fn export_image_internal(
    id: &str,
    adjustments: &darkslide_core::types::Adjustments,
    path: &str,
    image_type: &str,
    quality: Option<u8>,
    png_compression: Option<&str>,
    state: &types::AppState,
) -> Result<(), String> {
    let _permit = EXPORT_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    let image_type_enum = darkslide_core::types::ImageType::from_export(
        image_type,
        quality,
        png_compression,
    );

    let uid = uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    let img = render::render_image(uid, adjustments, None, false, state).await?;

    let encoded_image = tokio::task::spawn_blocking(move || {
        darkslide_core::encode(&img, image_type_enum)
    })
    .await
    .map_err(|e| e.to_string())??;

    let data = utils::inject_exif(uid, encoded_image, state).await;

    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    tokio::fs::write(path, data)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Export
#[tauri::command]
async fn export(
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    path: String,
    image_type: String,
    quality: Option<u8>,
    png_compression: Option<String>,
    state: tauri::State<'_, types::AppState>,
) -> Result<(), String> {
    debug!(
        "{}, {}",
        quality.unwrap_or(101),
        png_compression
            .as_deref()
            .unwrap_or("empty png compression")
    );
    export_image_internal(
        &id,
        &adjustments,
        &path,
        &image_type,
        quality,
        png_compression.as_deref(),
        &state,
    )
    .await
}

pub fn unload_images_internal(ids: &[String], state: &types::AppState) {
    let mut bases = state.base_images.lock().unwrap();
    let mut base_cache = state.base_images_cache.lock().unwrap();
    let mut exif = state.exif_cache.lock().unwrap();
    let mut thumbs = state.thumbnails.lock().unwrap();
    for id in ids {
        bases.remove(id);
        base_cache.pop(id);
        exif.pop(id);
    }
    // Thumbnails are keyed `<id>:<quality>:<max_dim>:<adjHash>`, so evict every
    // entry whose leading id segment matches one of the unloaded images.
    let id_set: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let stale_keys: Vec<String> = thumbs
        .iter()
        .filter(|(key, _)| key.split(':').next().is_some_and(|id| id_set.contains(id)))
        .map(|(key, _)| key.clone())
        .collect();
    for key in stale_keys {
        thumbs.pop(&key);
    }
}

/// Resolve image ids to their absolute paths (via `base_images`) and remove
/// those paths from the given session's membership. Must run BEFORE the image
/// caches are dropped, since `base_images` is the only id→path source.
pub async fn remove_images_from_session(
    ids: &[String],
    session_id: Option<i64>,
    base_images: &Mutex<HashMap<String, PathBuf>>,
    db: &db::Db,
) -> Result<(), String> {
    let Some(sid) = session_id else {
        return Ok(());
    };
    let paths: Vec<String> = {
        let bases = base_images.lock().unwrap();
        ids.iter()
            .filter_map(|id| bases.get(id))
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    };
    if paths.is_empty() {
        return Ok(());
    }
    db.remove_paths_from_session(sid, paths).await
}

/// Unloads images from memory (desktop). When a session is active the removed
/// images are first dropped from the session's membership.
#[tauri::command]
async fn unload_images(
    ids: Vec<String>,
    session_id: Option<i64>,
    state: tauri::State<'_, types::AppState>,
) -> Result<(), String> {
    if let Err(e) =
        remove_images_from_session(&ids, session_id, &state.base_images, &state.db_instance).await
    {
        log::error!("unload_images: session membership update failed: {e}");
    }
    unload_images_internal(&ids, &state);
    Ok(())
}

#[tauri::command]
fn set_active_image(
    id: String,
    adjacent_ids: Option<Vec<String>>,
    state: tauri::State<'_, types::AppState>,
) {
    let parsed_id = uuid::Uuid::parse_str(&id).ok();
    {
        let mut active = state.active_image_id.lock().unwrap();
        *active = parsed_id;
    }
    if let Some(adj) = adjacent_ids {
        let uuids: Vec<uuid::Uuid> = adj
            .into_iter()
            .filter_map(|s| uuid::Uuid::parse_str(&s).ok())
            .collect();
        if !uuids.is_empty() {
            render::service::prefetch_previews(uuids, &state);
        }
    }
}

#[tauri::command]
fn prefetch_previews(
    ids: Vec<String>,
    state: tauri::State<'_, types::AppState>,
) {
    let uuids: Vec<uuid::Uuid> = ids
        .into_iter()
        .filter_map(|s| uuid::Uuid::parse_str(&s).ok())
        .collect();
    if !uuids.is_empty() {
        render::service::prefetch_previews(uuids, &state);
    }
}

#[tauri::command]
async fn update_adjustments(
    id: String,
    adjustments: darkslide_core::types::Adjustments,
    state: tauri::State<'_, types::AppState>,
) -> Result<(), String> {
    let uid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.db_instance.update_adjustments(uid, &adjustments).await
}

#[tauri::command]
async fn clear_all_adjustments(
    state: tauri::State<'_, types::AppState>,
) -> Result<(), String> {
    state.db_instance.clear_all_image_records().await?;
    let bases = state.base_images.lock().unwrap().clone();
    for (id_str, path) in bases {
        if let Ok(uid) = uuid::Uuid::parse_str(&id_str) {
            let file_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let _ = state
                .db_instance
                .insert_image_record_with_uuid(uid, Some(&path), file_size)
                .await;
        }
    }
    Ok(())
}

/// take list of pending files if opened with cli
#[tauri::command]
fn get_pending_files(state: tauri::State<'_, io::PendingFiles>) -> Vec<String> {
    let drained = state.files.lock().unwrap().drain(..).collect::<Vec<_>>();
    log::info!("get_pending_files: returning {:?}", drained);
    drained
}

#[cfg(feature = "profiling")]
#[tauri::command]
fn is_scenario_mode(config: tauri::State<'_, io::CliConfig>) -> bool {
    config.scenario
}

#[cfg(feature = "profiling")]
#[tauri::command]
fn save_web_profile(trace_json: String, output_dir: Option<String>) -> Result<String, String> {
    let base_dir = output_dir.unwrap_or_else(|| {
        std::env::var("DARKSLIDE_PROFILE_DIR").unwrap_or_else(|_| "profiles".to_string())
    });
    let dir = std::path::Path::new(&base_dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let filename = if let Ok(ts) = std::env::var("DARKSLIDE_TIMESTAMP") {
        format!("darkslide_web_{ts}.json")
    } else {
        let dur = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        format!("darkslide_web_{}.json", dur.as_secs())
    };

    let file_path = dir.join(filename);
    std::fs::write(&file_path, trace_json).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().into_owned())
}

#[cfg(feature = "profiling")]
#[tauri::command]
fn cleanup_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(feature = "profiling")]
#[tauri::command]
fn exit_app(app: tauri::AppHandle, state: tauri::State<'_, types::AppState>, code: Option<i32>) {
    let _ = state.db_instance.cleanup_if_ephemeral();
    app.exit(code.unwrap_or(0));
}

/// Snapshot the current webview to a PNG file.
///
/// Profiling-only. Renders the web content (including GPU-rendered canvas) to a
/// bitmap via `WKWebView.takeSnapshot`, so marketing screenshots need neither
/// OS screen-recording permission nor a visible window.
#[cfg(feature = "profiling")]
#[tauri::command]
async fn capture_webview(
    window: tauri::WebviewWindow,
    path: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    // Fixed capture size so shots are consistent regardless of window manager.
    let _ = window.set_size(tauri::LogicalSize::new(
        width.unwrap_or(1440.0),
        height.unwrap_or(900.0),
    ));
    std::thread::sleep(std::time::Duration::from_millis(500));

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform_webview| {
            snapshot_webview(platform_webview, path, tx);
        })
        .map_err(|e| e.to_string())?;
    match rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(result) => result,
        Err(e) => Err(format!("snapshot timed out: {e}")),
    }
}

/// Screenshot capture configuration: which shot to set up and where to write it.
#[cfg(feature = "profiling")]
#[derive(serde::Serialize)]
struct ScreenshotConfig {
    shot: String,
    dir: String,
}

/// Runtime screenshot config (from `DARKSLIDE_SHOT` / `DARKSLIDE_SCREENSHOT_DIR`).
/// Returns `None` unless both are set, so normal profiling runs are unaffected.
#[cfg(feature = "profiling")]
#[tauri::command]
fn screenshot_config() -> Option<ScreenshotConfig> {
    let shot = std::env::var("DARKSLIDE_SHOT").ok()?;
    let dir = std::env::var("DARKSLIDE_SCREENSHOT_DIR").ok()?;
    Some(ScreenshotConfig { shot, dir })
}

#[cfg(all(feature = "profiling", target_os = "macos"))]
fn snapshot_webview(
    platform_webview: tauri::webview::PlatformWebview,
    path: String,
    tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::WKWebView;
    use std::ffi::c_void;

    let wk: &WKWebView = unsafe { &*(platform_webview.inner() as *const c_void as *const WKWebView) };

    let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let result = (|| -> Result<(), String> {
            if image.is_null() {
                return Err("snapshot produced no image".to_string());
            }
            let image: &NSImage = unsafe { &*image };
            let tiff = image.TIFFRepresentation().ok_or("no TIFF representation")?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap representation")?;
            let props = NSDictionary::<NSString, AnyObject>::new();
            let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
                .ok_or("PNG encoding failed")?;
            let ns_path = NSString::from_str(&path);
            if !png.writeToFile_atomically(&ns_path, true) {
                return Err("failed to write PNG".to_string());
            }
            Ok(())
        })();
        let _ = tx.send(result);
    });

    unsafe {
        wk.takeSnapshotWithConfiguration_completionHandler(None, &handler);
    }
}

#[cfg(all(feature = "profiling", not(target_os = "macos")))]
fn snapshot_webview(
    _platform_webview: tauri::webview::PlatformWebview,
    _path: String,
    tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = tx.send(Err("capture_webview is only supported on macOS".to_string()));
}

#[tauri::command]
async fn import_lut(
    state: tauri::State<'_, types::AppState>,
    lut_path: String,
) -> Result<(), String> {
    let mut f = File::open(lut_path).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).map_err(|e| e.to_string())?;

    if buf.is_empty() {
        return Err(String::from("empty file"));
    }

    let lut_meta = lut::parse_cube_lut(buf.as_str())?;
    state
        .db_instance
        .store_lut(lut_meta.name, lut_meta.values, lut_meta.size)
        .await?;

    Ok(())
}

#[tauri::command]
async fn delete_lut(state: tauri::State<'_, types::AppState>, id: u32) -> Result<(), String> {
    state.db_instance.delete_lut(id).await
}

/// load_luts returns string for each lut as {id};{name}
#[tauri::command]
async fn load_luts(state: tauri::State<'_, types::AppState>) -> Result<Vec<String>, String> {
    let luts = state.db_instance.load_lut_meta().await?;
    Ok(luts
        .iter()
        .map(|l| format!("{};{}", l.id, l.name))
        .collect())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateSessionResult {
    pub id: i64,
    pub name: String,
    pub is_existing: bool,
}

/// Auto-generate a session name from the first image path:
/// `"{parent dir name} · {Mon D}"`, e.g. `iceland · Sep 16`.
pub fn auto_session_name(first_path: &str) -> String {
    let parent = std::path::Path::new(first_path)
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("session");
    let now = chrono::Local::now();
    format!("{} · {} {}", parent, now.format("%b"), now.day())
}

/// Create a session for a freshly opened image list. Returns `None` in scenario
/// mode (ephemeral DB) or for an empty list.
/// If an existing session matches the exact same image set, it is touched and reused.
pub async fn create_session_internal(
    paths: Vec<String>,
    is_scenario: bool,
    db: &db::Db,
) -> Result<Option<CreateSessionResult>, String> {
    if is_scenario || paths.is_empty() {
        return Ok(None);
    }
    if let Some(matched) = db.find_matching_session(paths.clone()).await? {
        db.touch_session(matched.id).await?;
        return Ok(Some(CreateSessionResult {
            id: matched.id,
            name: matched.name,
            is_existing: true,
        }));
    }
    let name = auto_session_name(&paths[0]);
    let id = db.create_session(name.clone(), paths).await?;
    Ok(Some(CreateSessionResult {
        id,
        name,
        is_existing: false,
    }))
}

/// Rename a session, rejecting empty/whitespace-only names.
pub async fn rename_session_internal(id: i64, name: String, db: &db::Db) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("session name cannot be empty".into());
    }
    db.rename_session(id, trimmed.to_string()).await
}

#[tauri::command]
async fn create_session(
    paths: Vec<String>,
    state: tauri::State<'_, types::AppState>,
) -> Result<Option<CreateSessionResult>, String> {
    create_session_internal(paths, state.db_instance.is_ephemeral(), &state.db_instance).await
}

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, types::AppState>,
) -> Result<Vec<db::SessionSummary>, String> {
    state.db_instance.list_sessions().await
}

#[tauri::command]
async fn get_session_paths(
    id: i64,
    state: tauri::State<'_, types::AppState>,
) -> Result<Vec<String>, String> {
    state.db_instance.get_session_paths(id).await
}

#[tauri::command]
async fn rename_session(
    id: i64,
    name: String,
    state: tauri::State<'_, types::AppState>,
) -> Result<(), String> {
    rename_session_internal(id, name, &state.db_instance).await
}

#[tauri::command]
async fn delete_session(id: i64, state: tauri::State<'_, types::AppState>) -> Result<(), String> {
    state.db_instance.delete_session(id).await
}

// ---------------------------------------------------------------------------
// Run app
// ---------------------------------------------------------------------------

/// main entry for Tauri app assembly
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::new().skip_logger().build())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_focus().unwrap();
            }
            io::Cli::parse_args(&args[1..]).open_files(app, &cwd);
        }))
        .setup(|app| {
            let log_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
            let (_plugin, max_level, logger) = tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Folder {
                        path: log_dir,
                        file_name: Some("darkslide".into()),
                    }),
                ])
                .rotation_strategy(RotationStrategy::KeepAll)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .max_file_size(5 * 1024 * 1024) // 5 MB
                .level(LevelFilter::Debug)
                .split(app.handle())?;
            tauri_plugin_log::attach_logger(max_level, logger)?;

            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let cli = io::Cli::parse_args(&args);
            let files = cli.collect_files(&cwd);
            log::info!("setup: collected files={:?}", files);

            #[cfg(feature = "profiling")]
            let is_scenario = cli.scenario || std::env::var("DARKSLIDE_SCENARIO").is_ok();
            #[cfg(not(feature = "profiling"))]
            let is_scenario = false;

            #[cfg(feature = "profiling")]
            {
                let is_devtools = cli.devtools || std::env::var("DARKSLIDE_DEVTOOLS").is_ok();

                if is_devtools {
                    if let Some(win) = app.get_webview_window("main") {
                        win.open_devtools();
                    }
                }

                app.manage(io::CliConfig {
                    scenario: is_scenario,
                    devtools: is_devtools,
                });
            }

            let handle = app.handle();
            // Build full macOS menu hierarchy
            let app_menu = SubmenuBuilder::new(handle, "Darkslide")
                .item(&PredefinedMenuItem::about(handle, Some("Darkslide"), None)?)
                .separator()
                .item(&PredefinedMenuItem::services(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(handle, None)?)
                .item(&PredefinedMenuItem::hide_others(handle, None)?)
                .item(&PredefinedMenuItem::show_all(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(handle, None)?)
                .build()?;

            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&MenuItemBuilder::with_id("file_open", "Open Images...").accelerator("o").build(handle)?)
                .item(&MenuItemBuilder::with_id("file_open_replace", "Open & Replace Images...").accelerator("Shift+O").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("session_palette", "Sessions...").accelerator("s").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("file_export", "Export...").accelerator("e").build(handle)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .item(&MenuItemBuilder::with_id("edit_undo", "Undo").accelerator("u").build(handle)?)
                .item(&MenuItemBuilder::with_id("edit_redo", "Redo").accelerator("r").build(handle)?)
                .separator()
                .item(&PredefinedMenuItem::cut(handle, None)?)
                .item(&PredefinedMenuItem::copy(handle, None)?)
                .item(&PredefinedMenuItem::paste(handle, None)?)
                .item(&PredefinedMenuItem::select_all(handle, None)?)
                .separator()
                .item(&MenuItemBuilder::with_id("adjustments_yank", "Copy Adjustments").accelerator("y").build(handle)?)
                .item(&MenuItemBuilder::with_id("adjustments_paste", "Paste Adjustments").accelerator("p").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("adjustments_reset", "Reset All Adjustments").accelerator("Shift+X").build(handle)?)
                .item(&MenuItemBuilder::with_id("filmstrip_delete", "Remove from Session").accelerator("Backspace").build(handle)?)
                .separator()
                .item(&MenuItemBuilder::with_id("edit_erase_db", "Erase Database Adjustments...").accelerator("CmdOrCtrl+Alt+Shift+X").build(handle)?)
                .build()?;

            let image_menu = SubmenuBuilder::new(handle, "Image")
                .item(&MenuItemBuilder::with_id("image_rotate", "Rotate 90° CW").accelerator("Shift+R").build(handle)?)
                .item(&MenuItemBuilder::with_id("image_auto_wb", "Auto White Balance").accelerator("w").build(handle)?)
                .build()?;

            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&MenuItemBuilder::with_id("view_grid", "Toggle Grid View").accelerator("f").build(handle)?)
                .item(&MenuItemBuilder::with_id("view_original", "Compare with Original (Hold \\)").build(handle)?)
                .build()?;

            let tools_menu = SubmenuBuilder::new(handle, "Integrations")
                .item(&MenuItemBuilder::with_id("install_cli", "Install CLI Integration").build(handle)?)
                .build()?;

            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&MenuItemBuilder::with_id("help_toggle", "Keyboard Shortcuts").accelerator("Shift+Slash").build(handle)?)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&image_menu)
                .item(&view_menu)
                .item(&tools_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app: &tauri::AppHandle, event| {
                let event_id = event.id().0.as_str();
                if event_id == "install_cli" {
                    match cli::install_cli() {
                        Ok(path) => {
                            app.dialog()
                                .message(format!("CLI installed at {path}\nYou can now use 'darkslide' in your terminal."))
                                .title("Darkslide")
                                .kind(MessageDialogKind::Info)
                                .show(|_| {});
                        }
                        Err(e) if e == "permission_denied" => {
                            app.dialog()
                                .message(
                                    "Could not write to /usr/local/bin — permission denied.\n\n\
                                    Run this in your terminal:\n\n\
                                    sudo sh -c 'echo \"#!/bin/bash\n\
                                    /Applications/Darkslide.app/Contents/MacOS/Darkslide \\\"\\$@\\\"\" \
                                    > /usr/local/bin/darkslide \
                                    && chmod 755 /usr/local/bin/darkslide'"
                                )
                                .title("Installation Failed")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                        Err(e) => {
                            app.dialog()
                                .message(format!("Failed to install CLI: {e}"))
                                .title("Installation Failed")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                    }
                } else {
                    let _ = app.emit("menu-action", event_id);
                }
            });

            app.manage(io::PendingFiles {
                files: Mutex::new(files),
            });

            let base_images = Arc::new(Mutex::new(HashMap::new()));
            let base_images_cache = Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(types::BASE_IMAGES_CACHE_CAPACITY).unwrap(),
            )));
            let thumbnails = Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(types::THUMBNAILS_CACHE_CAPACITY).unwrap(),
            )));
            let lut_cache = Arc::new(Mutex::new(HashMap::new()));
            let exif_cache = Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(types::EXIF_CACHE_CAPACITY).unwrap(),
            )));
            let db_instance = Arc::new(db::Db::new(app, is_scenario)?);
            let gpu = match darkslide_core::GpuState::init() {
                Ok(g) => Arc::new(g),
                Err(err) => {
                    log::error!("GPU initialization failed: {err}");
                    app.dialog()
                        .message(format!(
                            "Darkslide requires a graphics device with Metal, Vulkan, or DirectX 12 support.\n\nError: {err}\n\nPlease ensure your system software and graphics drivers are up to date."
                        ))
                        .title("Hardware Acceleration Required")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            let active_image_id = Arc::new(Mutex::new(None));

            app.manage(types::AppState {
                base_images,
                base_images_cache,
                thumbnails,
                lut_cache,
                exif_cache,
                db_instance,
                gpu,
                active_image_id,
            });

            // Failsafe: ensure window is revealed even if frontend bootstrap errors or hangs
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .invoke_handler({
            #[cfg(feature = "profiling")]
            {
                tauri::generate_handler![
                    load_images_batch,
                    render_preview,
                    render_thumbnail,
                    render_thumbnails_batch,
                    auto_white_balance,
                    export,
                    unload_images,
                    set_active_image,
                    prefetch_previews,
                    update_adjustments,
                    clear_all_adjustments,
                    import_lut,
                    load_luts,
                    delete_lut,
                    create_session,
                    list_sessions,
                    get_session_paths,
                    rename_session,
                    delete_session,
                    get_pending_files,
                    is_scenario_mode,
                    save_web_profile,
                    cleanup_dir,
                    exit_app,
                    capture_webview,
                    screenshot_config,
                ]
            }
            #[cfg(not(feature = "profiling"))]
            {
                tauri::generate_handler![
                    load_images_batch,
                    render_preview,
                    render_thumbnail,
                    render_thumbnails_batch,
                    auto_white_balance,
                    export,
                    unload_images,
                    set_active_image,
                    prefetch_previews,
                    update_adjustments,
                    clear_all_adjustments,
                    import_lut,
                    load_luts,
                    delete_lut,
                    create_session,
                    list_sessions,
                    get_session_paths,
                    rename_session,
                    delete_session,
                    get_pending_files,
                ]
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build the app")
        .run(|app_handler, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handler.try_state::<types::AppState>() {
                    let _ = state.db_instance.cleanup_if_ephemeral();
                }
            }
        })
}
