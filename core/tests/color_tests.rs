use darkslide_core::color::auto_wb::{AutoWb, auto_white_balance};
use darkslide_core::color::curve::{build_curve_lut, is_linear_curve};
use darkslide_core::color::hsl::{apply_hsl_pixel, hsl_to_rgb, rgb_to_hsl};
use darkslide_core::color::lut::{
    apply_tonal, build_3d_luts, build_identity_3d_lut, parse_cube_lut, wb_gains,
};
use darkslide_core::exif::AsShotWb;
use darkslide_core::types::{Adjustments, Color, CurvePoint, ProcessedImage};

#[test]
fn test_identity_curve() {
    let default_curve = vec![
        CurvePoint { x: 0.0, y: 0.0 },
        CurvePoint { x: 255.0, y: 255.0 },
    ];
    assert!(is_linear_curve(&default_curve));
    let lut = build_curve_lut(&default_curve);
    for i in 0..256 {
        assert_eq!(lut[i], i as u8);
    }
}

#[test]
fn test_inverted_curve() {
    let inverted = vec![
        CurvePoint { x: 0.0, y: 255.0 },
        CurvePoint { x: 255.0, y: 0.0 },
    ];
    assert!(!is_linear_curve(&inverted));
    let lut = build_curve_lut(&inverted);
    assert_eq!(lut[0], 255);
    assert_eq!(lut[255], 0);
}

#[test]
fn test_rgb_hsl_roundtrip() {
    let colors = [
        (1.0, 0.0, 0.0), // red
        (0.0, 1.0, 0.0), // green
        (0.0, 0.0, 1.0), // blue
        (0.5, 0.5, 0.5), // gray
        (1.0, 1.0, 1.0), // white
        (0.0, 0.0, 0.0), // black
    ];

    for (r, g, b) in colors {
        let (h, s, l) = rgb_to_hsl(r, g, b);
        let (r2, g2, b2) = hsl_to_rgb(h, s, l);
        assert!((r - r2).abs() < 1e-4, "r mismatch for ({r}, {g}, {b})");
        assert!((g - g2).abs() < 1e-4, "g mismatch for ({r}, {g}, {b})");
        assert!((b - b2).abs() < 1e-4, "b mismatch for ({r}, {g}, {b})");
    }
}

#[test]
fn test_apply_hsl_pixel_zero_shift() {
    let (r, g, b) = (0.8, 0.4, 0.2);
    let (r2, g2, b2) = apply_hsl_pixel(r, g, b, 0.0, 1.0, 0.0);
    assert!((r - r2).abs() < 1e-4);
    assert!((g - g2).abs() < 1e-4);
    assert!((b - b2).abs() < 1e-4);
}

#[test]
fn test_identity_3d_lut_dimensions() {
    let size = 17;
    let lut = build_identity_3d_lut(size);
    assert_eq!(lut.len(), size * size * size * 4);
    // First entry: (0, 0, 0, 1)
    assert_eq!(&lut[0..4], &[0.0, 0.0, 0.0, 1.0]);
    // Last entry: (1, 1, 1, 1)
    let last = lut.len() - 4;
    assert_eq!(&lut[last..], &[1.0, 1.0, 1.0, 1.0]);
}

#[test]
fn test_build_3d_luts_default_adjustments() {
    let adj = Adjustments::default();
    let lut = build_3d_luts(&adj, 17);
    assert_eq!(lut.len(), 17 * 17 * 17 * 4);
}

#[test]
fn test_parse_cube_lut() {
    let cube_content = r#"
# Sample CUBE
TITLE "TestLUT"
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
"#;
    let meta = parse_cube_lut(cube_content).expect("parse cube lut");
    assert_eq!(meta.name, "TestLUT");
    assert_eq!(meta.size, 2);
    assert_eq!(meta.values.len(), 2 * 2 * 2 * 4);
}

#[test]
fn test_parse_m31_cube_lut() {
    let path = std::path::Path::new("../test_fixtures/luts/M31 - Rec709.cube");
    if path.exists() {
        let content = std::fs::read_to_string(path).expect("read m31 lut");
        let meta = parse_cube_lut(&content).expect("parse m31 lut");
        assert_eq!(meta.name, "M31 - Rec.709_32");
        assert_eq!(meta.size, 32);
        assert_eq!(meta.values.len(), 32 * 32 * 32 * 4);
    }
}

#[test]
fn test_wb_gains_neutral_is_identity() {
    let color = Color {
        temperature: 0,
        tint: 0,
    };
    let (r, g, b) = wb_gains(&color, &AsShotWb::default());
    assert!((r - 1.0).abs() < 1e-6);
    assert!((g - 1.0).abs() < 1e-6);
    assert!((b - 1.0).abs() < 1e-6);
}

