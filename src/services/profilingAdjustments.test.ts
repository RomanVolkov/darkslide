import { describe, expect, it } from "vitest";
import { applyAdjustmentGroup, applyMaximalAdjustments } from "./profilingAdjustments.ts";
import { ADJ_GET, DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import type { AdjustmentKey } from "../types/index.ts";

const RENDERING_KEYS: AdjustmentKey[] = [
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "brightness",
    "temperature",
    "tint",
    "hue",
    "saturation",
    "vibrance",
    "texture",
    "clarity",
    "black_point",
    "denoise_strength",
    "denoise_preserve",
    "sharpen_amount",
    "sharpen_radius",
    "grain_amount",
    "grain_size",
    "grain_roughness",
    "straighten",
    "zoom",
    "crop_x",
    "crop_y",
    "distortion",
    "perspective_v",
    "perspective_h",
];

describe("applyMaximalAdjustments", () => {
    it("sets every rendering adjustment to a non-default value", () => {
        const adj = applyMaximalAdjustments(DEFAULT_ADJUSTMENTS);
        for (const key of RENDERING_KEYS) {
            expect(ADJ_GET[key](adj), key).not.toBe(ADJ_GET[key](DEFAULT_ADJUSTMENTS));
        }
    });

    it("sets all four curves and the as-shot WB to non-default values", () => {
        const adj = applyMaximalAdjustments(DEFAULT_ADJUSTMENTS);
        expect(adj.curves.rgb).not.toEqual(DEFAULT_ADJUSTMENTS.curves.rgb);
        expect(adj.curves.red).not.toEqual(DEFAULT_ADJUSTMENTS.curves.red);
        expect(adj.curves.green).not.toEqual(DEFAULT_ADJUSTMENTS.curves.green);
        expect(adj.curves.blue).not.toEqual(DEFAULT_ADJUSTMENTS.curves.blue);
        expect(adj.as_shot_wb).not.toEqual(DEFAULT_ADJUSTMENTS.as_shot_wb);
        expect(adj.rotation).not.toBe(0);
    });

    it("does not mutate the input adjustments", () => {
        const before = structuredClone(DEFAULT_ADJUSTMENTS);
        applyMaximalAdjustments(DEFAULT_ADJUSTMENTS);
        expect(DEFAULT_ADJUSTMENTS).toEqual(before);
    });
});

describe("applyAdjustmentGroup", () => {
    it("touches only the requested family", () => {
        const base = DEFAULT_ADJUSTMENTS;

        const light = applyAdjustmentGroup(base, "light");
        expect(light.light.exposure).not.toBe(0);
        expect(light.geometry).toEqual(base.geometry);
        expect(light.detail.denoise).toEqual(base.detail.denoise);
        expect(light.curves).toEqual(base.curves);

        const denoise = applyAdjustmentGroup(base, "denoise");
        expect(denoise.detail.denoise.strength).toBeGreaterThan(0);
        expect(denoise.light.exposure).toBe(0);
        expect(denoise.geometry).toEqual(base.geometry);

        const geometry = applyAdjustmentGroup(base, "geometry");
        expect(geometry.geometry.zoom).toBeGreaterThan(1);
        expect(geometry.light.exposure).toBe(0);

        const curves = applyAdjustmentGroup(base, "curves");
        expect(curves.curves).not.toEqual(base.curves);
        expect(curves.light.exposure).toBe(0);
    });

    it("does not mutate the input adjustments", () => {
        const before = structuredClone(DEFAULT_ADJUSTMENTS);
        applyAdjustmentGroup(DEFAULT_ADJUSTMENTS, "curves");
        applyAdjustmentGroup(DEFAULT_ADJUSTMENTS, "denoise");
        expect(DEFAULT_ADJUSTMENTS).toEqual(before);
    });
});
