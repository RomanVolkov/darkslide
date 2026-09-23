use darkslide_core::types::{Adjustments, ImageType, PngCompressionLevel, ProcessedImage};
use darkslide_lib::db::Db;
use darkslide_lib::render::loader::{load_or_decode_image, resize_image};
use darkslide_lib::render::service::{
    pack_thumbnails_batch, render_image, render_preview, render_thumbnail, render_thumbnails,
    render_thumbnails_tiered, resolve_lut, thumbnail_cache_key, thumbnail_cache_key_with_quality,
    ThumbnailRequest,
};
use darkslide_lib::types::AppState;
use lru::LruCache;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

fn test_lru_cache<K: std::hash::Hash + Eq, V>(cap: usize) -> Arc<Mutex<LruCache<K, V>>> {
    Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(cap).unwrap())))
}

fn create_test_app_state(
    db: Arc<Db>,
    base_images: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    base_images_cache: Arc<Mutex<LruCache<String, ProcessedImage>>>,
) -> AppState {
    AppState {
        base_images,
        base_images_cache,
        thumbnails: test_lru_cache(500),
        lut_cache: Arc::new(Mutex::new(HashMap::new())),
        exif_cache: test_lru_cache(darkslide_lib::types::EXIF_CACHE_CAPACITY),
        db_instance: db,
        gpu: Arc::new(darkslide_core::GpuState::init().expect("gpu init")),
        active_image_id: Arc::new(Mutex::new(None)),
    }
}

#[test]
fn test_resize_image() {
    let img = ProcessedImage {
        width: 200,
        height: 100,
        rgba: vec![255; 200 * 100 * 4].into(),
    };
    let resized = resize_image(&img, 50);
    assert_eq!(resized.width, 50);
    assert_eq!(resized.height, 25);
    assert_eq!(resized.rgba.len(), 50 * 25 * 4);

    let small = ProcessedImage {
        width: 10,
        height: 20,
        rgba: vec![128; 10 * 20 * 4].into(),
    };
    let not_resized = resize_image(&small, 50);
    assert_eq!(not_resized.width, 10);
    assert_eq!(not_resized.height, 20);
    assert_eq!(not_resized.rgba.len(), 10 * 20 * 4);
}

#[test]
fn test_load_or_decode_cached() {
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let test_uuid = uuid::Uuid::new_v4();

    let cached_img = ProcessedImage {
        width: 10,
        height: 10,
        rgba: vec![128; 10 * 10 * 4].into(),
    };
    base_images_cache
        .lock()
        .unwrap()
        .put(test_uuid.to_string(), cached_img);

    let loaded = load_or_decode_image(&test_uuid, base_images, base_images_cache, None)
        .expect("should load from cache");
    assert_eq!(loaded.width, 10);
    assert_eq!(loaded.height, 10);
}

#[test]
fn test_load_or_decode_cache_hit_avoids_file_io() {
    // If the image is already cached, base_images can be empty and the call
    // must still succeed (it must not try to read a file).
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let test_uuid = uuid::Uuid::new_v4();

    let cached_img = ProcessedImage {
        width: 10,
        height: 10,
        rgba: vec![128; 10 * 10 * 4].into(),
    };
    base_images_cache
        .lock()
        .unwrap()
        .put(test_uuid.to_string(), cached_img);

    let loaded = load_or_decode_image(&test_uuid, base_images, base_images_cache, None)
        .expect("should load from cache without file I/O");
    assert_eq!(loaded.width, 10);
    assert_eq!(loaded.height, 10);
}

#[test]
fn test_load_or_decode_concurrent_misses_do_not_deadlock() {
    let temp_dir = TempDir::new().expect("tempdir");
    let img_path = temp_dir.path().join("test.png");

    let source = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };
    let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast))
        .expect("encode test image");
    std::fs::write(&img_path, encoded).expect("write test image");

    let test_uuid = uuid::Uuid::new_v4();
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    base_images
        .lock()
        .unwrap()
        .insert(test_uuid.to_string(), img_path);
    let base_images_cache = test_lru_cache(16);

    let mut handles = Vec::with_capacity(4);
    for _ in 0..4 {
        let bi = base_images.clone();
        let bic = base_images_cache.clone();
        let id = test_uuid;
        handles.push(std::thread::spawn(move || {
            let loaded = load_or_decode_image(&id, bi, bic, None).expect("concurrent load");
            assert_eq!(loaded.width, 4);
            assert_eq!(loaded.height, 4);
        }));
    }

    for handle in handles {
        handle.join().expect("thread finished");
    }
}

