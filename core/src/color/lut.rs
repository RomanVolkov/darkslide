use crate::exif::AsShotWb;
use crate::types;
use super::{curve, hsl};
use log::debug;
use std::f32::consts::PI;
use std::sync::{Arc, OnceLock};

/// Approximate the linear RGB color of a blackbody at `kelvin`, normalized to
/// `0..1` (Tanner Helland approximation). Used only to derive white-balance
/// correction gains; callers normalize so green = 1.
fn blackbody_rgb(kelvin: f32) -> (f32, f32, f32) {
    let t = (kelvin / 100.0).clamp(10.0, 400.0);
    let (r, g, b) = if t <= 66.0 {
        let r = 255.0;
        let g = 99.4708025861 * t.ln() - 161.1195681661;
        let b = if t <= 19.0 {
            0.0
        } else {
            138.5177312231 * (t - 10.0).ln() - 305.0447927307
        };
        (r, g, b)
    } else {
        let r = 329.698727446 * (t - 60.0).powf(-0.1332047592);
        let g = 288.1221695283 * (t - 60.0).powf(-0.0755148492);
        let b = 255.0;
        (r, g, b)
    };
    (
        (r / 255.0).clamp(0.0, 1.0),
        (g / 255.0).clamp(0.0, 1.0),
        (b / 255.0).clamp(0.0, 1.0),
    )
}

/// White-balance correction gains `(r, g, b)` for the relative temperature/tint
/// sliders, anchored on the image's as-shot white balance.
///
/// Neutral is `(1.0, 1.0, 1.0)`: `temperature` 0 and `tint` 0 produce no change.
/// Positive `temperature` warms (more red, less blue) and positive `tint` pushes
/// magenta (less green). The as-shot baseline derives from `AsShotNeutral`
/// (reciprocal of the per-channel multipliers) or `ColorTemperature`
/// (blackbody), with no correction when neither is present.
pub fn wb_gains(color: &types::Color, as_shot: &AsShotWb) -> (f32, f32, f32) {
    let (base_r, base_b) = if let Some([r, _g, b]) = as_shot.neutral_rgb {
        let rr = if r.abs() > 1e-6 { 1.0 / r } else { 1.0 };
        let bb = if b.abs() > 1e-6 { 1.0 / b } else { 1.0 };
        (rr, bb)
    } else if let Some(kelvin) = as_shot.kelvin {
        let (cr, cg, cb) = blackbody_rgb(kelvin as f32);
        let rr = if cr.abs() > 1e-6 { cg / cr } else { 1.0 };
        let bb = if cb.abs() > 1e-6 { cg / cb } else { 1.0 };
        (rr, bb)
    } else {
        (1.0, 1.0)
    };

    let rel_temp = color.temperature as f32 / 100.0;
    let rel_tint = color.tint as f32 / 100.0;

    let gain_r = base_r * (1.0 + rel_temp * 0.5);
    let gain_g = 1.0 - rel_tint * 0.3;
    let gain_b = base_b * (1.0 - rel_temp * 0.5);

    (gain_r.max(0.0), gain_g.max(0.0), gain_b.max(0.0))
}

/// sRGB (gamma-encoded) → linear light.
#[inline]
fn srgb_to_linear(x: f32) -> f32 {
    x.max(0.0).powf(2.2)
}

/// Linear light → sRGB (gamma-encoded).
#[inline]
fn linear_to_srgb(x: f32) -> f32 {
    x.max(0.0).powf(1.0 / 2.2)
}

