use std::sync::OnceLock;

use crate::types::ProcessedImage;

pub fn apply_rotation(img: ProcessedImage, rotation: u32) -> ProcessedImage {
    if rotation == 0 {
        return img;
    }
    let (width, height) = (img.width, img.height);
    let buf = image::RgbaImage::from_raw(width, height, img.into_mut_vec()).expect("valid");
    let rotated = match rotation {
        90 => image::imageops::rotate90(&buf),
        180 => image::imageops::rotate180(&buf),
        270 => image::imageops::rotate270(&buf),
        _ => buf,
    };
    ProcessedImage {
        width: rotated.width(),
        height: rotated.height(),
        rgba: rotated.into_raw().into(),
    }
}

const R_OFFSET: usize = 0;
const G_OFFSET: usize = 256;
const B_OFFSET: usize = 2 * 256;
const L_OFFSET: usize = 3 * 256;

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

struct LumaLuts {
    r: [f32; 256],
    g: [f32; 256],
    b: [f32; 256],
    inv: Vec<u8>,
}

static LUTS: std::sync::OnceLock<LumaLuts> = OnceLock::new();

fn get_luts() -> &'static LumaLuts {
    LUTS.get_or_init(|| {
        let mut r_lut = [0.0; 256];
        let mut g_lut = [0.0; 256];
        let mut b_lut = [0.0; 256];

        for i in 0..256 {
            let v = (i as f32 / 255.0).powf(2.2);
            r_lut[i] = v * LUMA_R;
            g_lut[i] = v * LUMA_G;
            b_lut[i] = v * LUMA_B;
        }

        // 65536 elements gives us 16-bit precision for the inverse gamma curve
        let mut inv = vec![0; 65536];
        for i in 0..65536 {
            let v = i as f32 / 65535.0;
            inv[i] = (v.powf(1.0 / 2.2) * 255.0).round() as u8;
        }

        LumaLuts {
            r: r_lut,
            g: g_lut,
            b: b_lut,
            inv,
        }
    })
}

#[inline(always)]
fn fast_perceptual_luma(r: u8, g: u8, b: u8, luts: &LumaLuts) -> usize {
    let y_lin = luts.r[r as usize] + luts.g[g as usize] + luts.b[b as usize];

    // Map the 0.0-1.0 float to our 16-bit LUT index
    let inv_idx = (y_lin * 65535.0) as usize;

    // Clamp to max 65535 in case floating point inaccuracies push it over bounds
    luts.inv[inv_idx.min(65535)] as usize
}

fn scale_and_smooth(hist: &mut [u32; 256 * 4]) {
    for channel in 0..4 {
        let channel_offset = channel * 256;
        let kernel = [0.06, 0.24, 0.40, 0.24, 0.06];

        let mut temp = [0.0; 256];
        // Smooth out the channel using the 5-tap Gaussian filter
        for i in 0..256 {
            let mut val = 0.0;
            for (k_offset, &weight) in (-2..=2).zip(kernel.iter()) {
                // Clamp indices to the boundaries [0, 255] of the current channel segment
                let idx = (i as isize + k_offset).clamp(0, 255) as usize;
                val += hist[channel_offset + idx] as f32 * weight;
            }
            temp[i] = val;
        }

        // Apply square-root scaling
        for i in 0..256 {
            hist[channel_offset + i] = temp[i].sqrt().round() as u32;
        }
    }
}

pub fn calculate_histogram(pixels: &[u8]) -> Box<[u32; 256 * 4]> {
    assert!(pixels.len().is_multiple_of(4));

    let luts = get_luts();
    let total_pixels = pixels.len() / 4;
    let step = (total_pixels / 65536).max(1);

    let mut raw_hist = [0u32; 1024];

    for i in (0..total_pixels).step_by(step) {
        let base = i * 4;
        let r = pixels[base] as usize;
        let g = pixels[base + 1] as usize;
        let b = pixels[base + 2] as usize;
        let l_idx = fast_perceptual_luma(pixels[base], pixels[base + 1], pixels[base + 2], luts);

        raw_hist[r + R_OFFSET] += 1;
        raw_hist[g + G_OFFSET] += 1;
        raw_hist[b + B_OFFSET] += 1;
        raw_hist[l_idx + L_OFFSET] += 1;
    }

    if step > 1 {
        let step_factor = step as u32;
        for count in &mut raw_hist {
            *count *= step_factor;
        }
    }

    let mut boxed_hist = Box::new(raw_hist);
    scale_and_smooth(&mut boxed_hist);

    boxed_hist
}