#[test]
fn test_base_image_lru_eviction() {
    let base_images_cache = test_lru_cache(2);
    let id1 = uuid::Uuid::new_v4().to_string();
    let id2 = uuid::Uuid::new_v4().to_string();
    let id3 = uuid::Uuid::new_v4().to_string();

    let make_img = |w: u32| ProcessedImage {
        width: w,
        height: w,
        rgba: vec![0; (w * w * 4) as usize].into(),
    };

    {
        let mut cache = base_images_cache.lock().unwrap();
        cache.put(id1.clone(), make_img(1));
        cache.put(id2.clone(), make_img(2));
        assert!(cache.contains(&id1));
        assert!(cache.contains(&id2));

        // Inserting third item must evict id1 (least recently used)
        cache.put(id3.clone(), make_img(3));
        assert!(!cache.contains(&id1));
        assert!(cache.contains(&id2));
        assert!(cache.contains(&id3));
    }
}

#[test]
fn test_render_preview_with_cached_image() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let test_uuid = uuid::Uuid::new_v4();
        let base_images_cache = test_lru_cache(16);
        base_images_cache.lock().unwrap().put(
            test_uuid.to_string(),
            ProcessedImage {
                width: 4,
                height: 4,
                rgba: vec![200; 4 * 4 * 4].into(),
            },
        );

        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));
        let base_images = Arc::new(Mutex::new(HashMap::new()));

        let app_state = create_test_app_state(db, base_images, base_images_cache);

        let adjustments = Adjustments::default();
        let payload = render_preview(test_uuid, &adjustments, &app_state)
            .await
            .expect("render preview");

        // Header: width (4 bytes) + height (4 bytes) + RGBA (4*4*4=64 bytes) + histogram (1024*4=4096 bytes) = 4168 bytes
        assert_eq!(payload.len(), 8 + 64 + 4096);
    });
}

#[test]
fn test_render_thumbnail_raw_ipc() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let test_uuid = uuid::Uuid::new_v4();
        let base_images_cache = test_lru_cache(16);
        base_images_cache.lock().unwrap().put(
            test_uuid.to_string(),
            ProcessedImage {
                width: 20,
                height: 10,
                rgba: vec![150; 20 * 10 * 4].into(),
            },
        );

        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));
        let base_images = Arc::new(Mutex::new(HashMap::new()));

        let app_state = create_test_app_state(db, base_images, base_images_cache);

        let adjustments = Adjustments::default();
        let payload = render_thumbnail(test_uuid, &adjustments, &app_state)
            .await
            .expect("render thumbnail");

        // Header: width (4 bytes) + height (4 bytes) + RGBA (20*10*4=800 bytes) = 808 bytes
        assert_eq!(payload.len(), 8 + 800);

        // Subsequent call must hit LRU cache
        let payload2 = render_thumbnail(test_uuid, &adjustments, &app_state)
            .await
            .expect("render thumbnail cached");
        assert_eq!(payload2, payload);
    });
}

#[test]
fn test_thumbnail_cache_key_changes_with_geometry() {
    let id = uuid::Uuid::new_v4();
    let base = Adjustments::default();
    let mut geo = Adjustments::default();
    geo.geometry.zoom = 1.5;
    geo.geometry.straighten = 10.0;

    assert_ne!(
        thumbnail_cache_key(id, &base),
        thumbnail_cache_key(id, &geo),
        "geometry change must invalidate the thumbnail cache key"
    );
}