#[test]
fn test_wb_gains_temperature_direction() {
    let wb = AsShotWb::default();
    let warm = wb_gains(
        &Color {
            temperature: 100,
            tint: 0,
        },
        &wb,
    );
    let cool = wb_gains(
        &Color {
            temperature: -100,
            tint: 0,
        },
        &wb,
    );
    assert!(warm.0 > 1.0 && warm.2 < 1.0, "positive temp should warm");
    assert!(cool.0 < 1.0 && cool.2 > 1.0, "negative temp should cool");
}

#[test]
fn test_wb_gains_tint_direction() {
    let wb = AsShotWb::default();
    let magenta = wb_gains(
        &Color {
            temperature: 0,
            tint: 100,
        },
        &wb,
    );
    let green = wb_gains(
        &Color {
            temperature: 0,
            tint: -100,
        },
        &wb,
    );
    assert!(magenta.1 < 1.0, "positive tint pushes magenta (less green)");
    assert!(green.1 > 1.0, "negative tint pushes green");
}

#[test]
fn test_wb_gains_use_as_shot_kelvin_baseline() {
    // A 3000K (warm) as-shot illuminant needs a blue boost / red cut.
    let wb = AsShotWb {
        kelvin: Some(3000),
        neutral_rgb: None,
    };
    let (r, _g, b) = wb_gains(
        &Color {
            temperature: 0,
            tint: 0,
        },
        &wb,
    );
    assert!(r < 1.0, "warm illuminant should reduce red gain: {r}");
    assert!(b > 1.0, "warm illuminant should boost blue gain: {b}");
}

#[test]
fn test_wb_gains_use_as_shot_neutral_reciprocal() {
    let wb = AsShotWb {
        kelvin: None,
        neutral_rgb: Some([2.0, 1.0, 0.5]),
    };
    let (r, _g, b) = wb_gains(
        &Color {
            temperature: 0,
            tint: 0,
        },
        &wb,
    );
    assert!((r - 0.5).abs() < 1e-6, "reciprocal of R neutral: {r}");
    assert!((b - 2.0).abs() < 1e-6, "reciprocal of B neutral: {b}");
}

#[test]
fn test_wb_gains_combine_as_shot_and_relative() {
    let wb = AsShotWb {
        kelvin: None,
        neutral_rgb: Some([2.0, 1.0, 0.5]),
    };
    let (r, g, b) = wb_gains(
        &Color {
            temperature: 100,
            tint: 0,
        },
        &wb,
    );
    // base (0.5, 1, 2) times relative temp +100 (×1.5 R, ×0.5 B).
    assert!((r - 0.5 * 1.5).abs() < 1e-6, "r={r}");
    assert!((g - 1.0).abs() < 1e-6, "g={g}");
    assert!((b - 2.0 * 0.5).abs() < 1e-6, "b={b}");
}

#[test]
fn test_build_3d_luts_default_is_identity_at_grid() {
    let adj = Adjustments::default();
    let lut = build_3d_luts(&adj, 17);
    let mut idx = 0;
    for b in 0..17usize {
        for g in 0..17usize {
            for r in 0..17usize {
                let expected = [r as f32 / 16.0, g as f32 / 16.0, b as f32 / 16.0];
                for (c, exp) in expected.iter().enumerate() {
                    assert!(
                        (lut[idx + c] - exp).abs() < 1e-4,
                        "channel {c} at r={r},g={g},b={b}: {} vs {exp}",
                        lut[idx + c]
                    );
                }
                idx += 4;
            }
        }
    }
}

fn solid_image(r: u8, g: u8, b: u8, n: usize) -> ProcessedImage {
    let mut data = Vec::with_capacity(n * 4);
    for _ in 0..n {
        data.extend_from_slice(&[r, g, b, 255]);
    }
    ProcessedImage::new(n as u32, 1, data)
}

#[test]
fn test_auto_wb_neutral_image_is_zero() {
    let img = solid_image(128, 128, 128, 64);
    assert_eq!(
        auto_white_balance(&img, &AsShotWb::default()),
        AutoWb {
            temperature: 0,
            tint: 0
        }
    );
}

#[test]
fn test_auto_wb_warm_cast_cools() {
    let img = solid_image(180, 100, 80, 64);
    let wb = auto_white_balance(&img, &AsShotWb::default());
    assert!(wb.temperature < 0, "warm cast should cool: {wb:?}");
}

#[test]
fn test_auto_wb_green_cast_pushes_magenta() {
    let img = solid_image(100, 150, 100, 64);
    let wb = auto_white_balance(&img, &AsShotWb::default());
    assert!(wb.tint > 0, "green cast should push magenta: {wb:?}");
}

