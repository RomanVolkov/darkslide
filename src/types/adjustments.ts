import type { Adjustments, ColorBalance, CurvePoint, Curves, SelectiveChannel, SelectiveColor, ToneBalance } from "../backend/types.ts";
import type { AdjustmentKey } from "./index.ts";

export const DEFAULT_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export const DEFAULT_CURVES: Curves = {
    rgb: [...DEFAULT_CURVE],
    red: [...DEFAULT_CURVE],
    green: [...DEFAULT_CURVE],
    blue: [...DEFAULT_CURVE],
};

export const DEFAULT_TONE_BALANCE: ToneBalance = { hue: 0, saturation: 0, luminance: 0 };

export const DEFAULT_COLOR_BALANCE: ColorBalance = {
    shadows: { ...DEFAULT_TONE_BALANCE },
    midtones: { ...DEFAULT_TONE_BALANCE },
    highlights: { ...DEFAULT_TONE_BALANCE },
};

export const DEFAULT_SELECTIVE_CHANNEL: SelectiveChannel = { hue: 0, saturation: 0, luminance: 0 };

export const DEFAULT_SELECTIVE_COLOR: SelectiveColor = {
    red: { ...DEFAULT_SELECTIVE_CHANNEL },
    orange: { ...DEFAULT_SELECTIVE_CHANNEL },
    yellow: { ...DEFAULT_SELECTIVE_CHANNEL },
    green: { ...DEFAULT_SELECTIVE_CHANNEL },
    aqua: { ...DEFAULT_SELECTIVE_CHANNEL },
    blue: { ...DEFAULT_SELECTIVE_CHANNEL },
    purple: { ...DEFAULT_SELECTIVE_CHANNEL },
    magenta: { ...DEFAULT_SELECTIVE_CHANNEL },
};

export const DEFAULT_ADJUSTMENTS: Adjustments = {
    light: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, brightness: 0 },
    color: { temperature: 0, tint: 0 },
    hsl: { hue: 0, saturation: 0, vibrance: 0 },
    detail: { black_point: 0, texture: 0, clarity: 0, sharpen: { amount: 0, radius: 0 }, grain: { amount: 0, size: 0, roughness: 0 }, denoise: { strength: 0, preserve: 0 } },
    curves: DEFAULT_CURVES,
    as_shot_wb: { kelvin: null, neutral_rgb: null },
    rotation: 0,
    geometry: { straighten: 0, zoom: 1, crop_x: 0, crop_y: 0, distortion: 0, perspective_v: 0, perspective_h: 0 },
    color_balance: DEFAULT_COLOR_BALANCE,
    selective_color: DEFAULT_SELECTIVE_COLOR,
    lut_id: null,
    lut_intensity: 0,
};

export const ADJ_GET: Record<AdjustmentKey, (a: Adjustments) => number> = {
    exposure: (a) => a.light.exposure,
    contrast: (a) => a.light.contrast,
    highlights: (a) => a.light.highlights,
    shadows: (a) => a.light.shadows,
    whites: (a) => a.light.whites,
    blacks: (a) => a.light.blacks,
    brightness: (a) => a.light.brightness,
    temperature: (a) => a.color.temperature,
    tint: (a) => a.color.tint,
    hue: (a) => a.hsl.hue,
    saturation: (a) => a.hsl.saturation,
    vibrance: (a) => a.hsl.vibrance,
    texture: (a) => a.detail.texture,
    clarity: (a) => a.detail.clarity,
    black_point: (a) => a.detail.black_point,
    sharpen_amount: (a) => a.detail.sharpen.amount,
    sharpen_radius: (a) => a.detail.sharpen.radius,
    grain_amount: (a) => a.detail.grain.amount,
    grain_size: (a) => a.detail.grain.size,
    grain_roughness: (a) => a.detail.grain.roughness,
    denoise_strength: (a) => a.detail.denoise.strength,
    denoise_preserve: (a) => a.detail.denoise.preserve,
    straighten: (a) => a.geometry.straighten,
    zoom: (a) => a.geometry.zoom,
    crop_x: (a) => a.geometry.crop_x,
    crop_y: (a) => a.geometry.crop_y,
    distortion: (a) => a.geometry.distortion,
    perspective_v: (a) => a.geometry.perspective_v,
    perspective_h: (a) => a.geometry.perspective_h,
    lut_intensity: (a) => a.lut_intensity,
};