/// Hermite smoothstep with clamped edges.
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply the tonal foundation (black point, exposure, contrast, highlights,
/// shadows, whites, blacks, brightness) to one normalized channel value.
///
/// Exposure runs in linear light (`2^EV`), contrast is a smooth S-curve, and
/// highlight/shadow/white/black recovery uses smoothstep feather masks, so the
/// transfer stays monotonic and keeps its endpoints. See
/// `docs/notes/tonal-quality-research.md`.
pub fn apply_tonal(adj: &types::Adjustments, xi: f32) -> f32 {
    let x = if adj.detail.black_point > 0 {
        let black_point = adj.detail.black_point as f32 / 100.0 * 0.4;
        ((xi - black_point) / (1.0 - black_point)).max(0.0)
    } else {
        xi
    };

    let mut y = x;

    if adj.light.exposure != 0.0 {
        y = linear_to_srgb(srgb_to_linear(x) * 2f32.powf(adj.light.exposure)).clamp(0.0, 1.0);
    }

    let contrast = adj.light.contrast as f32 / 100.0;
    if contrast != 0.0 {
        let s = y * y * (3.0 - 2.0 * y);
        y = (y + contrast * (s - y)).clamp(0.0, 1.0);
    }

    y += (adj.light.highlights as f32 / 100.0) * smoothstep(0.5, 1.0, x) * 0.3;
    y += (adj.light.shadows as f32 / 100.0) * (1.0 - smoothstep(0.0, 0.5, x)) * 0.3;
    y += (adj.light.whites as f32 / 100.0) * smoothstep(0.7, 1.0, x) * 0.3;
    y += (adj.light.blacks as f32 / 100.0) * (1.0 - smoothstep(0.0, 0.3, x)) * 0.3;

    if adj.light.brightness != 0 {
        y += (adj.light.brightness as f32 / 100.0) * (PI * x).sin() * 0.3;
    }

    y.clamp(0.0, 1.0)
}

/// Sample an 8-bit spline curve LUT with linear interpolation, returning the
/// input unchanged when the curve is the identity.
fn sample_curve_lut(clut: &[u8; 256], has_curve: bool, v: f32) -> f32 {
    if !has_curve {
        return v;
    }
    let v_scaled = v.clamp(0.0, 1.0) * 255.0;
    let idx_low = v_scaled.floor() as usize;
    let idx_high = (idx_low + 1).min(255);
    let fract = v_scaled.fract();
    let val_low = clut[idx_low] as f32 / 255.0;
    let val_high = clut[idx_high] as f32 / 255.0;
    val_low + (val_high - val_low) * fract
}

/// Precomputed tone balance tint vector and luminance offset
#[derive(Debug, Clone, Copy, Default)]
pub struct ToneTint {
    pub dr: f32,
    pub dg: f32,
    pub db: f32,
    pub dl: f32,
}

impl ToneTint {
    pub fn from_balance(tb: &types::ToneBalance) -> Self {
        if tb.saturation == 0.0 && tb.luminance == 0.0 {
            return Self::default();
        }
        let rad = tb.hue.to_radians();
        let dr = tb.saturation * rad.cos() * 0.003;
        let dg = tb.saturation * (rad - 120.0_f32.to_radians()).cos() * 0.003;
        let db = tb.saturation * (rad - 240.0_f32.to_radians()).cos() * 0.003;
        let dl = tb.luminance * 0.002;
        Self { dr, dg, db, dl }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ColorBalanceGains {
    pub shadows: ToneTint,
    pub midtones: ToneTint,
    pub highlights: ToneTint,
}

impl ColorBalanceGains {
    pub fn new(cb: &types::ColorBalance) -> Self {
        Self {
            shadows: ToneTint::from_balance(&cb.shadows),
            midtones: ToneTint::from_balance(&cb.midtones),
            highlights: ToneTint::from_balance(&cb.highlights),
        }
    }

    #[inline]
    pub fn is_active(&self) -> bool {
        self.shadows.dr != 0.0 || self.shadows.dg != 0.0 || self.shadows.db != 0.0 || self.shadows.dl != 0.0
            || self.midtones.dr != 0.0 || self.midtones.dg != 0.0 || self.midtones.db != 0.0 || self.midtones.dl != 0.0
            || self.highlights.dr != 0.0 || self.highlights.dg != 0.0 || self.highlights.db != 0.0 || self.highlights.dl != 0.0
    }

    #[inline]
    pub fn apply(&self, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
        let y = (0.2126 * r + 0.7152 * g + 0.0722 * b).clamp(0.0, 1.0);
        let w_s = (1.0 - y) * (1.0 - y);
        let w_h = y * y;
        let w_m = 4.0 * y * (1.0 - y);

        let r_out = r
            + w_s * (self.shadows.dr + self.shadows.dl)
            + w_m * (self.midtones.dr + self.midtones.dl)
            + w_h * (self.highlights.dr + self.highlights.dl);
        let g_out = g
            + w_s * (self.shadows.dg + self.shadows.dl)
            + w_m * (self.midtones.dg + self.midtones.dl)
            + w_h * (self.highlights.dg + self.highlights.dl);
        let b_out = b
            + w_s * (self.shadows.db + self.shadows.dl)
            + w_m * (self.midtones.db + self.midtones.dl)
            + w_h * (self.highlights.db + self.highlights.dl);

        (r_out.clamp(0.0, 1.0), g_out.clamp(0.0, 1.0), b_out.clamp(0.0, 1.0))
    }
}

pub fn apply_color_balance_pixel(r: f32, g: f32, b: f32, cb: &types::ColorBalance) -> (f32, f32, f32) {
    let gains = ColorBalanceGains::new(cb);
    if gains.is_active() {
        gains.apply(r, g, b)
    } else {
        (r, g, b)
    }
}

const SELECTIVE_CHANNELS: [(f32, f32); 8] = [
    (0.0, 35.0),    // Red
    (30.0, 30.0),   // Orange
    (60.0, 45.0),   // Yellow
    (120.0, 60.0),  // Green
    (180.0, 60.0),  // Aqua
    (240.0, 50.0),  // Blue
    (280.0, 40.0),  // Purple
    (320.0, 40.0),  // Magenta
];

#[inline]
pub fn is_selective_color_active(sc: &types::SelectiveColor) -> bool {
    let chs = [
        &sc.red, &sc.orange, &sc.yellow, &sc.green,
        &sc.aqua, &sc.blue, &sc.purple, &sc.magenta,
    ];
    chs.iter().any(|c| c.hue != 0.0 || c.saturation != 0.0 || c.luminance != 0.0)
}

pub fn apply_selective_color_pixel(r: f32, g: f32, b: f32, sc: &types::SelectiveColor) -> (f32, f32, f32) {
    if !is_selective_color_active(sc) {
        return (r, g, b);
    }

    let (h, s, l) = hsl::rgb_to_hsl(r, g, b);
    if s < 1e-4 {
        return (r, g, b);
    }

    let h_deg = h * 360.0;
    let ch_params = [
        &sc.red, &sc.orange, &sc.yellow, &sc.green,
        &sc.aqua, &sc.blue, &sc.purple, &sc.magenta,
    ];

    let mut total_weight = 0.0;
    let mut d_hue = 0.0;
    let mut d_sat = 0.0;
    let mut d_lum = 0.0;

    for (i, &(center, width)) in SELECTIVE_CHANNELS.iter().enumerate() {
        let diff = (h_deg - center).abs();
        let dist = diff.min(360.0 - diff);
        if dist < width {
            let x = PI * dist / (2.0 * width);
            let c = x.cos();
            let w = c * c;
            total_weight += w;
            let ch = ch_params[i];
            d_hue += w * ch.hue;
            d_sat += w * ch.saturation;
            d_lum += w * ch.luminance;
        }
    }

    if total_weight < 1e-5 {
        return (r, g, b);
    }

    let inv_total = 1.0 / total_weight;
    let avg_dh = d_hue * inv_total;
    let avg_ds = d_sat * inv_total;
    let avg_dl = d_lum * inv_total;

    let sat_factor = (s / 0.05).min(1.0);

    let h_shift = (avg_dh / 100.0) * (30.0 / 360.0) * sat_factor;
    let new_h = (h + h_shift).rem_euclid(1.0);

    let sat_scale = 1.0 + (avg_ds / 100.0) * sat_factor;
    let new_s = (s * sat_scale).clamp(0.0, 1.0);

    let lum_shift = (avg_dl / 100.0) * 0.3 * sat_factor;
    let new_l = (l + lum_shift).clamp(0.0, 1.0);

    hsl::hsl_to_rgb(new_h, new_s, new_l)
}

pub const IDENTITY_3D_LUT_2: [f32; 32] = [
    // b = 0, g = 0
    0.0, 0.0, 0.0, 1.0, // r = 0
    1.0, 0.0, 0.0, 1.0, // r = 1
    // b = 0, g = 1
    0.0, 1.0, 0.0, 1.0, // r = 0
    1.0, 1.0, 0.0, 1.0, // r = 1
    // b = 1, g = 0
    0.0, 0.0, 1.0, 1.0, // r = 0
    1.0, 0.0, 1.0, 1.0, // r = 1
    // b = 1, g = 1
    0.0, 1.0, 1.0, 1.0, // r = 0
    1.0, 1.0, 1.0, 1.0, // r = 1
];

static IDENTITY_3D_LUT_2_ARC: OnceLock<Arc<Vec<f32>>> = OnceLock::new();

/// Return a cached `Arc<Vec<f32>>` for the 2×2×2 identity 3D LUT.
pub fn identity_3d_lut_2_arc() -> Arc<Vec<f32>> {
    IDENTITY_3D_LUT_2_ARC
        .get_or_init(|| Arc::new(IDENTITY_3D_LUT_2.to_vec()))
        .clone()
}

pub fn build_identity_3d_lut(size: usize) -> Vec<f32> {
    let mut values = Vec::with_capacity(size * size * size * 4);
    let scale = (size - 1) as f32;

    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                let r_val = r as f32 / scale;
                let g_val = g as f32 / scale;
                let b_val = b as f32 / scale;

                values.push(r_val);
                values.push(g_val);
                values.push(b_val);
                values.push(1.0); // Alpha
            }
        }
    }
    values
}