#[test]
fn test_thumbnail_cache_key_changes_with_max_dim() {
    let id = uuid::Uuid::new_v4();
    let adj = Adjustments::default();

    assert_ne!(
        thumbnail_cache_key_with_quality(id, &adj, Some("hq"), 200),
        thumbnail_cache_key_with_quality(id, &adj, Some("hq"), 400),
        "max_dim change must invalidate the thumbnail cache key"
    );
    assert_eq!(
        thumbnail_cache_key(id, &adj),
        thumbnail_cache_key_with_quality(id, &adj, None, darkslide_core::THUMBNAIL_MAX_DIM),
        "single-thumbnail cache key must match the batch default"
    );
}

#[test]
fn test_render_thumbnail_applies_geometry_dims() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let test_uuid = uuid::Uuid::new_v4();
        let base_images_cache = test_lru_cache(16);
        base_images_cache.lock().unwrap().put(
            test_uuid.to_string(),
            ProcessedImage {
                width: 20,
                height: 10,
                rgba: vec![120; 20 * 10 * 4].into(),
            },
        );

        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));
        let app_state = create_test_app_state(db, Arc::new(Mutex::new(HashMap::new())), base_images_cache);

        let mut adjustments = Adjustments::default();
        adjustments.geometry.zoom = 2.0;

        let payload = render_thumbnail(test_uuid, &adjustments, &app_state)
            .await
            .expect("render thumbnail with geometry");

        let width = u32::from_le_bytes(payload[0..4].try_into().unwrap());
        let height = u32::from_le_bytes(payload[4..8].try_into().unwrap());
        assert_eq!((width, height), (10, 5));
        assert_eq!(payload.len(), 8 + 10 * 5 * 4);
    });
}

#[test]
fn test_render_thumbnails_batch_function() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));

        let base_images = Arc::new(Mutex::new(HashMap::new()));
        let base_images_cache = test_lru_cache(16);
        let count = 5;
        let mut items = Vec::new();

        for i in 0..count {
            let test_uuid = uuid::Uuid::new_v4();
            base_images_cache.lock().unwrap().put(
                test_uuid.to_string(),
                ProcessedImage {
                    width: 20,
                    height: 20,
                    rgba: vec![i as u8; 20 * 20 * 4].into(),
                },
            );
            items.push((test_uuid, Adjustments::default()));
        }

        let app_state = create_test_app_state(db, base_images, base_images_cache);

        let thumbnails = render_thumbnails(&items, &app_state)
            .await
            .expect("render thumbnails batch");

        assert_eq!(thumbnails.len(), count);

        // Each packed thumbnail is [width: u32 LE][height: u32 LE][rgba bytes]
        for buf in &thumbnails {
            assert_eq!(buf.len(), 8 + 20 * 20 * 4);
            let width = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            let height = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            assert_eq!(width, 20);
            assert_eq!(height, 20);
        }

        let cached = render_thumbnails(&items, &app_state)
            .await
            .expect("render thumbnails cached");
        assert_eq!(cached, thumbnails);
    });
}

#[test]
fn test_lut_cache_shares_arc() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));

        let lut_values = vec![0.0f32; 32];
        db.store_lut("test".to_string(), lut_values, 2)
            .await
            .expect("store lut");
        let lut_id = db.load_luts().await.expect("load luts")[0].id;

        let lut_cache = Arc::new(Mutex::new(HashMap::new()));

        let lut1 = resolve_lut(Some(lut_id), 100, &lut_cache, &db)
            .await
            .expect("resolve lut 1")
            .expect("lut 1 exists");

        let lut2 = resolve_lut(Some(lut_id), 100, &lut_cache, &db)
            .await
            .expect("resolve lut 2")
            .expect("lut 2 exists");

        let ptr1 = Arc::as_ptr(&lut1.data);
        let ptr2 = Arc::as_ptr(&lut2.data);
        assert_eq!(ptr1, ptr2, "LUT cache should share the same Arc data");
    });
}

