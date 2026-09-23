import type { AdjustmentKey } from "../../types/index.ts";

// Sidebar sections group related sliders.
export const SECTIONS: Array<{ label: string; keys: AdjustmentKey[] }> = [
    { label: "Geometry", keys: [] },
    { label: "Light", keys: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "brightness"] },
    { label: "Color", keys: ["temperature", "tint"] },
    { label: "H&S", keys: ["hue", "saturation", "vibrance"] },
    { label: "Color Balance", keys: [] },
    { label: "Selective Color", keys: [] },
    { label: "Curve", keys: [] },
    { label: "Detail", keys: ["black_point", "sharpen_amount", "sharpen_radius"] },
    { label: "Denoise", keys: ["denoise_strength", "denoise_preserve"] },
    { label: "Grain", keys: ["grain_amount", "grain_size", "grain_roughness"] },
    { label: "LUT", keys: ["lut_intensity"] },
];

/** Navigation slots: AdjustmentKey entries plus non-slider special rows. */
export type NavSlot = AdjustmentKey | "curve" | "geometry" | "auto_wb" | "lut" | "color_balance" | "selective_color";

// Navigation order: every slider key in visual order, with special rows at
// their visual positions.
export const NAV_SLOTS: NavSlot[] = SECTIONS.flatMap((s) => {
    if (s.label === "Curve") return ["curve" as const];
    if (s.label === "Geometry") return ["geometry" as const, ...s.keys];
    if (s.label === "LUT") return ["lut" as const, ...s.keys];
    if (s.label === "Color") return [...s.keys, "auto_wb" as const];
    if (s.label === "Color Balance") return ["color_balance" as const];
    if (s.label === "Selective Color") return ["selective_color" as const];
    return s.keys;
});
export const CURVE_NAV_INDEX = NAV_SLOTS.indexOf("curve");
export const GEOMETRY_NAV_INDEX = NAV_SLOTS.indexOf("geometry");
export const AUTO_WB_NAV_INDEX = NAV_SLOTS.indexOf("auto_wb");
export const LUT_NAV_INDEX = NAV_SLOTS.indexOf("lut");
export const COLOR_BALANCE_NAV_INDEX = NAV_SLOTS.indexOf("color_balance");
export const SELECTIVE_COLOR_NAV_INDEX = NAV_SLOTS.indexOf("selective_color");

// Human-readable labels for keys whose name isn't self-explanatory.
export const SLIDER_LABELS: Partial<Record<AdjustmentKey, string>> = {
    black_point: "Black Point",
    denoise_strength: "Denoise",
    denoise_preserve: "Preserve",
    sharpen_amount: "Sharpen",
    sharpen_radius: "Radius",
    grain_amount: "Grain",
    grain_size: "Size",
    grain_roughness: "Roughness",
    lut_intensity: "Intensity"
};

// Sliders that start at 0 instead of –100.
export const SLIDER_MIN: Partial<Record<AdjustmentKey, number>> = {
    exposure: -3.0,
    black_point: 0,
    denoise_strength: 0,
    denoise_preserve: 0,
    sharpen_amount: 0,
    sharpen_radius: 0,
    grain_amount: 0,
    grain_size: 0,
    grain_roughness: 0,
    lut_intensity: 0
};

// Sliders that end at a value other than 100.
export const SLIDER_MAX: Partial<Record<AdjustmentKey, number>> = {
    exposure: 3.0,
};

// Small step (h/l) overrides per key.
export const SLIDER_STEP: Partial<Record<AdjustmentKey, number>> = {
    temperature: 1,
    tint: 1,
    exposure: 0.05,
};

// Big step (H/L) overrides per key.
export const SLIDER_STEP_BIG: Partial<Record<AdjustmentKey, number>> = {
    temperature: 10,
    tint: 10,
    exposure: 0.5,
};

// Custom display formatter per key.
export const SLIDER_FORMAT: Partial<Record<AdjustmentKey, (v: number) => string>> = {
    temperature: (v) => (v > 0 ? `+${v}` : `${v}`),
    tint: (v) => (v > 0 ? `+${v}` : `${v}`),
    exposure: (v) => v.toFixed(2),
};

// Gradient tracks visually show the color range each slider controls.
export const SLIDER_GRADIENTS: Partial<Record<AdjustmentKey, string>> = {
    temperature: "linear-gradient(to right, #5b9bd5, #f0f0f0, #e8891c)",
    tint: "linear-gradient(to right, #4aab5c, #f0f0f0, #c45ca8)",
    hue: "linear-gradient(to right, hsl(0,90%,55%), hsl(60,90%,55%), hsl(120,90%,45%), hsl(180,90%,45%), hsl(240,90%,60%), hsl(300,90%,55%), hsl(360,90%,55%))",
    saturation: "linear-gradient(to right, #808080, #e04040)",
    vibrance: "linear-gradient(to right, #666666, #4472c4)",
};
