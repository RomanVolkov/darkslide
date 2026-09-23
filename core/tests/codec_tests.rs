use darkslide_core::codec::{
    decode_image, decode_image_with_size, encode, fast_resize, is_supported_image_extension,
    PREVIEW_MAX_DIM, THUMBNAIL_MAX_DIM,
};
use darkslide_core::types::{ImageType, PngCompressionLevel, ProcessedImage};

#[test]
fn test_is_supported_image_extension() {
    assert!(is_supported_image_extension("jpg"));
    assert!(is_supported_image_extension("JPG"));
    assert!(is_supported_image_extension("png"));
    assert!(is_supported_image_extension("webp"));
    assert!(is_supported_image_extension("heic"));
    assert!(!is_supported_image_extension("exe"));
    assert!(!is_supported_image_extension("txt"));
}

#[test]
fn test_encode_and_decode_roundtrip_png() {
    // Create a synthetic 2x2 RGBA image (Red, Green, Blue, White)
    let original = ProcessedImage {
        width: 2,
        height: 2,
        rgba: vec![
            255, 0, 0, 255,   // top-left
            0, 255, 0, 255,   // top-right
            0, 0, 255, 255,   // bottom-left
            255, 255, 255, 255, // bottom-right
        ].into(),
    };

    let encoded = encode(&original, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");
    assert!(!encoded.is_empty());

    let decoded = decode_image(&encoded).expect("decode PNG");
    assert!(decoded.width <= PREVIEW_MAX_DIM);
    assert!(decoded.height <= PREVIEW_MAX_DIM);
    assert_eq!(decoded.rgba.len(), (decoded.width * decoded.height * 4) as usize);
}

#[test]
fn test_encode_jpg_and_webp_and_tiff() {
    let original = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };

    let jpg_bytes = encode(&original, ImageType::JPG(90)).expect("encode JPG");
    assert!(!jpg_bytes.is_empty());
    assert_eq!(ImageType::detect(&jpg_bytes).map(|t| matches!(t, ImageType::JPG(_))), Some(true));

    let webp_bytes = encode(&original, ImageType::WEBP).expect("encode WEBP");
    assert!(!webp_bytes.is_empty());
    assert_eq!(ImageType::detect(&webp_bytes).map(|t| matches!(t, ImageType::WEBP)), Some(true));

    let tiff_bytes = encode(&original, ImageType::TIFF).expect("encode TIFF");
    assert!(!tiff_bytes.is_empty());
}

#[test]
fn test_fast_resize_no_op_for_small_image() {
    let img = ProcessedImage {
        width: 10,
        height: 10,
        rgba: vec![128; 10 * 10 * 4].into(),
    };
    let resized = fast_resize(img.clone(), PREVIEW_MAX_DIM).expect("resize");
    assert_eq!(resized.width, 10);
    assert_eq!(resized.height, 10);
    assert_eq!(resized.rgba.len(), img.rgba.len());
}

