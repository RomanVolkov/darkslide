import type { Adjustments, Curves, ColorBalance, SelectiveColor } from "../backend/types.ts";

/** A single adjustment family that can be profiled in isolation. */
export type AdjustmentGroup = "light" | "curves" | "denoise" | "grain" | "geometry" | "color_balance" | "selective_color";

const LIGHT = { exposure: 0.75, contrast: 18, highlights: -20, shadows: 25, whites: 10, blacks: -8, brightness: 5 };
const COLOR = { temperature: 25, tint: 12 };
const HSL = { hue: 8, saturation: -10, vibrance: 15 };
const DENOISE = { strength: 40, preserve: 35 };
const SHARPEN = { amount: 30, radius: 1 };
const GRAIN = { amount: 25, size: 12, roughness: 45 };
const GEOMETRY = { straighten: 3, zoom: 1.15, crop_x: 0.1, crop_y: -0.05, distortion: 5, perspective_v: 4, perspective_h: -2 };
const CURVES: Curves = {
    rgb: [
        { x: 0, y: 0 },
        { x: 64, y: 48 },
        { x: 128, y: 130 },
        { x: 192, y: 210 },
        { x: 255, y: 255 },
    ],
    red: [
        { x: 0, y: 6 },
        { x: 255, y: 250 },
    ],
    green: [
        { x: 0, y: 0 },
        { x: 128, y: 122 },
        { x: 255, y: 255 },
    ],
    blue: [
        { x: 0, y: 0 },
        { x: 255, y: 248 },
    ],
};

const COLOR_BALANCE: ColorBalance = {
    shadows: { hue: 215, saturation: 28, luminance: -12 },
    midtones: { hue: 42, saturation: 18, luminance: 4 },
    highlights: { hue: 55, saturation: 22, luminance: 8 },
};

const SELECTIVE_COLOR: SelectiveColor = {
    red: { hue: -10, saturation: 15, luminance: -5 },
    orange: { hue: 5, saturation: 20, luminance: 10 },
    yellow: { hue: -15, saturation: -10, luminance: 0 },
    green: { hue: 25, saturation: 30, luminance: -8 },
    aqua: { hue: 0, saturation: 12, luminance: 5 },
    blue: { hue: -20, saturation: 25, luminance: -15 },
    purple: { hue: 15, saturation: -5, luminance: 0 },
    magenta: { hue: 10, saturation: 18, luminance: 6 },
};

/**
 * Apply just one adjustment family (all non-default) so the profiling scenario
 * can measure the render cost each feature contributes. The input is not
 * mutated.
 */
export function applyAdjustmentGroup(adj: Adjustments, group: AdjustmentGroup): Adjustments {
    switch (group) {
        case "light":
            return { ...adj, light: { ...LIGHT } };
        case "curves":
            return { ...adj, curves: structuredClone(CURVES) };
        case "denoise":
            return { ...adj, detail: { ...adj.detail, denoise: { ...DENOISE } } };
        case "grain":
            return { ...adj, detail: { ...adj.detail, grain: { ...GRAIN } } };
        case "geometry":
            return { ...adj, geometry: { ...GEOMETRY } };
        case "color_balance":
            return { ...adj, color_balance: structuredClone(COLOR_BALANCE) };
        case "selective_color":
            return { ...adj, selective_color: structuredClone(SELECTIVE_COLOR) };
    }
}

/**
 * Apply a non-default value to every rendering adjustment so profiling
 * scenarios exercise the deepest possible pipeline (light, relative WB +
 * as-shot baseline, HSL, all four curves, denoise, sharpen, grain, geometry,
 * 3-way color balance, selective color).
 *
 * LUT selection is intentionally left to the caller (it depends on an optional
 * fixture LUT).
 */
export function applyMaximalAdjustments(adj: Adjustments): Adjustments {
    return {
        ...adj,
        light: { ...LIGHT },
        color: { ...COLOR },
        as_shot_wb: { kelvin: 5200, neutral_rgb: [0.9, 1, 1.1] },
        hsl: { ...HSL },
        detail: {
            ...adj.detail,
            black_point: 6,
            texture: 14,
            clarity: 12,
            denoise: { ...DENOISE },
            sharpen: { ...SHARPEN },
            grain: { ...GRAIN },
        },
        rotation: 90,
        geometry: { ...GEOMETRY },
        curves: structuredClone(CURVES),
        color_balance: structuredClone(COLOR_BALANCE),
        selective_color: structuredClone(SELECTIVE_COLOR),
    };
}
