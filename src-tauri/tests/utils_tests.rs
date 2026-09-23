use darkslide_lib::db::Db;
use darkslide_lib::types::AppState;
use darkslide_lib::utils::{get_file_uuid, inject_exif, natural_cmp, pack_images, set_file_uuid};
use lru::LruCache;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

fn test_lru_cache<K: std::hash::Hash + Eq, V>(cap: usize) -> Arc<Mutex<LruCache<K, V>>> {
    Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(cap).unwrap())))
}

fn test_app_state(db_path: &std::path::Path) -> AppState {
    let db = Arc::new(Db::open(db_path.to_path_buf()).expect("open db"));
    let base_images = Arc::new(Mutex::new(HashMap::<String, std::path::PathBuf>::new()));
    let base_images_cache = test_lru_cache::<String, darkslide_core::types::ProcessedImage>(16);
    let thumbnails = test_lru_cache::<String, Vec<u8>>(500);
    let lut_cache = Arc::new(Mutex::new(HashMap::<u32, (Arc<Vec<f32>>, usize)>::new()));
    let exif_cache = test_lru_cache::<String, Vec<u8>>(darkslide_lib::types::EXIF_CACHE_CAPACITY);
    let gpu = Arc::new(darkslide_core::GpuState::init().expect("gpu init"));

    AppState {
        base_images,
        base_images_cache,
        thumbnails,
        lut_cache,
        exif_cache,
        db_instance: db,
        gpu,
        active_image_id: Arc::new(Mutex::new(None)),
    }
}

#[test]
fn set_uuid_success() {
    let dir = TempDir::new().expect("tempdir");
    let path: PathBuf = dir.path().join("file.txt");
    std::fs::File::create(&path).expect("failed to create file");

    set_file_uuid(path.to_str().unwrap(), uuid::Uuid::new_v4()).expect("failed");
}

#[test]
fn get_uuid_success() {
    let dir = TempDir::new().expect("tempdir");
    let path: PathBuf = dir.path().join("file.txt");
    std::fs::File::create(&path).expect("failed to create file");

    let uuid_value = uuid::Uuid::new_v4();

    set_file_uuid(path.to_str().unwrap(), uuid_value).expect("failed");

    let resolved_value = get_file_uuid(path.to_str().unwrap()).map_err(|e| e.to_string());

    match resolved_value {
        Err(_) => panic!(),
        Ok(s_v) => match s_v {
            None => panic!(),
            Some(uuid_v) => assert_eq!(uuid_v.to_string(), uuid_value.to_string()),
        },
    }
}

#[test]
fn inject_exif_returns_encoded_when_record_missing() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let app_state = test_app_state(&db_path);

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let encoded = vec![0xFF, 0xD8, 0xFF, 0xD9]; // minimal JPEG
        let uid = uuid::Uuid::new_v4();
        let result = inject_exif(uid, encoded.clone(), &app_state).await;
        assert_eq!(result, encoded);
    });
}

#[test]
fn inject_exif_returns_encoded_when_source_file_missing() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let app_state = test_app_state(&db_path);

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let missing_path = dir.path().join("missing.jpg");
        let record = app_state
            .db_instance
            .create_image_record(Some(missing_path.as_path()), 0)
            .await
            .expect("insert record");

        let encoded = vec![0xFF, 0xD8, 0xFF, 0xD9]; // minimal JPEG
        let result = inject_exif(record.id, encoded.clone(), &app_state).await;
        assert_eq!(result, encoded);
        assert!(app_state.exif_cache.lock().unwrap().is_empty());
    });
}

#[test]
fn inject_exif_caches_exif_bytes() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let app_state = test_app_state(&db_path);

    let rt = tokio::runtime::Runtime::new().unwrap();
    let uid = rt.block_on(async {
        let source_path = dir.path().join("source.jpg");
        // Minimal JPEG with an APP1/Exif segment containing dummy TIFF bytes.
        let exif_payload = b"\x49\x49\x2A\x00\x08\x00\x00\x00"; // little-endian TIFF header
        let app1_len = (2 + 6 + exif_payload.len()) as u16;
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.push(0xFF);
        jpeg.push(0xE1);
        jpeg.extend_from_slice(&app1_len.to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(exif_payload);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        std::fs::write(&source_path, &jpeg).unwrap();

        let record = app_state
            .db_instance
            .create_image_record(Some(source_path.as_path()), jpeg.len() as u64)
            .await
            .expect("insert record");

        let encoded = vec![0xFF, 0xD8, 0xFF, 0xD9];
        let result = inject_exif(record.id, encoded.clone(), &app_state).await;

        // The encoded bytes should have grown by the injected APP1 segment.
        assert!(result.len() > encoded.len());

        // EXIF bytes should now be cached.
        let cache = app_state.exif_cache.lock().unwrap();
        assert!(cache.peek(&record.id.to_string()).is_some());
        record.id
    });

    // Remove the source file; the next call should still succeed from cache.
    std::fs::remove_file(dir.path().join("source.jpg")).unwrap();

    rt.block_on(async {
        let encoded = vec![0xFF, 0xD8, 0xFF, 0xD9];
        let result = inject_exif(uid, encoded.clone(), &app_state).await;
        assert!(result.len() > encoded.len());
    });
}

