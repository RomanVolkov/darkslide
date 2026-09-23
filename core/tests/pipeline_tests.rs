use std::env;
use std::fs;
use std::path::Path;

use darkslide_core::decode_image;
use darkslide_core::encode;
use darkslide_core::gpu::GpuState;
use darkslide_core::pipeline::{render_gpu, render_gpu_batch};
use darkslide_core::types::{Adjustments, ImageType, PngCompressionLevel, ProcessedImage};


fn load_fixture_image() -> ProcessedImage {
    let candidate_paths = [
        "../test_fixtures/images/034524DD-046C-4457-B64D-03A2F69A9A19.jpg",
        "test_fixtures/images/034524DD-046C-4457-B64D-03A2F69A9A19.jpg",
    ];
    let path = candidate_paths
        .iter()
        .find(|p| Path::new(p).exists())
        .expect("Test fixture image not found");

    let raw = fs::read(path).expect("Failed to read fixture image");
    decode_image(&raw).expect("Failed to decode fixture image")
}

fn maybe_dump_image(name: &str, img: &ProcessedImage) {
    if let Ok(dump_dir) = env::var("DUMP_TEST_IMAGES") {
        let dir = if dump_dir.is_empty() {
            "target/test_output"
        } else {
            &dump_dir
        };
        fs::create_dir_all(dir).ok();
        let encoded = encode(img, ImageType::PNG(PngCompressionLevel::Fast)).expect("encode PNG");
        let out_path = format!("{dir}/{name}.png");
        fs::write(&out_path, encoded).expect("write dumped test image");
    }
}

#[test]
fn test_gpu_state_init_and_error_display() {
    use darkslide_core::GpuInitError;
    let res = GpuState::init();
    assert!(res.is_ok());

    let err1 = GpuInitError::NoCompatibleAdapter;
    assert!(err1.to_string().contains("No compatible GPU adapter"));

    let err2 = GpuInitError::DeviceCreationFailed("test device failure".to_string());
    assert!(err2.to_string().contains("test device failure"));
}

#[test]
fn test_pipeline_render_fixture_default() {
    let base = load_fixture_image();
    let adj = Adjustments::default();
    let gpu = GpuState::init().expect("gpu init");

    let rendered = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(rendered.width, base.width);
    assert_eq!(rendered.height, base.height);
    assert_eq!(rendered.rgba.len(), (base.width * base.height * 4) as usize);

    maybe_dump_image("fixture_default", &rendered);
}

#[test]
fn test_pipeline_render_fixture_adjustments() {
    let base = load_fixture_image();
    let mut adj = Adjustments::default();
    adj.light.exposure = 1.5;
    adj.light.contrast = 25;
    adj.color.temperature = 25;
    adj.detail.texture = 30;
    adj.detail.clarity = 20;
    adj.detail.sharpen.amount = 40;
    adj.detail.sharpen.radius = 20;
    adj.detail.grain.amount = 25;

    let gpu = GpuState::init().expect("gpu init");
    let rendered = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(rendered.width, base.width);
    assert_eq!(rendered.height, base.height);
    assert_eq!(rendered.rgba.len(), (base.width * base.height * 4) as usize);

    maybe_dump_image("fixture_adjusted", &rendered);
}

#[test]
fn test_pipeline_render_fixture_rotation() {
    let base = load_fixture_image();
    let mut adj = Adjustments::default();
    adj.rotation = 90;

    let gpu = GpuState::init().expect("gpu init");
    let rendered = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(rendered.width, base.height);
    assert_eq!(rendered.height, base.width);

    maybe_dump_image("fixture_rotated_90", &rendered);
}

#[test]
fn test_pipeline_render_synthetic_buffer() {
    let gpu = GpuState::init().expect("gpu init");
    let base = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };

    let mut adj = Adjustments::default();
    adj.light.exposure = 1.0;
    adj.color.temperature = 50;

    let rendered = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(rendered.width, 4);
    assert_eq!(rendered.height, 4);
    assert_eq!(rendered.rgba.len(), 4 * 4 * 4);
}

#[test]
fn test_pipeline_render_with_external_lut() {
    use darkslide_core::Lut3d;
    use darkslide_core::color::lut::IDENTITY_3D_LUT_2;

    let gpu = GpuState::init().expect("gpu init");
    let base = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };

    let mut adj = Adjustments::default();
    adj.lut_id = Some(1);
    adj.lut_intensity = 80;

    let external_lut = Lut3d::new(IDENTITY_3D_LUT_2.to_vec(), 2, 0.8);

    let rendered = render_gpu(&base, &adj, &gpu, Some(external_lut));
    assert_eq!(rendered.width, 4);
    assert_eq!(rendered.height, 4);
    assert_eq!(rendered.rgba.len(), 4 * 4 * 4);
}

