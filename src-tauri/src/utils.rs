use darkslide_core::types::Adjustments;
use std::fs::read;
use xattr;

/// Convert a HEIC/HEIF file to PNG bytes using macOS's built-in `sips` tool.
pub fn read_heic(path: &str) -> Result<Vec<u8>, String> {
    let file_name = std::path::Path::new(path)
        .file_name()
        .unwrap()
        .to_string_lossy();
    let tmp = std::env::temp_dir().join(format!("darkslide_{file_name}.png"));
    let status = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "png",
            path,
            "--out",
            tmp.to_str().ok_or("invalid tmp path")?,
        ])
        .status()
        .map_err(|e| format!("sips unavailable: {e}"))?;
    if !status.success() {
        return Err(format!("sips failed converting HEIC (status {status})"));
    }
    let bytes = read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Image binary packing
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Clone)]
pub struct FileRef {
    pub id: String,
    pub path: String,
}

pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();

    while let (Some(&ca), Some(&cb)) = (a_chars.peek(), b_chars.peek()) {
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let mut num_a = 0u64;
            while let Some(&d) = a_chars.peek() {
                if let Some(digit) = d.to_digit(10) {
                    num_a = num_a.saturating_mul(10).saturating_add(digit as u64);
                    a_chars.next();
                } else {
                    break;
                }
            }
            let mut num_b = 0u64;
            while let Some(&d) = b_chars.peek() {
                if let Some(digit) = d.to_digit(10) {
                    num_b = num_b.saturating_mul(10).saturating_add(digit as u64);
                    b_chars.next();
                } else {
                    break;
                }
            }
            match num_a.cmp(&num_b) {
                std::cmp::Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        } else {
            let ca_lower = ca.to_ascii_lowercase();
            let cb_lower = cb.to_ascii_lowercase();
            match ca_lower.cmp(&cb_lower) {
                std::cmp::Ordering::Equal => {
                    a_chars.next();
                    b_chars.next();
                }
                non_eq => return non_eq,
            }
        }
    }

    match (a_chars.peek().is_some(), b_chars.peek().is_some()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Equal,
    }
}

const PACK_ADJUSTMENTS_VERSION: u8 = 6;