#[test]
fn test_update_db_flag_persists_only_when_enabled() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));

        let dummy_path = temp_dir.path().join("test.jpg");
        std::fs::write(&dummy_path, b"dummy").unwrap();

        let rec = db
            .create_image_record(Some(&dummy_path), 5)
            .await
            .expect("create image in db");
        let test_uuid = rec.id;

        let base_images = Arc::new(Mutex::new(HashMap::new()));
        let base_images_cache = test_lru_cache(16);
        base_images_cache.lock().unwrap().put(
            test_uuid.to_string(),
            ProcessedImage {
                width: 10,
                height: 10,
                rgba: vec![128; 10 * 10 * 4].into(),
            },
        );

        let app_state = create_test_app_state(db.clone(), base_images, base_images_cache);

        // 1. Request with update_db = false
        let mut adj_no_save = Adjustments::default();
        adj_no_save.light.exposure = 2.5;
        let _ = render_image(test_uuid, &adj_no_save, None, false, &app_state)
            .await
            .expect("render image no save");

        // Check DB was NOT updated
        let record = db.find_image_by_uuid(test_uuid).await.unwrap().unwrap();
        assert_eq!(record.adjustments.light.exposure, 0.0);

        // 2. Request with update_db = true
        let mut adj_save = Adjustments::default();
        adj_save.light.exposure = 3.5;
        let _ = render_image(test_uuid, &adj_save, None, true, &app_state)
            .await
            .expect("render image save");

        // Check DB WAS updated
        let record2 = db.find_image_by_uuid(test_uuid).await.unwrap().unwrap();
        assert_eq!(record2.adjustments.light.exposure, 3.5);
    });
}

#[test]
fn test_pack_thumbnails_batch_format() {
    let thumb1 = {
        let mut buf = Vec::new();
        buf.extend_from_slice(&20u32.to_le_bytes());
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(&vec![1u8; 20 * 10 * 4]);
        buf
    };
    let thumb2 = {
        let mut buf = Vec::new();
        buf.extend_from_slice(&5u32.to_le_bytes());
        buf.extend_from_slice(&5u32.to_le_bytes());
        buf.extend_from_slice(&[2u8; 5 * 5 * 4]);
        buf
    };

    let payload = pack_thumbnails_batch(vec![thumb1.clone(), thumb2.clone()]);

    // Header: count (4 bytes)
    assert_eq!(payload.len(), 4 + thumb1.len() + thumb2.len());
    assert_eq!(&payload[0..4], &2u32.to_le_bytes());

    // First thumbnail is appended unchanged.
    assert_eq!(&payload[4..4 + thumb1.len()], &thumb1[..]);

    // Second thumbnail follows.
    assert_eq!(&payload[4 + thumb1.len()..], &thumb2[..]);
}

#[test]
fn test_render_preview_cancelled_when_active_image_switched() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let temp_dir = TempDir::new().expect("tempdir");
        let db_path = temp_dir.path().join("test.sqlite");
        let db = Arc::new(Db::open(db_path).expect("open db"));

        let base_images = Arc::new(Mutex::new(HashMap::new()));
        let base_images_cache = test_lru_cache(16);

        let id1 = uuid::Uuid::new_v4();
        let id2 = uuid::Uuid::new_v4();

        base_images_cache.lock().unwrap().put(
            id1.to_string(),
            ProcessedImage {
                width: 10,
                height: 10,
                rgba: vec![100; 10 * 10 * 4].into(),
            },
        );

        let app_state = create_test_app_state(db, base_images, base_images_cache);
        *app_state.active_image_id.lock().unwrap() = Some(id2);

        let res = render_image(
            id1,
            &Adjustments::default(),
            Some(darkslide_core::PREVIEW_MAX_DIM),
            false,
            &app_state,
        )
        .await;

        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "cancelled");
    });
}

