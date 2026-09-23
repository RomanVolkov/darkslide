use log::debug;

use crate::exif::AsShotWb;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct CurvePoint {
    pub x: f64,
    pub y: f64,
}

/// The identity curve (two endpoints).
pub fn default_curve_points() -> Vec<CurvePoint> {
    vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 255.0, y: 255.0 }]
}

/// Per-channel tone curves: `rgb` (master) plus `red`/`green`/`blue`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Curves {
    #[serde(default = "default_curve_points")]
    pub rgb: Vec<CurvePoint>,
    #[serde(default = "default_curve_points")]
    pub red: Vec<CurvePoint>,
    #[serde(default = "default_curve_points")]
    pub green: Vec<CurvePoint>,
    #[serde(default = "default_curve_points")]
    pub blue: Vec<CurvePoint>,
}

impl Default for Curves {
    fn default() -> Self {
        Self {
            rgb: default_curve_points(),
            red: default_curve_points(),
            green: default_curve_points(),
            blue: default_curve_points(),
        }
    }
}

impl Hash for Curves {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.rgb.hash(state);
        self.red.hash(state);
        self.green.hash(state);
        self.blue.hash(state);
    }
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Light {
    pub exposure: f32,
    pub contrast: i32,
    pub highlights: i32,
    pub shadows: i32,
    pub whites: i32,
    pub blacks: i32,
    pub brightness: i32,
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Color {
    /// Relative white-balance temperature offset in `-100..=100` (0 = neutral).
    /// The neutral point is the image's as-shot WB (`Adjustments::as_shot_wb`),
    /// falling back to 6500K when no metadata is available.
    ///
    /// Legacy records stored absolute Kelvin; out-of-range values are migrated
    /// to this scale on deserialization (see `normalize_legacy_temperature`).
    #[serde(default, deserialize_with = "deserialize_temperature")]
    pub temperature: i32,
    /// Relative green/magenta tint offset in `-100..=100` (0 = neutral).
    pub tint: i32,
}

/// Map a legacy absolute-Kelvin temperature onto the relative `-100..=100`
/// scale. Values already within range pass through unchanged; out-of-range
/// values use the historical `(kelvin - 6500) / 4500` mapping.
pub fn normalize_legacy_temperature(value: i32) -> i32 {
    if (-100..=100).contains(&value) {
        value
    } else {
        (((value as f32 - 6500.0) / 4500.0) * 100.0)
            .round()
            .clamp(-100.0, 100.0) as i32
    }
}

fn deserialize_temperature<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <i32 as serde::Deserialize>::deserialize(deserializer)?;
    Ok(normalize_legacy_temperature(value))
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct HSL {
    pub hue: i32,
    pub saturation: i32,
    pub vibrance: i32,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ToneBalance {
    #[serde(default)]
    pub hue: f32,
    #[serde(default)]
    pub saturation: f32,
    #[serde(default)]
    pub luminance: f32,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ColorBalance {
    #[serde(default)]
    pub shadows: ToneBalance,
    #[serde(default)]
    pub midtones: ToneBalance,
    #[serde(default)]
    pub highlights: ToneBalance,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SelectiveChannel {
    #[serde(default)]
    pub hue: f32,
    #[serde(default)]
    pub saturation: f32,
    #[serde(default)]
    pub luminance: f32,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SelectiveColor {
    #[serde(default)]
    pub red: SelectiveChannel,
    #[serde(default)]
    pub orange: SelectiveChannel,
    #[serde(default)]
    pub yellow: SelectiveChannel,
    #[serde(default)]
    pub green: SelectiveChannel,
    #[serde(default)]
    pub aqua: SelectiveChannel,
    #[serde(default)]
    pub blue: SelectiveChannel,
    #[serde(default)]
    pub purple: SelectiveChannel,
    #[serde(default)]
    pub magenta: SelectiveChannel,
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Sharpen {
    pub amount: i32,
    pub radius: i32,
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Grain {
    pub amount: i32,
    pub size: i32,
    pub roughness: i32,
}

/// Edge-preserving noise reduction: `strength` is the filter amount and
/// `preserve` the edge threshold (higher keeps more detail).
#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Denoise {
    pub strength: i32,
    pub preserve: i32,
}

#[derive(Debug, Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Detail {
    pub black_point: i32,
    pub texture: i32,
    pub clarity: i32,
    pub sharpen: Sharpen,
    pub grain: Grain,
    #[serde(default)]
    pub denoise: Denoise,
}

/// Crop/straighten geometry. `straighten` is an angle in degrees, `zoom` a
/// scale where 1.0 fills the frame, and `crop_x`/`crop_y` a normalized center
/// offset (-1..1).
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Geometry {
    pub straighten: f32,
    pub zoom: f32,
    pub crop_x: f32,
    pub crop_y: f32,
    #[serde(default)]
    pub distortion: f32,
    #[serde(default)]
    pub perspective_v: f32,
    #[serde(default)]
    pub perspective_h: f32,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            straighten: 0.0,
            zoom: 1.0,
            crop_x: 0.0,
            crop_y: 0.0,
            distortion: 0.0,
            perspective_v: 0.0,
            perspective_h: 0.0,
        }
    }
}

impl Hash for Geometry {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.straighten.to_bits().hash(state);
        self.zoom.to_bits().hash(state);
        self.crop_x.to_bits().hash(state);
        self.crop_y.to_bits().hash(state);
        self.distortion.to_bits().hash(state);
        self.perspective_v.to_bits().hash(state);
        self.perspective_h.to_bits().hash(state);
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Adjustments {
    pub light: Light,
    pub color: Color,
    pub hsl: HSL,
    /// Per-channel tone curves (master `rgb` + per-channel R/G/B).
    #[serde(default)]
    pub curves: Curves,
    pub detail: Detail,
    /// As-shot white balance read from image metadata. Read-only metadata that
    /// anchors the neutral point for the relative `color.temperature`/`tint`.
    #[serde(default)]
    pub as_shot_wb: AsShotWb,
    #[serde(default)]
    pub rotation: u32, // 0 | 90 | 180 | 270
    #[serde(default)]
    pub geometry: Geometry,
    #[serde(default)]
    pub color_balance: ColorBalance,
    #[serde(default)]
    pub selective_color: SelectiveColor,
    pub lut_id: Option<u32>,
    pub lut_intensity: u32,
}

impl Default for Adjustments {
    fn default() -> Self {
        Self {
            light: Light::default(),
            color: Color {
                temperature: 0,
                tint: 0,
            },
            hsl: HSL::default(),
            curves: Curves::default(),
            detail: Detail::default(),
            as_shot_wb: AsShotWb::default(),
            rotation: 0,
            geometry: Geometry::default(),
            color_balance: ColorBalance::default(),
            selective_color: SelectiveColor::default(),
            lut_id: None,
            lut_intensity: 0,
        }
    }
}

use std::hash::{Hash, Hasher};
use std::sync::Arc;

impl Hash for CurvePoint {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.x.to_bits().hash(state);
        self.y.to_bits().hash(state);
    }
}

impl Hash for Light {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.exposure.to_bits().hash(state);
        self.contrast.hash(state);
        self.highlights.hash(state);
        self.shadows.hash(state);
        self.whites.hash(state);
        self.blacks.hash(state);
        self.brightness.hash(state);
    }
}

impl Hash for Color {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.temperature.hash(state);
        self.tint.hash(state);
    }
}

impl Hash for HSL {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hue.hash(state);
        self.saturation.hash(state);
        self.vibrance.hash(state);
    }
}