#[test]
fn inject_exif_normalizes_orientation_for_export() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let app_state = test_app_state(&db_path);

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let source_path = dir.path().join("source.jpg");
        let tiff_payload = vec![
            b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00,
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ];
        let app1_len = (2 + 6 + tiff_payload.len()) as u16;
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.push(0xFF);
        jpeg.push(0xE1);
        jpeg.extend_from_slice(&app1_len.to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff_payload);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        std::fs::write(&source_path, &jpeg).unwrap();

        let record = app_state
            .db_instance
            .create_image_record(Some(source_path.as_path()), jpeg.len() as u64)
            .await
            .expect("insert record");

        let encoded = vec![0xFF, 0xD8, 0xFF, 0xD9];
        let result = inject_exif(record.id, encoded.clone(), &app_state).await;
        assert_eq!(darkslide_core::exif::orientation(&result), Some(0));

        let cache = app_state.exif_cache.lock().unwrap();
        let cached = cache.peek(&record.id.to_string()).expect("cached");
        assert_eq!(cached[18], 1);
    });
}

#[test]
fn pack_images_uses_binary_adjustment_layout() {
    use darkslide_core::exif::AsShotWb;
    use darkslide_core::types::{
        Adjustments, Color, ColorBalance, CurvePoint, Curves, Denoise, Detail, Geometry, Grain, HSL,
        Light, SelectiveChannel, SelectiveColor, Sharpen, ToneBalance,
    };
    use std::path::PathBuf;

    let adj = Adjustments {
        light: Light {
            exposure: 1.5,
            contrast: 10,
            highlights: -20,
            shadows: 30,
            whites: 5,
            blacks: -5,
            brightness: 7,
        },
        color: Color {
            temperature: 25,
            tint: 5,
        },
        hsl: HSL {
            hue: 10,
            saturation: -10,
            vibrance: 15,
        },
        detail: Detail {
            black_point: 5,
            texture: 10,
            clarity: -10,
            sharpen: Sharpen {
                amount: 25,
                radius: 1,
            },
            grain: Grain {
                amount: 0,
                size: 10,
                roughness: 50,
            },
            denoise: Denoise {
                strength: 30,
                preserve: 40,
            },
        },
        curves: Curves {
            rgb: vec![
                CurvePoint { x: 0.0, y: 0.0 },
                CurvePoint { x: 255.0, y: 255.0 },
            ],
            red: vec![
                CurvePoint { x: 0.0, y: 10.0 },
                CurvePoint { x: 255.0, y: 240.0 },
            ],
            green: vec![],
            blue: vec![CurvePoint { x: 128.0, y: 100.0 }],
        },
        as_shot_wb: AsShotWb {
            kelvin: Some(5200),
            neutral_rgb: None,
        },
        rotation: 90,
        geometry: Geometry {
            straighten: 2.5,
            zoom: 1.25,
            crop_x: 0.1,
            crop_y: -0.2,
            ..Default::default()
        },
        lut_id: Some(42),
        lut_intensity: 75,
        color_balance: ColorBalance {
            shadows: ToneBalance { hue: 15.0, saturation: 20.0, luminance: -5.0 },
            midtones: ToneBalance { hue: 45.0, saturation: 10.0, luminance: 5.0 },
            highlights: ToneBalance { hue: 210.0, saturation: 30.0, luminance: 0.0 },
        },
        selective_color: SelectiveColor {
            red: SelectiveChannel { hue: 5.0, saturation: -10.0, luminance: 15.0 },
            orange: SelectiveChannel { hue: 0.0, saturation: 25.0, luminance: 0.0 },
            yellow: SelectiveChannel { hue: -5.0, saturation: 0.0, luminance: 10.0 },
            green: SelectiveChannel { hue: 10.0, saturation: 30.0, luminance: -10.0 },
            aqua: SelectiveChannel { hue: 0.0, saturation: 0.0, luminance: 0.0 },
            blue: SelectiveChannel { hue: -15.0, saturation: 40.0, luminance: 5.0 },
            purple: SelectiveChannel { hue: 0.0, saturation: 0.0, luminance: 0.0 },
            magenta: SelectiveChannel { hue: 20.0, saturation: -20.0, luminance: 0.0 },
        },
        ..Default::default()
    };

    let images = vec![("img-1".to_string(), PathBuf::from("/tmp/a.jpg"), adj.clone())];
    let packed = pack_images(&images);

    struct Cursor<'a> {
        buf: &'a [u8],
        pos: usize,
    }
    impl<'a> Cursor<'a> {
        fn u32(&mut self) -> u32 {
            let v = u32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
            self.pos += 4;
            v
        }
        fn i32(&mut self) -> i32 { self.u32() as i32 }
        fn f32(&mut self) -> f32 {
            let v = f32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
            self.pos += 4;
            v
        }
        fn f64(&mut self) -> f64 {
            let v = f64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
            self.pos += 8;
            v
        }
    }

    let mut cur = Cursor { buf: &packed, pos: 0 };

    let id_len = cur.u32() as usize;
    assert_eq!(&packed[cur.pos..cur.pos + id_len], b"img-1");
    cur.pos += id_len;

    let filename_len = cur.u32() as usize;
    assert_eq!(&packed[cur.pos..cur.pos + filename_len], b"a.jpg");
    cur.pos += filename_len;

    assert_eq!(packed[cur.pos], 6); // version
    cur.pos += 1;

    assert!((cur.f32() - adj.light.exposure).abs() < f32::EPSILON);
    assert_eq!(cur.i32(), adj.light.contrast);
    assert_eq!(cur.i32(), adj.light.highlights);
    assert_eq!(cur.i32(), adj.light.shadows);
    assert_eq!(cur.i32(), adj.light.whites);
    assert_eq!(cur.i32(), adj.light.blacks);
    assert_eq!(cur.i32(), adj.light.brightness);

    assert_eq!(cur.i32(), adj.color.temperature);
    assert_eq!(cur.i32(), adj.color.tint);

    assert_eq!(cur.i32(), adj.hsl.hue);
    assert_eq!(cur.i32(), adj.hsl.saturation);
    assert_eq!(cur.i32(), adj.hsl.vibrance);

    assert_eq!(cur.i32(), adj.detail.black_point);
    assert_eq!(cur.i32(), adj.detail.texture);
    assert_eq!(cur.i32(), adj.detail.clarity);
    assert_eq!(cur.i32(), adj.detail.sharpen.amount);
    assert_eq!(cur.i32(), adj.detail.sharpen.radius);
    assert_eq!(cur.i32(), adj.detail.grain.amount);
    assert_eq!(cur.i32(), adj.detail.grain.size);
    assert_eq!(cur.i32(), adj.detail.grain.roughness);
    assert_eq!(cur.i32(), adj.detail.denoise.strength);
    assert_eq!(cur.i32(), adj.detail.denoise.preserve);

    assert_eq!(cur.u32(), adj.rotation);
    assert_eq!(cur.u32(), 1); // lut_id present
    assert_eq!(cur.u32(), 42);
    assert_eq!(cur.u32(), adj.lut_intensity);

    for channel in [
        &adj.curves.rgb,
        &adj.curves.red,
        &adj.curves.green,
        &adj.curves.blue,
    ] {
        assert_eq!(cur.u32() as usize, channel.len());
        for pt in channel {
            assert!((cur.f64() - pt.x).abs() < f64::EPSILON);
            assert!((cur.f64() - pt.y).abs() < f64::EPSILON);
        }
    }

    assert_eq!(cur.u32(), 1); // as_shot_wb kelvin present
    assert_eq!(cur.u32(), 5200);
    assert_eq!(cur.u32(), 0); // neutral absent
    assert_eq!(cur.f32(), 0.0);
    assert_eq!(cur.f32(), 0.0);
    assert_eq!(cur.f32(), 0.0);

    assert!((cur.f32() - adj.geometry.straighten).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.zoom).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.crop_x).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.crop_y).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.distortion).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.perspective_v).abs() < f32::EPSILON);
    assert!((cur.f32() - adj.geometry.perspective_h).abs() < f32::EPSILON);

    for tone in [
        &adj.color_balance.shadows,
        &adj.color_balance.midtones,
        &adj.color_balance.highlights,
    ] {
        assert!((cur.f32() - tone.hue).abs() < f32::EPSILON);
        assert!((cur.f32() - tone.saturation).abs() < f32::EPSILON);
        assert!((cur.f32() - tone.luminance).abs() < f32::EPSILON);
    }

    for ch in [
        &adj.selective_color.red,
        &adj.selective_color.orange,
        &adj.selective_color.yellow,
        &adj.selective_color.green,
        &adj.selective_color.aqua,
        &adj.selective_color.blue,
        &adj.selective_color.purple,
        &adj.selective_color.magenta,
    ] {
        assert!((cur.f32() - ch.hue).abs() < f32::EPSILON);
        assert!((cur.f32() - ch.saturation).abs() < f32::EPSILON);
        assert!((cur.f32() - ch.luminance).abs() < f32::EPSILON);
    }

    assert_eq!(cur.pos, packed.len());
}