/// Pack decoded images into a flat binary buffer (no base64, no JSON).
///
/// Layout per image (repeated until end of buffer):
///   [id_len: u32 LE] [id: UTF-8 bytes]
///   [filename_len: u32 LE] [filename: UTF-8 bytes]
///   [version: u8]
///   [light:   exposure f32 LE, contrast i32 LE, highlights i32 LE,
///             shadows i32 LE, whites i32 LE, blacks i32 LE, brightness i32 LE]
///   [color:   temperature i32 LE, tint i32 LE]
///   [hsl:     hue i32 LE, saturation i32 LE, vibrance i32 LE]
///   [detail:  black_point i32 LE, texture i32 LE, clarity i32 LE,
///             sharpen.amount i32 LE, sharpen.radius i32 LE,
///             grain.amount i32 LE, grain.size i32 LE, grain.roughness i32 LE]
///   [rotation: u32 LE]
///   [lut_id_present: u32 LE] [lut_id: u32 LE]   // present is 0 or 1
///   [lut_intensity: u32 LE]
///   [curve_rgb_len: u32 LE] then points...; same for red, green, blue
///   (v2) [wb_kelvin_present: u32 LE] [wb_kelvin: u32 LE]
///        [wb_neutral_present: u32 LE] [neutral_r: f32 LE] [neutral_g: f32 LE] [neutral_b: f32 LE]
///   [geometry: straighten, zoom, crop_x, crop_y, distortion, perspective_v, perspective_h (7 f32 LE)]
///   (v6) [color_balance: shadows, midtones, highlights (9 f32 LE: hue, saturation, luminance)]
///        [selective_color: red..magenta (24 f32 LE: hue, saturation, luminance * 8)]
pub fn pack_images(images: &[(String, std::path::PathBuf, Adjustments)]) -> Vec<u8> {
    let adjustment_size = |adj: &Adjustments| {
        1 // version
            + (7 * 4) // light
            + (2 * 4) // color
            + (3 * 4) // hsl
            + (3 * 4) // detail top-level
            + (2 * 4) // sharpen
            + (3 * 4) // grain
            + (2 * 4) // denoise
            + 4 // rotation
            + 4 + 4 // lut_id present + value
            + 4 // lut_intensity
            + 4 * 4 // four per-channel curve lengths
            + (adj.curves.rgb.len()
                + adj.curves.red.len()
                + adj.curves.green.len()
                + adj.curves.blue.len())
                * (8 + 8)
            + 4 + 4 // as_shot_wb kelvin present + value
            + 4 + 3 * 4 // as_shot_wb neutral present + rgb
            + 7 * 4 // geometry: straighten, zoom, crop_x, crop_y, distortion, perspective_v, perspective_h
            + 9 * 4 // color_balance: 3 tones * 3 floats
            + 24 * 4 // selective_color: 8 channels * 3 floats
    };

    let capacity = images
        .iter()
        .map(|(id, path, adj)| {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(id.as_str());
            4 + id.len() + 4 + filename.len() + adjustment_size(adj)
        })
        .sum();
    let mut buf = Vec::with_capacity(capacity);

    for (id, path, adj) in images {
        let id_bytes = id.as_bytes();
        buf.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(id_bytes);

        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(id.as_str());
        let filename_bytes = filename.as_bytes();
        buf.extend_from_slice(&(filename_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(filename_bytes);

        buf.push(PACK_ADJUSTMENTS_VERSION);

        buf.extend_from_slice(&adj.light.exposure.to_le_bytes());
        buf.extend_from_slice(&adj.light.contrast.to_le_bytes());
        buf.extend_from_slice(&adj.light.highlights.to_le_bytes());
        buf.extend_from_slice(&adj.light.shadows.to_le_bytes());
        buf.extend_from_slice(&adj.light.whites.to_le_bytes());
        buf.extend_from_slice(&adj.light.blacks.to_le_bytes());
        buf.extend_from_slice(&adj.light.brightness.to_le_bytes());

        buf.extend_from_slice(&adj.color.temperature.to_le_bytes());
        buf.extend_from_slice(&adj.color.tint.to_le_bytes());

        buf.extend_from_slice(&adj.hsl.hue.to_le_bytes());
        buf.extend_from_slice(&adj.hsl.saturation.to_le_bytes());
        buf.extend_from_slice(&adj.hsl.vibrance.to_le_bytes());

        buf.extend_from_slice(&adj.detail.black_point.to_le_bytes());
        buf.extend_from_slice(&adj.detail.texture.to_le_bytes());
        buf.extend_from_slice(&adj.detail.clarity.to_le_bytes());
        buf.extend_from_slice(&adj.detail.sharpen.amount.to_le_bytes());
        buf.extend_from_slice(&adj.detail.sharpen.radius.to_le_bytes());
        buf.extend_from_slice(&adj.detail.grain.amount.to_le_bytes());
        buf.extend_from_slice(&adj.detail.grain.size.to_le_bytes());
        buf.extend_from_slice(&adj.detail.grain.roughness.to_le_bytes());
        buf.extend_from_slice(&adj.detail.denoise.strength.to_le_bytes());
        buf.extend_from_slice(&adj.detail.denoise.preserve.to_le_bytes());

        buf.extend_from_slice(&adj.rotation.to_le_bytes());

        match adj.lut_id {
            Some(id) => {
                buf.extend_from_slice(&(1u32).to_le_bytes());
                buf.extend_from_slice(&id.to_le_bytes());
            }
            None => {
                buf.extend_from_slice(&(0u32).to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
            }
        }

        buf.extend_from_slice(&adj.lut_intensity.to_le_bytes());

        for channel in [
            &adj.curves.rgb,
            &adj.curves.red,
            &adj.curves.green,
            &adj.curves.blue,
        ] {
            buf.extend_from_slice(&(channel.len() as u32).to_le_bytes());
            for pt in channel {
                buf.extend_from_slice(&pt.x.to_le_bytes());
                buf.extend_from_slice(&pt.y.to_le_bytes());
            }
        }

        match adj.as_shot_wb.kelvin {
            Some(kelvin) => {
                buf.extend_from_slice(&(1u32).to_le_bytes());
                buf.extend_from_slice(&kelvin.to_le_bytes());
            }
            None => {
                buf.extend_from_slice(&(0u32).to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        match adj.as_shot_wb.neutral_rgb {
            Some(rgb) => {
                buf.extend_from_slice(&(1u32).to_le_bytes());
                for v in rgb {
                    buf.extend_from_slice(&v.to_le_bytes());
                }
            }
            None => {
                buf.extend_from_slice(&(0u32).to_le_bytes());
                for _ in 0..3 {
                    buf.extend_from_slice(&0f32.to_le_bytes());
                }
            }
        }

        buf.extend_from_slice(&adj.geometry.straighten.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.zoom.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.crop_x.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.crop_y.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.distortion.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.perspective_v.to_le_bytes());
        buf.extend_from_slice(&adj.geometry.perspective_h.to_le_bytes());

        // Color balance (9 f32)
        for tone in [
            &adj.color_balance.shadows,
            &adj.color_balance.midtones,
            &adj.color_balance.highlights,
        ] {
            buf.extend_from_slice(&tone.hue.to_le_bytes());
            buf.extend_from_slice(&tone.saturation.to_le_bytes());
            buf.extend_from_slice(&tone.luminance.to_le_bytes());
        }

        // Selective color (24 f32)
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
            buf.extend_from_slice(&ch.hue.to_le_bytes());
            buf.extend_from_slice(&ch.saturation.to_le_bytes());
            buf.extend_from_slice(&ch.luminance.to_le_bytes());
        }
    }
    buf
}

// ---------------------------------------------------------------------------
// xattr
// ---------------------------------------------------------------------------

const IMAGE_RECORD_UUID_KEY: &str = "image_record_uuid_key";

pub fn set_file_uuid(file_path: &str, id: uuid::Uuid) -> Result<(), String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("path: {} does not exist", file_path));
    }

    xattr::set(path, IMAGE_RECORD_UUID_KEY, id.as_bytes()).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn get_file_uuid(file_path: &str) -> Result<Option<uuid::Uuid>, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("path: {} does not exist", file_path));
    }

    let bytes = xattr::get(path, IMAGE_RECORD_UUID_KEY).map_err(|e| e.to_string())?;

    match bytes {
        None => Ok(None),
        Some(v) => {
            let uuid = uuid::Uuid::from_slice(&v).map_err(|e| e.to_string())?;
            Ok(Some(uuid))
        }
    }
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

pub async fn inject_exif(
    uid: uuid::Uuid,
    encoded: Vec<u8>,
    state: &crate::types::AppState,
) -> Vec<u8> {
    let Some(original_path) = state
        .db_instance
        .find_image_by_uuid(uid)
        .await
        .ok()
        .flatten()
        .and_then(|rec| rec.current_path)
    else {
        return encoded;
    };

    let id_str = uid.to_string();
    let exif_cache = state.exif_cache.clone();

    // Fast path: EXIF bytes were extracted during a previous export.
    {
        let mut cache = exif_cache.lock().unwrap();
        if let Some(cached) = cache.get(&id_str) {
            return darkslide_core::exif::inject_exif(encoded, cached);
        }
    }

    let path = original_path.clone();
    let path_str = original_path.to_string_lossy().to_string();
    let exif_bytes = match tokio::task::spawn_blocking(move || {
        let raw = std::fs::read(path.as_ref()).ok()?;
        darkslide_core::exif::extract_exif(&raw, &path_str)
    })
    .await
    {
        Ok(Some(bytes)) => bytes,
        _ => return encoded,
    };

    let normalized = darkslide_core::exif::normalize_exif_for_export(&exif_bytes);
    exif_cache
        .lock()
        .unwrap()
        .put(id_str, normalized.clone());
    darkslide_core::exif::inject_exif(encoded, &normalized)
}
