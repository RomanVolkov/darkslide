use darkslide_core::exif::AsShotWb;
use darkslide_core::types::{Adjustments, CurvePoint, normalize_legacy_temperature};

/// A pre-migration record: absolute Kelvin temperature (6500 = neutral), the old
/// `curve` field, and no `as_shot_wb`.
const LEGACY_JSON: &str = r#"{
    "light": {"exposure":0,"contrast":0,"highlights":0,"shadows":0,"whites":0,"blacks":0,"brightness":0},
    "color": {"temperature":6500,"tint":0},
    "hsl": {"hue":0,"saturation":0,"vibrance":0},
    "detail": {"black_point":0,"texture":0,"clarity":0,"sharpen":{"amount":0,"radius":0},"grain":{"amount":0,"size":0,"roughness":0}},
    "curve": [{"x":0.0,"y":0.0},{"x":255.0,"y":255.0}],
    "rotation":0,
    "lut_id":null,
    "lut_intensity":0
}"#;

#[test]
fn legacy_json_decodes_with_defaults_and_normalized_temperature() {
    let adj: Adjustments = serde_json::from_str(LEGACY_JSON).expect("decode legacy");
    assert_eq!(adj.color.temperature, 0, "6500K legacy neutral maps to 0");
    assert_eq!(adj.as_shot_wb, AsShotWb::default());
    assert_eq!(adj.curves.rgb.len(), 2);
    assert_eq!(adj.geometry.zoom, 1.0);
    assert_eq!(adj.geometry.distortion, 0.0);
    assert_eq!(adj.geometry.perspective_v, 0.0);
    assert_eq!(adj.geometry.perspective_h, 0.0);
    assert_eq!(adj.color_balance.shadows.saturation, 0.0);
    assert_eq!(adj.color_balance.midtones.luminance, 0.0);
    assert_eq!(adj.color_balance.highlights.hue, 0.0);
    assert_eq!(adj.selective_color.red.saturation, 0.0);
    assert_eq!(adj.selective_color.blue.hue, 0.0);
}

#[test]
fn relative_temperature_is_not_migrated() {
    let json = LEGACY_JSON.replace("\"temperature\":6500", "\"temperature\":25");
    let adj: Adjustments = serde_json::from_str(&json).expect("decode relative");
    assert_eq!(adj.color.temperature, 25);
}

#[test]
fn normalize_legacy_temperature_maps_kelvin() {    assert_eq!(normalize_legacy_temperature(6500), 0);
    assert_eq!(normalize_legacy_temperature(0), 0);
    assert_eq!(normalize_legacy_temperature(100), 100);
    assert_eq!(normalize_legacy_temperature(-100), -100);
    // 7500K -> (7500-6500)/4500*100 = 22.2 -> 22
    assert_eq!(normalize_legacy_temperature(7500), 22);
    // 3000K -> (3000-6500)/4500*100 = -77.8 -> -78
    assert_eq!(normalize_legacy_temperature(3000), -78);
    // Extreme values clamp to the relative range.
    assert_eq!(normalize_legacy_temperature(100000), 100);
}

fn adjustments_hash(adj: &Adjustments) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    adj.hash(&mut hasher);
    hasher.finish()
}

#[test]
fn denoise_changes_adjustments_hash() {
    let base = Adjustments::default();
    let mut denoised = Adjustments::default();
    denoised.detail.denoise.strength = 50;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&denoised));
}

#[test]
fn per_channel_curve_changes_adjustments_hash() {
    let base = Adjustments::default();
    let mut curve = Adjustments::default();
    curve.curves.red = vec![
        CurvePoint { x: 0.0, y: 20.0 },
        CurvePoint { x: 255.0, y: 255.0 },
    ];
    assert_ne!(adjustments_hash(&base), adjustments_hash(&curve));
}

#[test]
fn geometry_defaults_are_identity() {
    let adj = Adjustments::default();
    assert_eq!(adj.geometry.straighten, 0.0);
    assert_eq!(adj.geometry.zoom, 1.0);
    assert_eq!(adj.geometry.crop_x, 0.0);
    assert_eq!(adj.geometry.crop_y, 0.0);
    assert_eq!(adj.geometry.distortion, 0.0);
    assert_eq!(adj.geometry.perspective_v, 0.0);
    assert_eq!(adj.geometry.perspective_h, 0.0);
}

#[test]
fn geometry_changes_adjustments_hash() {
    let base = Adjustments::default();
    let mut geo = Adjustments::default();
    geo.geometry.straighten = 4.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&geo));

    let mut zoom = Adjustments::default();
    zoom.geometry.zoom = 1.5;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&zoom));

    let mut dist = Adjustments::default();
    dist.geometry.distortion = 10.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&dist));

    let mut pv = Adjustments::default();
    pv.geometry.perspective_v = 5.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&pv));

    let mut ph = Adjustments::default();
    ph.geometry.perspective_h = -5.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&ph));
}

#[test]
fn color_balance_defaults_are_identity() {
    let adj = Adjustments::default();
    assert_eq!(adj.color_balance.shadows.hue, 0.0);
    assert_eq!(adj.color_balance.shadows.saturation, 0.0);
    assert_eq!(adj.color_balance.shadows.luminance, 0.0);
    assert_eq!(adj.color_balance.midtones.hue, 0.0);
    assert_eq!(adj.color_balance.midtones.saturation, 0.0);
    assert_eq!(adj.color_balance.midtones.luminance, 0.0);
    assert_eq!(adj.color_balance.highlights.hue, 0.0);
    assert_eq!(adj.color_balance.highlights.saturation, 0.0);
    assert_eq!(adj.color_balance.highlights.luminance, 0.0);
}

#[test]
fn color_balance_changes_adjustments_hash() {
    let base = Adjustments::default();

    let mut shadows = Adjustments::default();
    shadows.color_balance.shadows.hue = 45.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&shadows));

    let mut midtones = Adjustments::default();
    midtones.color_balance.midtones.saturation = 30.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&midtones));

    let mut highlights = Adjustments::default();
    highlights.color_balance.highlights.luminance = -15.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&highlights));
}

#[test]
fn selective_color_defaults_are_identity() {
    let adj = Adjustments::default();
    assert_eq!(adj.selective_color.red.hue, 0.0);
    assert_eq!(adj.selective_color.orange.saturation, 0.0);
    assert_eq!(adj.selective_color.yellow.luminance, 0.0);
    assert_eq!(adj.selective_color.green.hue, 0.0);
    assert_eq!(adj.selective_color.aqua.saturation, 0.0);
    assert_eq!(adj.selective_color.blue.luminance, 0.0);
    assert_eq!(adj.selective_color.purple.hue, 0.0);
    assert_eq!(adj.selective_color.magenta.saturation, 0.0);
}

#[test]
fn selective_color_changes_adjustments_hash() {
    let base = Adjustments::default();

    let mut red = Adjustments::default();
    red.selective_color.red.hue = 20.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&red));

    let mut green = Adjustments::default();
    green.selective_color.green.saturation = -50.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&green));

    let mut blue = Adjustments::default();
    blue.selective_color.blue.luminance = 25.0;
    assert_ne!(adjustments_hash(&base), adjustments_hash(&blue));
}