#[test]
fn test_pipeline_render_gpu_batch_matches_sequential() {
    let gpu = GpuState::init().expect("gpu init");
    let base = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };

    let mut adj1 = Adjustments::default();
    adj1.light.exposure = 1.0;
    adj1.color.temperature = 50;

    let mut adj2 = Adjustments::default();
    adj2.detail.texture = 30;
    adj2.detail.clarity = 20;
    adj2.detail.sharpen.amount = 40;
    adj2.detail.sharpen.radius = 20;

    let mut adj3 = Adjustments::default();
    adj3.rotation = 90;

    let items = vec![
        (base.clone(), adj1.clone(), None),
        (base.clone(), adj2.clone(), None),
        (base.clone(), adj3.clone(), None),
    ];

    let batch_receivers = render_gpu_batch(items, &gpu);
    let batch_results: Vec<_> = batch_receivers.into_iter().map(|rx| rx.recv().unwrap()).collect();

    let seq1 = render_gpu(&base, &adj1, &gpu, None);
    let seq2 = render_gpu(&base, &adj2, &gpu, None);
    let seq3 = render_gpu(&base, &adj3, &gpu, None);

    assert_eq!(batch_results[0].rgba, seq1.rgba);
    assert_eq!(batch_results[1].rgba, seq2.rgba);
    assert_eq!(batch_results[2].rgba, seq3.rgba);
    assert_eq!(batch_results[2].width, seq3.width);
    assert_eq!(batch_results[2].height, seq3.height);
}

#[test]
fn test_identity_lut_is_reused() {
    use darkslide_core::Lut3d;
    use darkslide_core::color::lut::identity_3d_lut_2_arc;
    use std::sync::Arc;

    let id1 = Arc::as_ptr(&identity_3d_lut_2_arc());
    let id2 = Arc::as_ptr(&identity_3d_lut_2_arc());
    assert_eq!(id1, id2);

    let lut = Lut3d::from_arc(identity_3d_lut_2_arc(), 2, 0.0);
    assert_eq!(Arc::as_ptr(&lut.data), id1);
}

#[test]
fn test_pipeline_render_gpu_batch_with_external_lut() {
    use darkslide_core::Lut3d;
    use darkslide_core::color::lut::IDENTITY_3D_LUT_2;

    let gpu = GpuState::init().expect("gpu init");
    let base = ProcessedImage {
        width: 4,
        height: 4,
        rgba: vec![128; 4 * 4 * 4].into(),
    };

    let mut adj = Adjustments::default();
    adj.lut_id = Some(1);
    adj.lut_intensity = 80;

    let external_lut = Lut3d::new(IDENTITY_3D_LUT_2.to_vec(), 2, 0.8);

    let items = vec![
        (base.clone(), adj.clone(), Some(external_lut.clone())),
        (base.clone(), adj.clone(), Some(external_lut.clone())),
    ];

    let batch_receivers = render_gpu_batch(items, &gpu);
    let batch_results: Vec<_> = batch_receivers.into_iter().map(|rx| rx.recv().unwrap()).collect();

    let seq = render_gpu(&base, &adj, &gpu, Some(external_lut));

    assert_eq!(batch_results[0].rgba, seq.rgba);
    assert_eq!(batch_results[1].rgba, seq.rgba);
}
#[test]
fn test_pipeline_render_gpu_grain_effect() {
    let gpu = GpuState::init().expect("gpu init");
    let base = ProcessedImage {
        width: 16,
        height: 16,
        rgba: vec![128; 16 * 16 * 4].into(),
    };

    let adj_none = Adjustments::default();
    let mut adj_grain = Adjustments::default();
    adj_grain.detail.grain.amount = 50;
    adj_grain.detail.grain.size = 25;
    adj_grain.detail.grain.roughness = 50;

    let rendered_none = render_gpu(&base, &adj_none, &gpu, None);
    let rendered_grain = render_gpu(&base, &adj_grain, &gpu, None);

    assert_eq!(rendered_none.width, rendered_grain.width);
    assert_eq!(rendered_none.height, rendered_grain.height);
    assert_ne!(rendered_none.rgba, rendered_grain.rgba);

    for (i, &b) in rendered_grain.rgba.iter().enumerate() {
        if i % 4 == 3 {
            assert_eq!(b, 255);
        }
    }
}