impl Hash for ToneBalance {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hue.to_bits().hash(state);
        self.saturation.to_bits().hash(state);
        self.luminance.to_bits().hash(state);
    }
}

impl Hash for ColorBalance {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.shadows.hash(state);
        self.midtones.hash(state);
        self.highlights.hash(state);
    }
}

impl Hash for SelectiveChannel {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hue.to_bits().hash(state);
        self.saturation.to_bits().hash(state);
        self.luminance.to_bits().hash(state);
    }
}

impl Hash for SelectiveColor {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.red.hash(state);
        self.orange.hash(state);
        self.yellow.hash(state);
        self.green.hash(state);
        self.aqua.hash(state);
        self.blue.hash(state);
        self.purple.hash(state);
        self.magenta.hash(state);
    }
}

impl Hash for Sharpen {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.amount.hash(state);
        self.radius.hash(state);
    }
}

impl Hash for Grain {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.amount.hash(state);
        self.size.hash(state);
        self.roughness.hash(state);
    }
}

impl Hash for Denoise {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.strength.hash(state);
        self.preserve.hash(state);
    }
}

impl Hash for Detail {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.black_point.hash(state);
        self.texture.hash(state);
        self.clarity.hash(state);
        self.sharpen.hash(state);
        self.grain.hash(state);
        self.denoise.hash(state);
    }
}