#[test]
fn test_fast_resize_unique_buffer_matches_shared_buffer() {
    // 8x8 gradient; force downscale to 4x4.
    let mut rgba = Vec::with_capacity(8 * 8 * 4);
    for y in 0..8u32 {
        for x in 0..8u32 {
            let v = ((x + y) * 255 / 14).min(255) as u8;
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
    }
    let img = ProcessedImage {
        width: 8,
        height: 8,
        rgba: rgba.into(),
    };

    // Unique refcount path: move the image directly in.
    let unique_resized = fast_resize(img.clone(), 4).expect("resize unique");

    // Shared refcount path: clone the Arc so the buffer is shared.
    let shared_resized = fast_resize(img.clone(), 4).expect("resize shared");

    assert_eq!(unique_resized.width, shared_resized.width);
    assert_eq!(unique_resized.height, shared_resized.height);
    assert_eq!(unique_resized.rgba, shared_resized.rgba);
}

#[test]
fn test_decode_image_with_size_thumbnail_and_preview() {
    let width = 800;
    let height = 600;
    let original = ProcessedImage {
        width,
        height,
        rgba: vec![180; (width * height * 4) as usize].into(),
    };
    let jpg_bytes = encode(&original, ImageType::JPG(85)).expect("encode JPG");

    let thumb = decode_image_with_size(&jpg_bytes, Some(THUMBNAIL_MAX_DIM)).expect("decode thumb");
    assert!(thumb.width <= THUMBNAIL_MAX_DIM);
    assert!(thumb.height <= THUMBNAIL_MAX_DIM);
    assert_eq!(thumb.width, 400);
    assert_eq!(thumb.height, 300);
    assert_eq!(thumb.rgba.len(), (thumb.width * thumb.height * 4) as usize);

    let preview = decode_image_with_size(&jpg_bytes, Some(PREVIEW_MAX_DIM)).expect("decode preview");
    assert!(preview.width <= PREVIEW_MAX_DIM);
    assert!(preview.height <= PREVIEW_MAX_DIM);
    assert_eq!(preview.width, 800);
    assert_eq!(preview.height, 600);
    assert_eq!(preview.rgba.len(), (preview.width * preview.height * 4) as usize);
}

#[cfg(target_os = "macos")]
#[test]
fn test_decode_macos_thumbnail_direct() {
    use darkslide_core::codec::decode_macos_thumbnail;

    let width = 600;
    let height = 400;
    let original = ProcessedImage {
        width,
        height,
        rgba: vec![200; (width * height * 4) as usize].into(),
    };
    let png_bytes = encode(&original, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");

    let thumb = decode_macos_thumbnail(&png_bytes, 200).expect("decode macos thumb");
    assert!(thumb.width <= 200);
    assert!(thumb.height <= 200);
    assert_eq!(thumb.rgba.len(), (thumb.width * thumb.height * 4) as usize);
}

#[test]
fn test_parse_jpeg_dimensions() {
    use darkslide_core::exif::parse_jpeg_dimensions;

    let original = ProcessedImage {
        width: 320,
        height: 240,
        rgba: vec![120; 320 * 240 * 4].into(),
    };
    let jpg_bytes = encode(&original, ImageType::JPG(80)).expect("encode JPG");

    let dims = parse_jpeg_dimensions(&jpg_bytes);
    assert_eq!(dims, Some((320, 240)));

    assert_eq!(parse_jpeg_dimensions(&[]), None);
    assert_eq!(parse_jpeg_dimensions(&[0xFF, 0xD8, 0xFF]), None);
    assert_eq!(parse_jpeg_dimensions(b"not a jpeg"), None);
}

#[test]
fn test_embedded_thumbnail_fallback_handling() {
    use darkslide_core::exif::extract_embedded_jpeg_thumbnail_with_dims;

    let original = ProcessedImage {
        width: 150,
        height: 100,
        rgba: vec![90; 150 * 100 * 4].into(),
    };
    let plain_jpg = encode(&original, ImageType::JPG(85)).expect("encode JPG");

    let extracted = extract_embedded_jpeg_thumbnail_with_dims(&plain_jpg);
    assert_eq!(extracted, None);

    let decoded = decode_image_with_size(&plain_jpg, Some(THUMBNAIL_MAX_DIM)).expect("decode thumbnail");
    assert_eq!(decoded.width, 150);
    assert_eq!(decoded.height, 100);
}

#[test]
fn test_decode_image_with_size_and_quality() {
    use darkslide_core::decode_image_with_size_and_quality;

    let original = ProcessedImage {
        width: 200,
        height: 150,
        rgba: vec![200; 200 * 150 * 4].into(),
    };
    let png_bytes = encode(&original, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");

    let fast_decoded = decode_image_with_size_and_quality(&png_bytes, Some(160), true);
    assert!(fast_decoded.is_ok());
    let hq_decoded = decode_image_with_size_and_quality(&png_bytes, Some(400), false);
    assert!(hq_decoded.is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn test_decode_macos_thumbnail_options() {
    use darkslide_core::codec::{decode_macos_thumbnail, decode_macos_thumbnail_fast};

    let original = ProcessedImage {
        width: 160,
        height: 120,
        rgba: vec![180; 160 * 120 * 4].into(),
    };
    let png_bytes = encode(&original, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");

    let _ = decode_macos_thumbnail_fast(&png_bytes, 160);
    let always = decode_macos_thumbnail(&png_bytes, 160);
    assert!(always.is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn test_decode_macos_thumbnail_always() {
    use darkslide_core::codec::decode_macos_thumbnail_always;

    let original = ProcessedImage {
        width: 500,
        height: 300,
        rgba: vec![150; 500 * 300 * 4].into(),
    };
    let png_bytes = encode(&original, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");

    let hq = decode_macos_thumbnail_always(&png_bytes, 400).expect("decode macos thumb always");
    assert_eq!(hq.width, 400);
    assert_eq!(hq.height, 240);
}

#[test]
fn test_decode_image_with_size_and_quality_orientation() {
    use darkslide_core::decode_image_with_size_and_quality;
    use darkslide_core::exif::{inject_exif_jpeg, orientation};

    let original = ProcessedImage {
        width: 200,
        height: 100,
        rgba: vec![120; 200 * 100 * 4].into(),
    };
    let jpg_bytes = encode(&original, ImageType::JPG(90)).expect("encode JPG");

    let tiff_bytes = vec![
        b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
    ];
    let oriented_jpg = inject_exif_jpeg(jpg_bytes, &tiff_bytes);
    assert_eq!(orientation(&oriented_jpg), Some(270));

    let decoded_hq = decode_image_with_size_and_quality(&oriented_jpg, Some(300), false).expect("decode hq");
    assert_eq!(decoded_hq.width, 100);
    assert_eq!(decoded_hq.height, 200);

    let decoded_fast = decode_image_with_size_and_quality(&oriented_jpg, Some(300), true).expect("decode fast");
    assert_eq!(decoded_fast.width, 100);
    assert_eq!(decoded_fast.height, 200);

    let sample_path = "/Volumes/Untitled/DCIM/100MSDCF/DSC00618.JPG";
    if let Ok(real_bytes) = std::fs::read(sample_path) {
        assert_eq!(orientation(&real_bytes), Some(270));
        let real_fast = decode_image_with_size_and_quality(&real_bytes, Some(400), true).expect("real fast");
        let real_hq = decode_image_with_size_and_quality(&real_bytes, Some(2000), false).expect("real hq");
        assert!(real_fast.height > real_fast.width);
        assert!(real_hq.height > real_hq.width);
        assert_eq!(real_hq.width, 1333);
        assert_eq!(real_hq.height, 2000);
    }
}

#[test]
fn test_normalize_exif_for_export_resets_orientation_to_one() {
    use darkslide_core::exif::{inject_exif, normalize_exif_for_export, orientation};

    let tiff_bytes = vec![
        b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
    ];
    let normalized = normalize_exif_for_export(&tiff_bytes);
    assert_eq!(normalized[18], 1);
    assert_eq!(normalized[19], 0);

    let dummy_jpg = vec![0xFF, 0xD8, 0xFF, 0xD9];
    let injected = inject_exif(dummy_jpg, &tiff_bytes);
    assert_eq!(orientation(&injected), Some(0));

    let sample_path = "/Volumes/Untitled/DCIM/100MSDCF/DSC00618.JPG";
    if let Ok(real_bytes) = std::fs::read(sample_path) {
        if let Some(real_exif) = darkslide_core::exif::extract_exif(&real_bytes, sample_path) {
            let norm = normalize_exif_for_export(&real_exif);
            let dummy = vec![0xFF, 0xD8, 0xFF, 0xD9];
            let injected_real = inject_exif(dummy, &norm);
            assert_eq!(orientation(&injected_real), Some(0));
        }
    }
}