#[test]
fn test_natural_cmp() {
    let mut files = vec![
        "img_10.jpg",
        "IMG_2.jpg",
        "img_1.jpg",
        "img_20.jpg",
        "photo.jpg",
        "photo_1.jpg",
    ];
    files.sort_by(|a, b| natural_cmp(a, b));

    assert_eq!(
        files,
        vec![
            "img_1.jpg",
            "IMG_2.jpg",
            "img_10.jpg",
            "img_20.jpg",
            "photo.jpg",
            "photo_1.jpg",
        ]
    );
}

#[cfg(feature = "profiling")]
#[test]
fn test_cli_parsing_flags() {
    let args = vec![
        "test_fixtures/images".to_string(),
        "--scenario".to_string(),
        "--devtools".to_string(),
    ];
    let cli = darkslide_lib::io::Cli::parse_args(&args);
    assert_eq!(cli.inputs.len(), 1);
    assert!(cli.scenario);
    assert!(cli.devtools);

    let default_args = vec!["image.jpg".to_string()];
    let default_cli = darkslide_lib::io::Cli::parse_args(&default_args);
    assert_eq!(default_cli.inputs.len(), 1);
    assert!(!default_cli.scenario);
    assert!(!default_cli.devtools);
}

#[test]
fn exif_cache_capacity_and_unload_eviction() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");
    let app_state = test_app_state(&db_path);

    for i in 0..250 {
        app_state
            .exif_cache
            .lock()
            .unwrap()
            .put(format!("img_{i}"), vec![i as u8]);
    }

    assert_eq!(app_state.exif_cache.lock().unwrap().len(), 200);
    assert!(app_state.exif_cache.lock().unwrap().peek("img_0").is_none());
    assert!(app_state.exif_cache.lock().unwrap().peek("img_49").is_none());
    assert!(app_state.exif_cache.lock().unwrap().peek("img_50").is_some());
    assert!(app_state.exif_cache.lock().unwrap().peek("img_249").is_some());

    darkslide_lib::unload_images_internal(&["img_50".to_string(), "img_100".to_string()], &app_state);

    assert!(app_state.exif_cache.lock().unwrap().peek("img_50").is_none());
    assert!(app_state.exif_cache.lock().unwrap().peek("img_100").is_none());
    assert_eq!(app_state.exif_cache.lock().unwrap().len(), 198);
}


#[test]
fn unload_evicts_backend_thumbnails_by_id_prefix() {
    let dir = TempDir::new().expect("tempdir");
    let app_state = test_app_state(&dir.path().join("thumb.sqlite"));

    {
        let mut thumbs = app_state.thumbnails.lock().unwrap();
        thumbs.put("img_50:hq:200:aaaa".to_string(), vec![1]);
        thumbs.put("img_50:fast:160:bbbb".to_string(), vec![2]);
        thumbs.put("img_5:hq:200:cccc".to_string(), vec![3]);
        thumbs.put("img_100:hq:200:dddd".to_string(), vec![4]);
        assert_eq!(thumbs.len(), 4);
    }

    darkslide_lib::unload_images_internal(&["img_50".to_string()], &app_state);

    let thumbs = app_state.thumbnails.lock().unwrap();
    assert!(thumbs.peek("img_50:hq:200:aaaa").is_none());
    assert!(thumbs.peek("img_50:fast:160:bbbb").is_none());
    // Prefix must match a whole id segment, not a substring of another id.
    assert!(thumbs.peek("img_5:hq:200:cccc").is_some());
    assert!(thumbs.peek("img_100:hq:200:dddd").is_some());
    assert_eq!(thumbs.len(), 2);
}