#[test]
fn test_pipeline_render_gpu_filter_passes() {
    let gpu = GpuState::init().expect("gpu init");
    let mut pixels = Vec::with_capacity(32 * 32 * 4);
    for y in 0..32 {
        for x in 0..32 {
            let val = ((x * 8 + y * 8) % 256) as u8;
            pixels.extend_from_slice(&[val, val, val, 255]);
        }
    }
    let base = ProcessedImage {
        width: 32,
        height: 32,
        rgba: pixels.into(),
    };

    let adj_default = Adjustments::default();
    let rendered_default = render_gpu(&base, &adj_default, &gpu, None);

    let mut adj_texture = Adjustments::default();
    adj_texture.detail.texture = 50;
    let rendered_texture = render_gpu(&base, &adj_texture, &gpu, None);
    assert_ne!(rendered_texture.rgba, rendered_default.rgba);

    let mut adj_clarity = Adjustments::default();
    adj_clarity.detail.clarity = 50;
    let rendered_clarity = render_gpu(&base, &adj_clarity, &gpu, None);
    assert_ne!(rendered_clarity.rgba, rendered_default.rgba);

    let mut adj_sharpen = Adjustments::default();
    adj_sharpen.detail.sharpen.amount = 60;
    adj_sharpen.detail.sharpen.radius = 30;
    let rendered_sharpen = render_gpu(&base, &adj_sharpen, &gpu, None);
    assert_ne!(rendered_sharpen.rgba, rendered_default.rgba);

    for rendered in [&rendered_texture, &rendered_clarity, &rendered_sharpen] {
        assert_eq!(rendered.width, base.width);
        assert_eq!(rendered.height, base.height);
        for (i, &b) in rendered.rgba.iter().enumerate() {
            if i % 4 == 3 {
                assert_eq!(b, 255);
            }
        }
    }
}

#[test]
fn test_pipeline_render_gpu_denoise_reduces_variance() {
    let gpu = GpuState::init().expect("gpu init");

    // Noisy flat field: checkerboard between two mid-gray values.
    let mut pixels = Vec::with_capacity(32 * 32 * 4);
    for y in 0..32 {
        for x in 0..32 {
            let val = if (x + y) % 2 == 0 { 100u8 } else { 156u8 };
            pixels.extend_from_slice(&[val, val, val, 255]);
        }
    }
    let base = ProcessedImage {
        width: 32,
        height: 32,
        rgba: pixels.into(),
    };

    let adj_default = Adjustments::default();
    let rendered_default = render_gpu(&base, &adj_default, &gpu, None);

    let mut adj_denoise = Adjustments::default();
    adj_denoise.detail.denoise.strength = 80;
    adj_denoise.detail.denoise.preserve = 0;
    let rendered_denoise = render_gpu(&base, &adj_denoise, &gpu, None);

    assert_eq!(rendered_denoise.width, base.width);
    assert_eq!(rendered_denoise.height, base.height);
    assert_ne!(rendered_denoise.rgba, rendered_default.rgba);

    let variance = |rgba: &[u8]| -> f64 {
        let values: Vec<f64> = rgba.chunks_exact(4).map(|p| p[0] as f64).collect();
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64
    };
    assert!(
        variance(&rendered_denoise.rgba) < variance(&rendered_default.rgba),
        "denoise should reduce variance: {} vs {}",
        variance(&rendered_denoise.rgba),
        variance(&rendered_default.rgba)
    );
}

fn synthetic_gradient(w: u32, h: u32) -> ProcessedImage {
    let mut pixels = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let r = (x * 255 / w.max(1)) as u8;
            let g = (y * 255 / h.max(1)) as u8;
            let b = ((x + y) % 256) as u8;
            pixels.extend_from_slice(&[r, g, b, 255]);
        }
    }
    ProcessedImage {
        width: w,
        height: h,
        rgba: pixels.into(),
    }
}

#[test]
fn test_geometry_output_size_pure() {
    use darkslide_core::gpu::geometry_output_size;
    use darkslide_core::types::Geometry;

    let identity = Geometry::default();
    assert_eq!(geometry_output_size(32, 24, &identity), (32, 24));

    let zoomed = Geometry {
        zoom: 2.0,
        ..Geometry::default()
    };
    assert_eq!(geometry_output_size(32, 24, &zoomed), (16, 12));

    let rotated = Geometry {
        straighten: 90.0,
        ..Geometry::default()
    };
    // Largest 4:3 rect inside the 24x32 rotated image -> 24x18.
    assert_eq!(geometry_output_size(32, 24, &rotated), (24, 18));
}