export const ADJ_SET: Record<AdjustmentKey, (a: Adjustments, v: number) => Adjustments> = {
    exposure: (a, v) => ({ ...a, light: { ...a.light, exposure: v } }),
    contrast: (a, v) => ({ ...a, light: { ...a.light, contrast: v } }),
    highlights: (a, v) => ({ ...a, light: { ...a.light, highlights: v } }),
    shadows: (a, v) => ({ ...a, light: { ...a.light, shadows: v } }),
    whites: (a, v) => ({ ...a, light: { ...a.light, whites: v } }),
    blacks: (a, v) => ({ ...a, light: { ...a.light, blacks: v } }),
    brightness: (a, v) => ({ ...a, light: { ...a.light, brightness: v } }),
    temperature: (a, v) => ({ ...a, color: { ...a.color, temperature: v } }),
    tint: (a, v) => ({ ...a, color: { ...a.color, tint: v } }),
    hue: (a, v) => ({ ...a, hsl: { ...a.hsl, hue: v } }),
    saturation: (a, v) => ({ ...a, hsl: { ...a.hsl, saturation: v } }),
    vibrance: (a, v) => ({ ...a, hsl: { ...a.hsl, vibrance: v } }),
    texture: (a, v) => ({ ...a, detail: { ...a.detail, texture: v } }),
    clarity: (a, v) => ({ ...a, detail: { ...a.detail, clarity: v } }),
    black_point: (a, v) => ({ ...a, detail: { ...a.detail, black_point: v } }),
    sharpen_amount: (a, v) => ({ ...a, detail: { ...a.detail, sharpen: { ...a.detail.sharpen, amount: v } } }),
    sharpen_radius: (a, v) => ({ ...a, detail: { ...a.detail, sharpen: { ...a.detail.sharpen, radius: v } } }),
    grain_amount: (a, v) => ({ ...a, detail: { ...a.detail, grain: { ...a.detail.grain, amount: v } } }),
    grain_size: (a, v) => ({ ...a, detail: { ...a.detail, grain: { ...a.detail.grain, size: v } } }),
    grain_roughness: (a, v) => ({ ...a, detail: { ...a.detail, grain: { ...a.detail.grain, roughness: v } } }),
    denoise_strength: (a, v) => ({ ...a, detail: { ...a.detail, denoise: { ...a.detail.denoise, strength: v } } }),
    denoise_preserve: (a, v) => ({ ...a, detail: { ...a.detail, denoise: { ...a.detail.denoise, preserve: v } } }),
    straighten: (a, v) => ({ ...a, geometry: { ...a.geometry, straighten: v } }),
    zoom: (a, v) => ({ ...a, geometry: { ...a.geometry, zoom: v } }),
    crop_x: (a, v) => ({ ...a, geometry: { ...a.geometry, crop_x: v } }),
    crop_y: (a, v) => ({ ...a, geometry: { ...a.geometry, crop_y: v } }),
    distortion: (a, v) => ({ ...a, geometry: { ...a.geometry, distortion: v } }),
    perspective_v: (a, v) => ({ ...a, geometry: { ...a.geometry, perspective_v: v } }),
    perspective_h: (a, v) => ({ ...a, geometry: { ...a.geometry, perspective_h: v } }),
    lut_intensity: (a, v) => ({ ...a, lut_intensity: v }),
};

/**
 * Fill in any missing nested adjustment fields from the defaults.
 *
 * Adjustment objects can come from older records or partial updates; without
 * this, reading a missing sub-object (e.g. `detail.denoise`) throws during
 * render and takes down the whole UI. Use before reading or writing edits.
 */
export function normalizeAdjustments(a: Partial<Adjustments> | null | undefined): Adjustments {
    const src = a ?? {};
    return {
        light: { ...DEFAULT_ADJUSTMENTS.light, ...src.light },
        color: { ...DEFAULT_ADJUSTMENTS.color, ...src.color },
        hsl: { ...DEFAULT_ADJUSTMENTS.hsl, ...src.hsl },
        detail: {
            ...DEFAULT_ADJUSTMENTS.detail,
            ...src.detail,
            sharpen: { ...DEFAULT_ADJUSTMENTS.detail.sharpen, ...src.detail?.sharpen },
            grain: { ...DEFAULT_ADJUSTMENTS.detail.grain, ...src.detail?.grain },
            denoise: { ...DEFAULT_ADJUSTMENTS.detail.denoise, ...src.detail?.denoise },
        },
        curves: { ...DEFAULT_ADJUSTMENTS.curves, ...src.curves },
        as_shot_wb: src.as_shot_wb ?? DEFAULT_ADJUSTMENTS.as_shot_wb,
        rotation: src.rotation ?? DEFAULT_ADJUSTMENTS.rotation,
        geometry: { ...DEFAULT_ADJUSTMENTS.geometry, ...src.geometry },
        color_balance: {
            shadows: { ...DEFAULT_TONE_BALANCE, ...src.color_balance?.shadows },
            midtones: { ...DEFAULT_TONE_BALANCE, ...src.color_balance?.midtones },
            highlights: { ...DEFAULT_TONE_BALANCE, ...src.color_balance?.highlights },
        },
        selective_color: {
            red: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.red },
            orange: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.orange },
            yellow: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.yellow },
            green: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.green },
            aqua: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.aqua },
            blue: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.blue },
            purple: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.purple },
            magenta: { ...DEFAULT_SELECTIVE_CHANNEL, ...src.selective_color?.magenta },
        },
        lut_id: src.lut_id ?? null,
        lut_intensity: src.lut_intensity ?? DEFAULT_ADJUSTMENTS.lut_intensity,
    };
}