#[test]
fn test_load_or_decode_preview_then_thumbnail_hits_cache() {
    let temp_dir = TempDir::new().expect("tempdir");
    let img_path = temp_dir.path().join("preview_thumb_test.png");

    let source = ProcessedImage {
        width: 800,
        height: 600,
        rgba: vec![120; 800 * 600 * 4].into(),
    };
    let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast))
        .expect("encode test image");
    std::fs::write(&img_path, encoded).expect("write test image");

    let test_uuid = uuid::Uuid::new_v4();
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    base_images
        .lock()
        .unwrap()
        .insert(test_uuid.to_string(), img_path.clone());
    let base_images_cache = test_lru_cache(16);

    let preview = load_or_decode_image(
        &test_uuid,
        base_images.clone(),
        base_images_cache.clone(),
        Some(darkslide_core::PREVIEW_MAX_DIM),
    )
    .expect("load preview");
    assert_eq!(preview.width, 800);
    assert_eq!(preview.height, 600);
    assert!(base_images_cache.lock().unwrap().contains(&test_uuid.to_string()));

    std::fs::remove_file(&img_path).expect("remove file to verify cache hit");

    let thumb = load_or_decode_image(
        &test_uuid,
        base_images.clone(),
        base_images_cache.clone(),
        Some(darkslide_core::THUMBNAIL_MAX_DIM),
    )
    .expect("load thumb from cache");
    assert_eq!(thumb.width, 400);
    assert_eq!(thumb.height, 300);
}

#[tokio::test]
async fn test_thumbnail_pool_concurrency_and_execution() {
    use darkslide_lib::render::service::THUMBNAIL_POOL;
    let pool_threads = THUMBNAIL_POOL.current_num_threads();
    assert!(pool_threads >= 2);

    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = create_test_app_state(db, base_images.clone(), base_images_cache);

    let mut items = Vec::new();
    for i in 0..4 {
        let test_uuid = uuid::Uuid::new_v4();
        let img_path = temp_dir.path().join(format!("thumb_pool_test_{i}.png"));
        let source = ProcessedImage {
            width: 100,
            height: 100,
            rgba: vec![100; 100 * 100 * 4].into(),
        };
        let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
        std::fs::write(&img_path, encoded).unwrap();
        base_images.lock().unwrap().insert(test_uuid.to_string(), img_path);
        items.push((test_uuid, Adjustments::default()));
    }

    let results = render_thumbnails(&items, &state).await.expect("render_thumbnails in pool");
    assert_eq!(results.len(), 4);
    for thumb in results {
        assert!(thumb.len() > 8);
    }
}