#[test]
fn test_geometry_identity_is_unchanged() {
    let gpu = GpuState::init().expect("gpu init");
    let base = synthetic_gradient(32, 24);
    let adj = Adjustments::default();
    let out = render_gpu(&base, &adj, &gpu, None);
    assert_eq!((out.width, out.height), (32, 24));
    assert_eq!(out.rgba.len(), (32 * 24 * 4) as usize);
}

#[test]
fn test_geometry_zoom_halves_dimensions() {
    let gpu = GpuState::init().expect("gpu init");
    let base = synthetic_gradient(32, 24);
    let mut adj = Adjustments::default();
    adj.geometry.zoom = 2.0;
    let out = render_gpu(&base, &adj, &gpu, None);
    assert_eq!((out.width, out.height), (16, 12));
    assert_eq!(out.rgba.len(), (16 * 12 * 4) as usize);
}

#[test]
fn test_geometry_straighten_keeps_aspect_and_is_bounded() {
    let gpu = GpuState::init().expect("gpu init");
    let base = synthetic_gradient(32, 24);
    let mut adj = Adjustments::default();
    adj.geometry.straighten = 10.0;
    let out = render_gpu(&base, &adj, &gpu, None);

    assert!(out.width < 32 && out.height < 24);
    let aspect = out.width as f32 / out.height as f32;
    assert!((aspect - 32.0 / 24.0).abs() < 0.2, "aspect {aspect}");
    for (i, &b) in out.rgba.iter().enumerate() {
        if i % 4 == 3 {
            assert_eq!(b, 255);
        }
    }
}

#[test]
fn test_geometry_batch_matches_sequential() {    let gpu = GpuState::init().expect("gpu init");
    let base = synthetic_gradient(32, 24);
    let mut adj = Adjustments::default();
    adj.geometry.zoom = 1.5;
    adj.geometry.straighten = 5.0;

    let items = vec![(base.clone(), adj.clone(), None)];
    let batch: Vec<_> = render_gpu_batch(items, &gpu)
        .into_iter()
        .map(|rx| rx.recv().unwrap())
        .collect();
    let seq = render_gpu(&base, &adj, &gpu, None);

    assert_eq!(batch[0].width, seq.width);
    assert_eq!(batch[0].height, seq.height);
    assert_eq!(batch[0].rgba, seq.rgba);
}

fn bright_gradient(w: u32, h: u32) -> ProcessedImage {
    // Every channel is at least 40 so any fully-black output pixel would mean
    // an uncovered region (fill-mode violation).
    let mut pixels = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let r = 40 + (x * 200 / w.max(1)) as u8;
            let g = 60 + (y * 180 / h.max(1)) as u8;
            let b = 80 + (((x + y) % w.max(1)) * 160 / w.max(1)) as u8;
            pixels.extend_from_slice(&[r, g, b, 255]);
        }
    }
    ProcessedImage {
        width: w,
        height: h,
        rgba: pixels.into(),
    }
}

#[test]
fn test_geometry_crop_pans_content_and_fills() {
    let gpu = GpuState::init().expect("gpu init");
    let base = bright_gradient(32, 24);

    let mut left = Adjustments::default();
    left.geometry.zoom = 2.0;
    left.geometry.crop_x = -0.5;
    let mut right = Adjustments::default();
    right.geometry.zoom = 2.0;
    right.geometry.crop_x = 0.5;

    let a = render_gpu(&base, &left, &gpu, None);
    let b = render_gpu(&base, &right, &gpu, None);

    assert_eq!((a.width, a.height), (b.width, b.height));
    assert_ne!(a.rgba, b.rgba, "panning crop_x should change the output");

    // Fill-mode: every output pixel samples real source content (no black).
    for (i, px) in a.rgba.chunks_exact(4).enumerate() {
        assert!(
            !(px[0] == 0 && px[1] == 0 && px[2] == 0),
            "uncovered (black) pixel at {i}"
        );
    }
}

#[test]
fn test_geometry_perspective_and_distortion_pipeline() {
    let gpu = GpuState::init().expect("gpu init");
    let base = synthetic_gradient(32, 24);

    let mut adj = Adjustments::default();
    adj.geometry.perspective_v = 15.0;
    adj.geometry.perspective_h = -10.0;
    adj.geometry.distortion = 25.0;

    let out = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(out.width, base.width);
    assert_eq!(out.height, base.height);
    for (i, &b) in out.rgba.iter().enumerate() {
        if i % 4 == 3 {
            assert_eq!(b, 255);
        }
    }
    let ident = render_gpu(&base, &Adjustments::default(), &gpu, None);
    assert_ne!(out.rgba, ident.rgba);
}