pub fn build_3d_luts(adj: &types::Adjustments, size: usize) -> Vec<f32> {
    // 3D Cube with pixel of 4 values (rgba)
    let mut values = Vec::with_capacity(size * size * size * 4);

    let (gain_r, gain_g, gain_b) = wb_gains(&adj.color, &adj.as_shot_wb);

    // pre-calculate hsl scales once
    let do_hsl = adj.hsl.hue != 0 || adj.hsl.saturation != 0 || adj.hsl.vibrance != 0;
    let hue_shift = adj.hsl.hue as f32 / 100.0 * 0.5;
    let sat_scale = 1.0 + adj.hsl.saturation as f32 / 100.0;
    let vib_scale = adj.hsl.vibrance as f32 / 100.0 * 0.5;

    let cb_gains = ColorBalanceGains::new(&adj.color_balance);
    let do_cb = cb_gains.is_active();
    let do_sc = is_selective_color_active(&adj.selective_color);

    // Per-channel curve LUTs: master `rgb` applied to all channels, then each
    // per-channel curve applied to its own channel.
    let clut_rgb = curve::build_curve_lut(&adj.curves.rgb);
    let clut_red = curve::build_curve_lut(&adj.curves.red);
    let clut_green = curve::build_curve_lut(&adj.curves.green);
    let clut_blue = curve::build_curve_lut(&adj.curves.blue);
    let has_rgb = !curve::is_linear_curve(&adj.curves.rgb);
    let has_red = !curve::is_linear_curve(&adj.curves.red);
    let has_green = !curve::is_linear_curve(&adj.curves.green);
    let has_blue = !curve::is_linear_curve(&adj.curves.blue);

    // Tonal foundation, then master curve, then the per-channel curve.
    let channel = |xi: f32, clut: &[u8; 256], has: bool| {
        sample_curve_lut(clut, has, sample_curve_lut(&clut_rgb, has_rgb, apply_tonal(adj, xi)))
    };

    // iterate over 3D cube (Blue -> Green -> Red)
    for b in 0..size {
        let b_norm = b as f32 / (size - 1) as f32;
        let b_tonal = channel(b_norm, &clut_blue, has_blue);

        for g in 0..size {
            let g_norm = g as f32 / (size - 1) as f32;
            let g_tonal = channel(g_norm, &clut_green, has_green);

            for r in 0..size {
                let r_norm = r as f32 / (size - 1) as f32;
                let r_tonal = channel(r_norm, &clut_red, has_red);

                // Apply HSL
                let (r_hsl, g_hsl, b_hsl) = if do_hsl {
                    hsl::apply_hsl_pixel(
                        r_tonal, g_tonal, b_tonal, hue_shift, sat_scale, vib_scale,
                    )
                } else {
                    (r_tonal, g_tonal, b_tonal)
                };

                // Apply Selective Color
                let (r_sel, g_sel, b_sel) = if do_sc {
                    apply_selective_color_pixel(r_hsl, g_hsl, b_hsl, &adj.selective_color)
                } else {
                    (r_hsl, g_hsl, b_hsl)
                };

                // Apply 3-Way Color Balance
                let (r_cb, g_cb, b_cb) = if do_cb {
                    cb_gains.apply(r_sel, g_sel, b_sel)
                } else {
                    (r_sel, g_sel, b_sel)
                };

                // Apply white-balance gains (as-shot anchored + relative sliders)
                let final_r = (r_cb * gain_r).clamp(0.0, 1.0);
                let final_g = (g_cb * gain_g).clamp(0.0, 1.0);
                let final_b = (b_cb * gain_b).clamp(0.0, 1.0);

                values.push(final_r);
                values.push(final_g);
                values.push(final_b);
                values.push(1.0); // alpha
            }
        }
    }

    values
}

