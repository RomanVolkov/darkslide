import { describe, it, expect } from "vitest";
import { curatedLook } from "./screenshotScenario.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";

describe("curatedLook", () => {
    it("produces a visible, valid grade", () => {
        const adj = curatedLook(structuredClone(DEFAULT_ADJUSTMENTS), 0);
        expect(adj.light.exposure).toBeGreaterThan(0);
        expect(adj.light.contrast).toBeGreaterThan(0);
        expect(adj.hsl.vibrance).toBeGreaterThan(0);
        expect(adj.curves.rgb.length).toBeGreaterThanOrEqual(3);
        expect(adj.curves.red.length).toBeGreaterThanOrEqual(2);
        expect(adj.geometry.zoom).toBe(1);
        expect(adj.lut_id).toBeNull();
    });

    it("preserves as-shot white balance and does not mutate the input", () => {
        const base = structuredClone(DEFAULT_ADJUSTMENTS);
        base.as_shot_wb = { kelvin: 5200, neutral_rgb: [0.9, 1, 1.1] };
        const before = structuredClone(base);
        const adj = curatedLook(base, 1);
        expect(adj.as_shot_wb).toEqual(before.as_shot_wb);
        expect(base).toEqual(before);
    });

    it("varies exposure and temperature across variants", () => {
        const a = curatedLook(structuredClone(DEFAULT_ADJUSTMENTS), 0);
        const c = curatedLook(structuredClone(DEFAULT_ADJUSTMENTS), 2);
        expect(a.light.exposure).not.toBe(c.light.exposure);
        expect(a.color.temperature).not.toBe(c.color.temperature);
    });
});
