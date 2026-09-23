//! Automated smoke test for the tmux-style editing-session lifecycle.
//!
//! Deliberately Db-only: building a full `AppState` pulls in `GpuState::init`,
//! which requires a real GPU. The lifecycle here is: resolve images → create a
//! session → edit → remove → "relaunch" (reopen the DB file) → re-attach.

use darkslide_core::types::{Adjustments, ImageType, ProcessedImage};
use darkslide_lib::db::Db;
use darkslide_lib::image_resolver::ImageResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

fn write_jpeg(path: &Path, seed: u8) {
    let img = ProcessedImage {
        width: 32,
        height: 32,
        rgba: vec![seed; 32 * 32 * 4].into(),
    };
    let bytes = darkslide_core::encode(&img, ImageType::JPG(90)).expect("encode jpeg");
    std::fs::write(path, bytes).expect("write jpeg");
}

async fn resolve_many(repo: &ImageResolver, paths: &[PathBuf]) -> Vec<String> {
    let mut ids = Vec::new();
    for path in paths {
        let size = std::fs::metadata(path).expect("metadata").len();
        let (uuid, _adj) = repo.resolve(path.as_path(), size).await.expect("resolve");
        ids.push(uuid.to_string());
    }
    ids
}

#[tokio::test]
async fn session_lifecycle_survives_relaunch() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("sessions.sqlite");

    let mut paths = Vec::new();
    for i in 0..3 {
        let path = dir.path().join(format!("IMG_{i}.jpg"));
        write_jpeg(&path, 40 + i as u8);
        paths.push(path);
    }

    let ids: Vec<String>;
    let session_id: i64;

    // --- First run: resolve images, create session, edit, remove a subset ---
    {
        let db = Arc::new(Db::open(db_path.clone()).expect("open db"));
        let repo = ImageResolver::new(db.clone());

        ids = resolve_many(&repo, &paths).await;

        let path_strings: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        session_id = db
            .create_session("trip · Sep 16".into(), path_strings.clone())
            .await
            .expect("create session");

        // Session row holds every resolved path, in load order.
        assert_eq!(
            db.get_session_paths(session_id).await.unwrap(),
            path_strings
        );

        // Persist adjustments on the first image.
        let adjusted = Adjustments {
            rotation: 90,
            lut_intensity: 42,
            ..Default::default()
        };
        let first_uuid = uuid::Uuid::parse_str(&ids[0]).unwrap();
        db.update_adjustments(first_uuid, &adjusted)
            .await
            .expect("update adjustments");

        // Remove the middle image from membership.
        let before = db.list_sessions().await.unwrap()[0].updated_at.clone();
        std::thread::sleep(Duration::from_millis(3));
        db.remove_paths_from_session(session_id, vec![path_strings[1].clone()])
            .await
            .expect("remove path");
        let after = db.list_sessions().await.unwrap()[0].updated_at.clone();
        assert!(after > before, "removal should bump updated_at");

        let remaining = db.get_session_paths(session_id).await.unwrap();
        assert_eq!(
            remaining,
            vec![path_strings[0].clone(), path_strings[2].clone()]
        );
    }

    // --- Relaunch: reopen the same DB file as a fresh process would ---
    {
        let db = Arc::new(Db::open(db_path.clone()).expect("reopen db"));

        let listed = db.list_sessions().await.expect("list sessions");
        assert_eq!(listed.len(), 1, "session should survive relaunch");
        assert_eq!(listed[0].id, session_id);
        assert_eq!(listed[0].image_count, 2);
        assert_eq!(listed[0].name, "trip · Sep 16");

        let restored = db.get_session_paths(session_id).await.unwrap();
        assert_eq!(
            restored,
            vec![
                paths[0].to_string_lossy().into_owned(),
                paths[2].to_string_lossy().into_owned(),
            ],
            "removed image must stay absent after relaunch"
        );

        // Re-resolving the restored paths brings the edits back for free.
        let repo = ImageResolver::new(db.clone());
        let restored_ids = resolve_many(&repo, &[paths[0].clone(), paths[2].clone()]).await;

        assert_eq!(restored_ids[0], ids[0], "identity resolved by path+size");
        let size = std::fs::metadata(&paths[0]).unwrap().len();
        let (_uuid, adj) = repo.resolve(paths[0].as_path(), size).await.unwrap();
        assert_eq!(adj.rotation, 90, "adjustments restored on re-attach");
        assert_eq!(adj.lut_intensity, 42);
    }
}

#[tokio::test]
async fn removing_all_images_deletes_the_session() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("sessions.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));

    let mut paths = Vec::new();
    for i in 0..2 {
        let path = dir.path().join(format!("IMG_{i}.jpg"));
        write_jpeg(&path, 10 + i as u8);
        paths.push(path.to_string_lossy().into_owned());
    }

    let session_id = db
        .create_session("empty me".into(), paths.clone())
        .await
        .expect("create session");

    db.remove_paths_from_session(session_id, paths)
        .await
        .expect("remove all");

    assert!(
        db.list_sessions().await.expect("list").is_empty(),
        "emptied session row should be gone after relaunch-visible commit"
    );
    assert!(db.get_session_paths(session_id).await.unwrap().is_empty());
}

#[tokio::test]
async fn session_open_duplicate_folder_deduplicates_and_bumps_mru() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("sessions.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));

    let mut paths = Vec::new();
    for i in 0..3 {
        let path = dir.path().join(format!("IMG_{i}.jpg"));
        write_jpeg(&path, 50 + i as u8);
        paths.push(path.to_string_lossy().into_owned());
    }

    // First open creates new session
    let first = darkslide_lib::create_session_internal(paths.clone(), false, &db)
        .await
        .expect("create first")
        .expect("some result");
    assert!(!first.is_existing);
    assert_eq!(db.list_sessions().await.unwrap().len(), 1);

    // User gives the session a custom name
    db.rename_session(first.id, "Vacation 2026".to_string())
        .await
        .expect("rename");

    let initial_ts = db.list_sessions().await.unwrap()[0].updated_at.clone();

    std::thread::sleep(Duration::from_millis(5));

    // Second open with same images in reverse order attaches to existing session
    let mut reversed = paths.clone();
    reversed.reverse();
    let second = darkslide_lib::create_session_internal(reversed, false, &db)
        .await
        .expect("create second")
        .expect("some result");

    assert!(second.is_existing, "must attach to existing session");
    assert_eq!(second.id, first.id);
    assert_eq!(second.name, "Vacation 2026", "preserves custom session name");

    // Still only 1 session in database
    let listed = db.list_sessions().await.unwrap();
    assert_eq!(listed.len(), 1, "no duplicate session rows created");
    assert_eq!(listed[0].id, first.id);
    assert!(
        listed[0].updated_at > initial_ts,
        "updated_at must be bumped on attach so session floats to top of MRU palette"
    );
}