#[tokio::test]
async fn test_prefetch_previews_populates_base_images_cache() {
    use darkslide_lib::render::service::prefetch_previews;

    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = create_test_app_state(db, base_images.clone(), base_images_cache.clone());

    let mut prefetch_uuids = Vec::new();
    for i in 0..2 {
        let test_uuid = uuid::Uuid::new_v4();
        let img_path = temp_dir.path().join(format!("prefetch_test_{i}.png"));
        let source = ProcessedImage {
            width: 80,
            height: 60,
            rgba: vec![150; 80 * 60 * 4].into(),
        };
        let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
        std::fs::write(&img_path, encoded).unwrap();
        base_images.lock().unwrap().insert(test_uuid.to_string(), img_path);
        prefetch_uuids.push(test_uuid);
    }

    prefetch_previews(prefetch_uuids.clone(), &state);

    let start = std::time::Instant::now();
    let mut all_cached = false;
    while start.elapsed() < std::time::Duration::from_secs(3) {
        let cache = base_images_cache.lock().unwrap();
        if prefetch_uuids.iter().all(|id| cache.contains(&id.to_string())) {
            all_cached = true;
            break;
        }
        drop(cache);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    assert!(all_cached, "prefetch_previews must populate base_images_cache");
}

#[tokio::test]
async fn test_render_thumbnails_tiered() {
    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = create_test_app_state(db, base_images.clone(), base_images_cache);

    let test_uuid = uuid::Uuid::new_v4();
    let img_path = temp_dir.path().join("tiered_test.png");
    let source = ProcessedImage {
        width: 300,
        height: 300,
        rgba: vec![100; 300 * 300 * 4].into(),
    };
    let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
    std::fs::write(&img_path, encoded).unwrap();
    base_images.lock().unwrap().insert(test_uuid.to_string(), img_path);

    let fast_req = vec![ThumbnailRequest {
        id: test_uuid,
        adjustments: Adjustments::default(),
        quality: Some("fast".to_string()),
        max_dim: 160,
    }];
    let fast_results = render_thumbnails_tiered(&fast_req, &state).await.expect("render fast tiered");
    assert_eq!(fast_results.len(), 1);
    let fast_buf = &fast_results[0];
    let fast_w = u32::from_le_bytes([fast_buf[0], fast_buf[1], fast_buf[2], fast_buf[3]]);
    let fast_h = u32::from_le_bytes([fast_buf[4], fast_buf[5], fast_buf[6], fast_buf[7]]);
    assert_eq!(fast_w, 160);
    assert_eq!(fast_h, 160);

    let hq_req = vec![ThumbnailRequest {
        id: test_uuid,
        adjustments: Adjustments::default(),
        quality: Some("hq".to_string()),
        max_dim: 400,
    }];
    let hq_results = render_thumbnails_tiered(&hq_req, &state).await.expect("render hq tiered");
    assert_eq!(hq_results.len(), 1);
    let hq_buf = &hq_results[0];
    let hq_w = u32::from_le_bytes([hq_buf[0], hq_buf[1], hq_buf[2], hq_buf[3]]);
    let hq_h = u32::from_le_bytes([hq_buf[4], hq_buf[5], hq_buf[6], hq_buf[7]]);
    assert_eq!(hq_w, 300);
    assert_eq!(hq_h, 300);

    let cached_fast = render_thumbnails_tiered(&fast_req, &state).await.expect("render fast cached");
    assert_eq!(cached_fast[0], fast_buf[..]);
}

#[tokio::test]
async fn test_render_thumbnails_tiered_lut_deduplication() {
    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = create_test_app_state(db.clone(), base_images.clone(), base_images_cache);

    let lut_values = vec![0.5f32; 32];
    db.store_lut("test_lut".to_string(), lut_values, 2)
        .await
        .expect("store lut");
    let lut_id = db.load_luts().await.expect("load luts")[0].id;

    let mut requests = Vec::new();
    for i in 0..4 {
        let test_uuid = uuid::Uuid::new_v4();
        let img_path = temp_dir.path().join(format!("lut_test_{i}.png"));
        let source = ProcessedImage {
            width: 50,
            height: 50,
            rgba: vec![100 + i as u8; 50 * 50 * 4].into(),
        };
        let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
        std::fs::write(&img_path, encoded).unwrap();
        base_images.lock().unwrap().insert(test_uuid.to_string(), img_path);

        let mut adj = Adjustments::default();
        adj.lut_id = Some(lut_id as u32);
        adj.lut_intensity = 80;
        requests.push(ThumbnailRequest {
            id: test_uuid,
            adjustments: adj,
            quality: Some("fast".to_string()),
            max_dim: 160,
        });
    }

    let results = render_thumbnails_tiered(&requests, &state)
        .await
        .expect("render thumbnails with deduplicated lut");
    assert_eq!(results.len(), 4);
    assert_eq!(state.lut_cache.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn test_render_thumbnails_tiered_matches_render_image_direct() {
    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = create_test_app_state(db, base_images.clone(), base_images_cache.clone());

    let test_uuid = uuid::Uuid::new_v4();
    let img_path = temp_dir.path().join("match_test.png");
    let source = ProcessedImage {
        width: 100,
        height: 100,
        rgba: vec![140; 100 * 100 * 4].into(),
    };
    let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
    std::fs::write(&img_path, encoded).unwrap();
    base_images.lock().unwrap().insert(test_uuid.to_string(), img_path);
    base_images_cache
        .lock()
        .unwrap()
        .put(test_uuid.to_string(), source.clone());

    let mut adj = Adjustments::default();
    adj.light.exposure = 0.5;
    adj.color.temperature = 6500;
    adj.rotation = 90;

    let req = vec![ThumbnailRequest {
        id: test_uuid,
        adjustments: adj.clone(),
        quality: Some("hq".to_string()),
        max_dim: 400,
    }];

    let tiered_results = render_thumbnails_tiered(&req, &state).await.expect("tiered");
    assert_eq!(tiered_results.len(), 1);
    let tiered_buf = &tiered_results[0];
    let tiered_w = u32::from_le_bytes([tiered_buf[0], tiered_buf[1], tiered_buf[2], tiered_buf[3]]);
    let tiered_h = u32::from_le_bytes([tiered_buf[4], tiered_buf[5], tiered_buf[6], tiered_buf[7]]);
    let tiered_pixels = &tiered_buf[8..];

    let direct = darkslide_lib::render::service::render_image_direct(&source, &adj, &state.gpu, None);
    assert_eq!(tiered_w, direct.width);
    assert_eq!(tiered_h, direct.height);
    assert_eq!(tiered_pixels, direct.rgba.as_slice());
}

#[tokio::test]
async fn test_parallel_export_correctness_and_completeness() {
    let temp_dir = TempDir::new().expect("tempdir");
    let db_path = temp_dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::new()));
    let base_images_cache = test_lru_cache(16);
    let state = Arc::new(create_test_app_state(
        db.clone(),
        base_images.clone(),
        base_images_cache,
    ));

    let export_dir = temp_dir.path().join("deep/nested/export");
    let count = 8;
    let mut ids = Vec::new();
    let mut paths = Vec::new();

    for i in 0..count {
        let test_uuid = uuid::Uuid::new_v4();
        let img_path = temp_dir.path().join(format!("src_{i}.png"));
        let source = ProcessedImage {
            width: 40,
            height: 40,
            rgba: vec![120 + i as u8; 40 * 40 * 4].into(),
        };
        let encoded = darkslide_core::encode(&source, ImageType::PNG(PngCompressionLevel::Fast)).unwrap();
        std::fs::write(&img_path, &encoded).unwrap();
        base_images
            .lock()
            .unwrap()
            .insert(test_uuid.to_string(), img_path.clone());
        db.create_image_record(Some(img_path.as_path()), encoded.len() as u64)
            .await
            .expect("create record");

        let out_path = export_dir.join(format!("exported_{i}.jpg"));
        ids.push(test_uuid.to_string());
        paths.push(out_path);
    }

    let mut handles = Vec::new();
    for i in 0..count {
        let id = ids[i].clone();
        let path = paths[i].to_string_lossy().to_string();
        let state_clone = state.clone();
        let handle = tokio::spawn(async move {
            let adj = Adjustments::default();
            darkslide_lib::export_image_internal(
                &id,
                &adj,
                &path,
                "jpg",
                Some(90),
                None,
                &state_clone,
            )
            .await
        });
        handles.push(handle);
    }

    for handle in handles {
        let res = handle.await.expect("join handle");
        assert!(res.is_ok(), "export error: {:?}", res.err());
    }

    for path in &paths {
        assert!(path.exists());
        let meta = std::fs::metadata(path).expect("metadata");
        assert!(meta.len() > 0);
        let bytes = std::fs::read(path).expect("read exported");
        let decoded = darkslide_core::decode_image(&bytes);
        assert!(decoded.is_ok());
    }
}

#[tokio::test]
async fn test_resolve_image_preserves_zero_rotation_default() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let db = Arc::new(Db::open(db_path).expect("open db"));
    let repo = darkslide_lib::image_resolver::ImageResolver::new(db);

    let sample_path = "/Volumes/Untitled/DCIM/100MSDCF/DSC00618.JPG";
    if std::path::Path::new(sample_path).exists() {
        let meta = std::fs::metadata(sample_path).unwrap();
        let (_uuid, adjustments) = repo
            .resolve(std::path::Path::new(sample_path), meta.len())
            .await
            .expect("resolve");
        assert_eq!(adjustments.rotation, 0);
    }

    let dummy_path = dir.path().join("test.jpg");
    std::fs::write(&dummy_path, b"testdata").unwrap();
    let (_uuid, adjustments) = repo
        .resolve(dummy_path.as_path(), 8)
        .await
        .expect("resolve dummy");
    assert_eq!(adjustments.rotation, 0);
}