impl Hash for Adjustments {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.light.hash(state);
        self.color.hash(state);
        self.hsl.hash(state);
        self.curves.hash(state);
        self.detail.hash(state);
        self.as_shot_wb.hash(state);
        self.rotation.hash(state);
        self.geometry.hash(state);
        self.color_balance.hash(state);
        self.selective_color.hash(state);
        self.lut_id.hash(state);
        self.lut_intensity.hash(state);
    }
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
// TODO: do I need to add type? or store everything inside rgba for now
pub struct ProcessedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
}

impl ProcessedImage {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Self {
        Self {
            width,
            height,
            rgba: Arc::new(rgba),
        }
    }

    pub fn from_arc(width: u32, height: u32, rgba: Arc<Vec<u8>>) -> Self {
        Self {
            width,
            height,
            rgba,
        }
    }

    pub fn into_mut_vec(self) -> Vec<u8> {
        match Arc::try_unwrap(self.rgba) {
            Ok(vec) => vec,
            Err(arc) => (*arc).clone(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum PngCompressionLevel {
    Fast,
    Default,
    Best,
}

impl From<&str> for PngCompressionLevel {
    fn from(value: &str) -> Self {
        match value {
            "default" => PngCompressionLevel::Default,
            "best" => PngCompressionLevel::Best,
            "fast" => PngCompressionLevel::Fast,
            _ => {
                debug!("incorrect PngCompressionLevel: {}", value);
                PngCompressionLevel::Default
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ImageType {
    JPG(u8),
    PNG(PngCompressionLevel),
    TIFF,
    WEBP,
}

impl ImageType {
    /// Build an `ImageType` from the frontend export parameters: the format
    /// label (`"jpg" | "png" | "tiff" | "webp"`) plus optional quality and PNG
    /// compression level. Unknown labels fall back to JPG(95).
    pub fn from_export(
        image_type: &str,
        quality: Option<u8>,
        png_compression: Option<&str>,
    ) -> Self {
        match image_type {
            "png" => Self::PNG(PngCompressionLevel::from(
                png_compression.unwrap_or_default(),
            )),
            "jpg" => Self::JPG(quality.unwrap_or(95)),
            "tiff" => Self::TIFF,
            "webp" => Self::WEBP,
            _ => {
                debug!("unknown image type, default to JPG:95");
                Self::JPG(95)
            }
        }
    }

    /// Detect image format from magic bytes. Returns None if unknown.
    pub fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 12 {
            return None;
        }
        if bytes.starts_with(&[0xFF, 0xD8]) {
            Some(Self::JPG(90))
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::PNG(PngCompressionLevel::Default))
        } else if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            Some(Self::WEBP)
        } else if &bytes[4..8] == b"ftyp"
            && matches!(
                &bytes[8..12],
                b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
            )
        {
            // HEIF — we encode it as JPG after conversion, so use JPG as fallback type.
            // This is only used for format detection during import; actual export never
            // produces HEIF.
            Some(Self::JPG(90))
        } else {
            None
        }
    }
}
