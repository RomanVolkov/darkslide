export interface CurvePoint {
    x: number;
    y: number;
}

export interface Histogram {
    red: Uint32Array;
    green: Uint32Array;
    blue: Uint32Array;
    luma: Uint32Array;
}

export interface PixelData {
    kind: "raw";
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

export interface Light {
    exposure: number;
    contrast: number;
    highlights: number;
    shadows: number;
    whites: number;
    blacks: number;
    brightness: number;
}

export interface Color {
    /** Relative white-balance temperature offset in -100..100 (0 = neutral). */
    temperature: number;
    /** Relative green/magenta tint offset in -100..100 (0 = neutral). */
    tint: number;
}

/** As-shot white balance read from image metadata. */
export interface AsShotWb {
    /** Color temperature in Kelvin, or null when no tag is present. */
    kelvin: number | null;
    /**
     * Linear RGB neutral multipliers normalized so green = 1.0, or null. The
     * renderer derives correction gains as the reciprocal of these values.
     */
    neutral_rgb: [number, number, number] | null;
}

export interface HSL {
    hue: number;
    saturation: number;
    vibrance: number;
}

export interface Sharpen {
    amount: number;
    radius: number;
}

export interface Grain {
    amount: number;
    size: number;
    roughness: number;
}

export interface Denoise {
    strength: number;
    preserve: number;
}

export interface Detail {
    black_point: number;
    texture: number;
    clarity: number;
    sharpen: Sharpen;
    grain: Grain;
    denoise: Denoise;
}

/** Per-channel tone curves: `rgb` (master) plus `red`/`green`/`blue`. */
export interface Curves {
    rgb: CurvePoint[];
    red: CurvePoint[];
    green: CurvePoint[];
    blue: CurvePoint[];
}

/** Crop/straighten geometry. `zoom` 1.0 fills the frame. */
export interface Geometry {
    straighten: number;
    zoom: number;
    crop_x: number;
    crop_y: number;
    distortion: number;
    perspective_v: number;
    perspective_h: number;
}

export interface ToneBalance {
    hue: number;
    saturation: number;
    luminance: number;
}

export interface ColorBalance {
    shadows: ToneBalance;
    midtones: ToneBalance;
    highlights: ToneBalance;
}

export interface SelectiveChannel {
    hue: number;
    saturation: number;
    luminance: number;
}

export interface SelectiveColor {
    red: SelectiveChannel;
    orange: SelectiveChannel;
    yellow: SelectiveChannel;
    green: SelectiveChannel;
    aqua: SelectiveChannel;
    blue: SelectiveChannel;
    purple: SelectiveChannel;
    magenta: SelectiveChannel;
}

export interface Adjustments {
    light: Light;
    color: Color;
    hsl: HSL;
    curves: Curves;
    detail: Detail;
    /** Read-only as-shot white balance anchoring the relative color sliders. */
    as_shot_wb: AsShotWb;
    rotation: number;
    geometry: Geometry;
    color_balance: ColorBalance;
    selective_color: SelectiveColor;
    // this one is not adjustment itself
    lut_id: number | null;
    lut_intensity: number;
}

import type { AdjustmentKey } from "../types";
import { ADJ_GET, DEFAULT_ADJUSTMENTS, DEFAULT_CURVE } from "../types/adjustments";

export namespace Adjustments {
    const curveEdited = (c: CurvePoint[] | undefined): boolean => {
        const def = DEFAULT_CURVE;
        if (!c || c.length !== def.length) return true;
        return c.some((pt, i) => {
            const d = def[i];
            return d === undefined || pt.x !== d.x || pt.y !== d.y;
        });
    };

    export function hasEdits(adj: Adjustments): boolean {
        if ((Object.keys(ADJ_GET) as AdjustmentKey[]).some((k) => ADJ_GET[k](adj) !== ADJ_GET[k](DEFAULT_ADJUSTMENTS))) return true;
        if (adj.rotation !== 0) return true;
        const c = adj.curves;
        if (curveEdited(c?.rgb) || curveEdited(c?.red) || curveEdited(c?.green) || curveEdited(c?.blue)) return true;
        const cb = adj.color_balance;
        if (cb && (
            cb.shadows?.saturation !== 0 || cb.shadows?.luminance !== 0 ||
            cb.midtones?.saturation !== 0 || cb.midtones?.luminance !== 0 ||
            cb.highlights?.saturation !== 0 || cb.highlights?.luminance !== 0
        )) return true;
        const sc = adj.selective_color;
        if (sc && (
            (sc.red?.hue !== 0 || sc.red?.saturation !== 0 || sc.red?.luminance !== 0) ||
            (sc.orange?.hue !== 0 || sc.orange?.saturation !== 0 || sc.orange?.luminance !== 0) ||
            (sc.yellow?.hue !== 0 || sc.yellow?.saturation !== 0 || sc.yellow?.luminance !== 0) ||
            (sc.green?.hue !== 0 || sc.green?.saturation !== 0 || sc.green?.luminance !== 0) ||
            (sc.aqua?.hue !== 0 || sc.aqua?.saturation !== 0 || sc.aqua?.luminance !== 0) ||
            (sc.blue?.hue !== 0 || sc.blue?.saturation !== 0 || sc.blue?.luminance !== 0) ||
            (sc.purple?.hue !== 0 || sc.purple?.saturation !== 0 || sc.purple?.luminance !== 0) ||
            (sc.magenta?.hue !== 0 || sc.magenta?.saturation !== 0 || sc.magenta?.luminance !== 0)
        )) return true;
        return false;
    }
}


export interface LoadedImage {
    id: string;
    filename: string;
    adjustments: Adjustments;
}