#[test]
fn test_auto_wb_accounts_for_as_shot_base() {
    // Mild warm cast.
    let img = solid_image(140, 110, 100, 64);
    let as_shot = AsShotWb {
        kelvin: None,
        neutral_rgb: Some([0.9, 1.0, 1.15]),
    };
    let wb = auto_white_balance(&img, &as_shot);

    // Applying the returned offsets on top of the as-shot base must make the
    // applied R/B gain ratio match the gray-world target ratio.
    let (ar, _ag, ab) = wb_gains(
        &Color {
            temperature: wb.temperature,
            tint: wb.tint,
        },
        &as_shot,
    );
    let applied = ar / ab;
    let target = (110.0 / 140.0) / (110.0 / 100.0);
    assert!(
        (applied - target).abs() < 0.02,
        "applied {applied} vs target {target} (wb={wb:?})"
    );
}

fn adj_with(f: impl FnOnce(&mut Adjustments)) -> Adjustments {
    let mut adj = Adjustments::default();
    f(&mut adj);
    adj
}

#[test]
fn test_apply_tonal_default_identity() {
    let adj = Adjustments::default();
    for i in 0..=100 {
        let x = i as f32 / 100.0;
        assert!((apply_tonal(&adj, x) - x).abs() < 1e-5, "x={x}");
    }
}

#[test]
fn test_apply_tonal_single_controls_are_monotonic() {
    let cases = [
        adj_with(|a| a.light.exposure = 1.0),
        adj_with(|a| a.light.exposure = -1.0),
        adj_with(|a| a.light.contrast = 60),
        adj_with(|a| a.light.contrast = -60),
        adj_with(|a| a.light.highlights = -80),
        adj_with(|a| a.light.shadows = 80),
        adj_with(|a| a.light.whites = -60),
        adj_with(|a| a.light.blacks = 60),
        adj_with(|a| a.light.brightness = 60),
    ];
    for adj in cases {
        let mut prev = apply_tonal(&adj, 0.0);
        for i in 1..=200 {
            let x = i as f32 / 200.0;
            let y = apply_tonal(&adj, x);
            assert!(y >= prev - 1e-5, "non-monotonic {adj:?} at x={x}: {prev} -> {y}");
            prev = y;
        }
    }
}

#[test]
fn test_apply_tonal_exposure_direction() {
    let up = adj_with(|a| a.light.exposure = 1.0);
    let down = adj_with(|a| a.light.exposure = -1.0);
    assert!(apply_tonal(&up, 0.5) > 0.5);
    assert!(apply_tonal(&down, 0.5) < 0.5);
}

#[test]
fn test_apply_tonal_contrast_endpoints_and_direction() {
    let adj = adj_with(|a| a.light.contrast = 60);
    assert!(apply_tonal(&adj, 0.0).abs() < 1e-4);
    assert!((apply_tonal(&adj, 1.0) - 1.0).abs() < 1e-4);
    assert!(apply_tonal(&adj, 0.25) < 0.25);
    assert!(apply_tonal(&adj, 0.75) > 0.75);
}

#[test]
fn test_apply_tonal_shadow_and_highlight_direction() {
    let shadows = adj_with(|a| a.light.shadows = 50);
    let highlights = adj_with(|a| a.light.highlights = 50);
    assert!(apply_tonal(&shadows, 0.1) > 0.1);
    assert!(apply_tonal(&highlights, 0.9) > 0.9);
}

/// Grid index for the (r, g, b) = (8, 8, 8) node of a 17³ cube.
fn mid_grid_index() -> usize {
    ((8 * 17 + 8) * 17 + 8) * 4
}

#[test]
fn test_red_curve_leaves_green_and_blue_unchanged() {
    let mut adj = Adjustments::default();
    adj.curves.red = vec![
        CurvePoint { x: 0.0, y: 40.0 },
        CurvePoint { x: 255.0, y: 255.0 },
    ];
    let lut = build_3d_luts(&adj, 17);
    let idx = mid_grid_index();

    assert!(lut[idx] > 0.5 + 1e-3, "red curve should lift red: {}", lut[idx]);
    assert!((lut[idx + 1] - 0.5).abs() < 1e-4, "green untouched: {}", lut[idx + 1]);
    assert!((lut[idx + 2] - 0.5).abs() < 1e-4, "blue untouched: {}", lut[idx + 2]);
}

#[test]
fn test_master_curve_affects_all_channels() {
    let mut adj = Adjustments::default();
    adj.curves.rgb = vec![
        CurvePoint { x: 0.0, y: 40.0 },
        CurvePoint { x: 255.0, y: 255.0 },
    ];
    let lut = build_3d_luts(&adj, 17);
    let idx = mid_grid_index();
    for c in 0..3 {
        assert!(lut[idx + c] > 0.5 + 1e-3, "channel {c} lifted by master curve");
    }
}