#[derive(Debug, Clone)]
pub struct LUTMeta {
    pub name: String,
    pub size: u32,
    pub values: Vec<f32>,
}

pub fn parse_cube_lut(value: &str) -> Result<LUTMeta, String> {
    let mut name = String::from("");
    let mut size: u32 = 0;
    let mut values: Vec<f32> = Vec::new();

    for line in value.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        } else if line.contains("TITLE") {
            // example: TITLE "M31 - Rec.709_32"
            let mut parts = line.split('"');
            // skip TITLE
            parts.next();
            // assign content inside quotes or default to empty string
            name = parts.next().unwrap_or("").to_string();

            if name.is_empty() {
                return Err(String::from("empty NAME for LUT"));
            }
        } else if line.contains("LUT_3D_SIZE") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            size = parts[1].parse::<u32>().expect("failed to parse lut size");
            values.reserve((size * size * size * 4) as usize);
        } else {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() != 3 {
                debug!("incorrect size of cube values");
                continue;
            }
            let r = parts[0].parse::<f32>().unwrap_or(0.0);
            let g = parts[1].parse::<f32>().unwrap_or(0.0);
            let b = parts[2].parse::<f32>().unwrap_or(0.0);
            values.push(r);
            values.push(g);
            values.push(b);
            values.push(1.0);
        }
    }

    Ok(LUTMeta { name, size, values })
}
