//! Automatic white-balance estimation (gray-world + white-patch hybrid).
//!
//! Produces the same relative `temperature`/`tint` slider offsets the UI uses,
//! neutralized through the renderer's WB model (`color::lut::wb_gains`). Runs on
//! a downsampled copy of the ungraded base image, so it is a one-shot CPU pass.

use crate::exif::AsShotWb;
use crate::types::ProcessedImage;

use super::lut::wb_gains;

/// Relative white-balance offsets estimated from image pixels.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AutoWb {
    pub temperature: i32,
    pub tint: i32,
}

const GRAY_WEIGHT: f32 = 0.4;
const WHITE_WEIGHT: f32 = 0.6;

#[inline]
fn luma(r: u8, g: u8, b: u8) -> u32 {
    (2126 * r as u32 + 7152 * g as u32 + 722 * b as u32) / 10000
}

/// Gray-world estimate: equalize per-channel means to green (normalized so
/// green = 1). `None` when the image is empty or a channel mean is zero.
fn gray_world(rgba: &[u8]) -> Option<(f32, f32, f32)> {
    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    let mut count = 0u64;
    for px in rgba.chunks_exact(4) {
        sum_r += px[0] as u64;
        sum_g += px[1] as u64;
        sum_b += px[2] as u64;
        count += 1;
    }
    if count == 0 {
        return None;
    }
    let mean_r = sum_r as f32 / count as f32;
    let mean_g = sum_g as f32 / count as f32;
    let mean_b = sum_b as f32 / count as f32;
    if mean_r < 1e-6 || mean_b < 1e-6 {
        return None;
    }
    Some((mean_g / mean_r, 1.0, mean_g / mean_b))
}

/// White-patch estimate: assume the brightest ~1% (by luma) is neutral and
/// equalize their mean channels to green.
fn white_patch(rgba: &[u8]) -> Option<(f32, f32, f32)> {
    let mut pixels: Vec<(u32, u8, u8, u8)> = Vec::with_capacity(rgba.len() / 4);
    for px in rgba.chunks_exact(4) {
        pixels.push((luma(px[0], px[1], px[2]), px[0], px[1], px[2]));
    }
    if pixels.is_empty() {
        return None;
    }
    pixels.sort_unstable_by(|a, b| b.0.cmp(&a.0));

    let take = (pixels.len() / 100).max(1);
    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    for (_, r, g, b) in pixels.iter().take(take) {
        sum_r += *r as u64;
        sum_g += *g as u64;
        sum_b += *b as u64;
    }
    let patch_r = sum_r as f32 / take as f32;
    let patch_g = sum_g as f32 / take as f32;
    let patch_b = sum_b as f32 / take as f32;
    if patch_r < 1e-6 || patch_b < 1e-6 {
        return None;
    }
    Some((patch_g / patch_r, 1.0, patch_g / patch_b))
}

/// Blend gray-world and white-patch gains (60% white-patch, 40% gray-world),
/// normalized so green = 1.
fn blended_gains(rgba: &[u8]) -> Option<(f32, f32, f32)> {
    let gray = gray_world(rgba);
    let patch = white_patch(rgba);
    let (r, g, b) = match (patch, gray) {
        (Some(p), Some(gr)) => (
            WHITE_WEIGHT * p.0 + GRAY_WEIGHT * gr.0,
            WHITE_WEIGHT * p.1 + GRAY_WEIGHT * gr.1,
            WHITE_WEIGHT * p.2 + GRAY_WEIGHT * gr.2,
        ),
        (Some(p), None) => p,
        (None, Some(gr)) => gr,
        (None, None) => return None,
    };
    if g <= 1e-6 {
        return None;
    }
    Some((r / g, 1.0, b / g))
}

/// Estimate relative `temperature`/`tint` offsets that neutralize the image.
///
/// The renderer applies `gain = base · relative`, where `base` are the as-shot
/// correction gains from `as_shot` (`wb_gains` at temp/tint 0) and the relative
/// part is `(1 + 0.5t, 1 - 0.3·tint, 1 - 0.5t)`. Given target gains
/// `(gr, 1.0, gb)` (green = 1) we solve the two ratio equations for `t` and
/// `tint`, so the result is correct whether or not an as-shot baseline is
/// present. Offsets are clamped to the `-100..=100` slider range.
pub fn auto_white_balance(img: &ProcessedImage, as_shot: &AsShotWb) -> AutoWb {
    let rgba: &[u8] = &img.rgba;
    let Some((gr, _gg, gb)) = blended_gains(rgba) else {
        return AutoWb {
            temperature: 0,
            tint: 0,
        };
    };

    // As-shot baseline gains (green normalized to 1).
    let (base_r, _base_g, base_b) = wb_gains(
        &crate::types::Color {
            temperature: 0,
            tint: 0,
        },
        as_shot,
    );

    if base_r.abs() < 1e-6 || base_b.abs() < 1e-6 || gr.abs() < 1e-6 {
        return AutoWb {
            temperature: 0,
            tint: 0,
        };
    }

    // Solve (1 + 0.5t)/(1 - 0.5t) = (gr/base_r) / (gb/base_b).
    let k = (gr * base_b) / (gb * base_r);
    let t = 2.0 * (k - 1.0) / (k + 1.0);
    // Green gain A = base_r·(1 + 0.5t) / gr; then tint = (1 - A)/0.3.
    let a = base_r * (1.0 + 0.5 * t) / gr;
    let tint = (1.0 - a) / 0.3;

    AutoWb {
        temperature: (t * 100.0).round().clamp(-100.0, 100.0) as i32,
        tint: (tint * 100.0).round().clamp(-100.0, 100.0) as i32,
    }
}