#[test]
fn test_color_balance_shadows_and_highlights() {
    use darkslide_core::color::{apply_color_balance_pixel, build_3d_luts};
    use darkslide_core::types::ColorBalance;

    let mut cb = ColorBalance::default();
    // Tint shadows towards red (0 deg), highlights towards blue (240 deg)
    cb.shadows.hue = 0.0;
    cb.shadows.saturation = 80.0;
    cb.highlights.hue = 240.0;
    cb.highlights.saturation = 80.0;

    let shadow_in = (0.1, 0.1, 0.1);
    let shadow_out = apply_color_balance_pixel(shadow_in.0, shadow_in.1, shadow_in.2, &cb);
    // Shadows should have more red than green/blue
    assert!(shadow_out.0 > shadow_out.1, "shadow red > green: {:?}", shadow_out);
    assert!(shadow_out.0 > shadow_out.2, "shadow red > blue: {:?}", shadow_out);

    let highlight_in = (0.9, 0.9, 0.9);
    let highlight_out = apply_color_balance_pixel(highlight_in.0, highlight_in.1, highlight_in.2, &cb);
    // Highlights should have more blue than red/green
    assert!(highlight_out.2 > highlight_out.0, "highlight blue > red: {:?}", highlight_out);
    assert!(highlight_out.2 > highlight_out.1, "highlight blue > green: {:?}", highlight_out);

    // Verify build_3d_luts integrates color balance
    let mut adj = Adjustments::default();
    adj.color_balance = cb;
    let lut = build_3d_luts(&adj, 16);
    let ident_lut = build_3d_luts(&Adjustments::default(), 16);
    assert_ne!(lut, ident_lut, "LUT should change with color balance");
}

#[test]
fn test_selective_color_shifts_target_hue_only() {
    use darkslide_core::color::{apply_selective_color_pixel, build_3d_luts};
    use darkslide_core::types::SelectiveColor;

    let mut sc = SelectiveColor::default();
    // Shift green saturation down by -100 (fully desaturate green)
    sc.green.saturation = -100.0;

    // Green pixel (0.1, 0.8, 0.1)
    let green_in = (0.1, 0.8, 0.1);
    let green_out = apply_selective_color_pixel(green_in.0, green_in.1, green_in.2, &sc);
    let green_delta = (green_out.1 - green_out.0).abs() + (green_out.1 - green_out.2).abs();
    let original_delta = (green_in.1 - green_in.0).abs() + (green_in.1 - green_in.2).abs();
    assert!(
        green_delta < original_delta,
        "green should be desaturated: in={:?}, out={:?}",
        green_in,
        green_out
    );

    // Blue pixel (0.1, 0.1, 0.9) should remain unaffected by green edit
    let blue_in = (0.1, 0.1, 0.9);
    let blue_out = apply_selective_color_pixel(blue_in.0, blue_in.1, blue_in.2, &sc);
    assert!(
        (blue_in.0 - blue_out.0).abs() < 1e-4
            && (blue_in.1 - blue_out.1).abs() < 1e-4
            && (blue_in.2 - blue_out.2).abs() < 1e-4,
        "blue should remain untouched: in={:?}, out={:?}",
        blue_in,
        blue_out
    );

    // Verify build_3d_luts integrates selective color
    let mut adj = Adjustments::default();
    adj.selective_color = sc;
    let lut = build_3d_luts(&adj, 16);
    let ident_lut = build_3d_luts(&Adjustments::default(), 16);
    assert_ne!(lut, ident_lut, "LUT should change with selective color");
}

#[test]
fn test_pipeline_render_color_grading() {
    let gpu = GpuState::init().expect("gpu init");
    let base = load_fixture_image();

    let mut adj = Adjustments::default();
    adj.color_balance.shadows.hue = 210.0;
    adj.color_balance.shadows.saturation = 40.0;
    adj.color_balance.highlights.hue = 40.0;
    adj.color_balance.highlights.saturation = 30.0;
    adj.selective_color.orange.luminance = 25.0;
    adj.selective_color.blue.saturation = 50.0;

    let rendered = render_gpu(&base, &adj, &gpu, None);
    assert_eq!(rendered.width, base.width);
    assert_eq!(rendered.height, base.height);
    assert_eq!(rendered.rgba.len(), (base.width * base.height * 4) as usize);

    let ident = render_gpu(&base, &Adjustments::default(), &gpu, None);
    assert_ne!(rendered.rgba, ident.rgba, "color grading should modify output pixels");
}




