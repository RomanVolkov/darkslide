import { describe, it, expect } from "vitest";
import { hashAdjustments } from "./adjustmentsHash";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import type { Adjustments } from "../backend/types";

describe("hashAdjustments", () => {
    it("returns 0 for null or undefined", () => {
        expect(hashAdjustments(null)).toBe(0);
        expect(hashAdjustments(undefined)).toBe(0);
    });

    it("produces deterministic output for default adjustments", () => {
        const h1 = hashAdjustments(DEFAULT_ADJUSTMENTS);
        const h2 = hashAdjustments(DEFAULT_ADJUSTMENTS);
        expect(h1).toBeTypeOf("number");
        expect(h1).toBeGreaterThan(0);
        expect(h1).toBe(h2);
    });

    it("is invariant to object property insertion order", () => {
        const adjA: Adjustments = {
            light: {
                exposure: 1.5,
                contrast: 10,
                highlights: -5,
                shadows: 20,
                whites: 0,
                blacks: -10,
                brightness: 5,
            },
            color: { temperature: 25, tint: 10 },
            hsl: { hue: 0, saturation: 10, vibrance: 5 },
            detail: {
                black_point: 0,
                texture: 10,
                clarity: 5,
                sharpen: { amount: 25, radius: 1 },
                grain: { amount: 0, size: 0, roughness: 0 },
                denoise: { strength: 0, preserve: 0 },
            },
            rotation: 90,
            lut_id: 2,
            lut_intensity: 80,
            curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }], red: [], green: [], blue: [] },
            as_shot_wb: { kelvin: null, neutral_rgb: null },
            geometry: { straighten: 0, zoom: 1, crop_x: 0, crop_y: 0, distortion: 10, perspective_v: 5, perspective_h: -5 },
            color_balance: DEFAULT_ADJUSTMENTS.color_balance,
            selective_color: DEFAULT_ADJUSTMENTS.selective_color,
        };

        const adjB: Adjustments = {
            curves: { blue: [], green: [], red: [], rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
            lut_intensity: 80,
            lut_id: 2,
            rotation: 90,
            selective_color: DEFAULT_ADJUSTMENTS.selective_color,
            color_balance: DEFAULT_ADJUSTMENTS.color_balance,
            detail: {
                grain: { roughness: 0, size: 0, amount: 0 },
                denoise: { preserve: 0, strength: 0 },
                sharpen: { radius: 1, amount: 25 },
                clarity: 5,
                texture: 10,
                black_point: 0,
            },
            hsl: { vibrance: 5, saturation: 10, hue: 0 },
            color: { tint: 10, temperature: 25 },
            as_shot_wb: { neutral_rgb: null, kelvin: null },
            geometry: { perspective_h: -5, distortion: 10, crop_y: 0, crop_x: 0, zoom: 1, straighten: 0, perspective_v: 5 },
            light: {
                brightness: 5,
                blacks: -10,
                whites: 0,
                shadows: 20,
                highlights: -5,
                contrast: 10,
                exposure: 1.5,
            },
        };

        expect(hashAdjustments(adjA)).toBe(hashAdjustments(adjB));
    });

    it("produces distinct hashes for different adjustment values", () => {
        const base = DEFAULT_ADJUSTMENTS;
        const hBase = hashAdjustments(base);

        const modExp = { ...base, light: { ...base.light, exposure: 0.1 } };
        expect(hashAdjustments(modExp)).not.toBe(hBase);

        const modTint = { ...base, color: { ...base.color, tint: 5 } };
        expect(hashAdjustments(modTint)).not.toBe(hBase);

        const modSat = { ...base, hsl: { ...base.hsl, saturation: 1 } };
        expect(hashAdjustments(modSat)).not.toBe(hBase);

        const modRot = { ...base, rotation: 90 };
        expect(hashAdjustments(modRot)).not.toBe(hBase);

        const modLut = { ...base, lut_id: 1 };
        expect(hashAdjustments(modLut)).not.toBe(hBase);

        const modCurve = { ...base, curves: { ...base.curves, rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] } };
        expect(hashAdjustments(modCurve)).not.toBe(hBase);

        const modRedCurve = { ...base, curves: { ...base.curves, red: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] } };
        expect(hashAdjustments(modRedCurve)).not.toBe(hBase);

        const modDenoise = { ...base, detail: { ...base.detail, denoise: { strength: 40, preserve: 35 } } };
        expect(hashAdjustments(modDenoise)).not.toBe(hBase);

        const modGeometry = { ...base, geometry: { ...base.geometry, zoom: 1.5 } };
        expect(hashAdjustments(modGeometry)).not.toBe(hBase);

        const modDistortion = { ...base, geometry: { ...base.geometry, distortion: 15 } };
        expect(hashAdjustments(modDistortion)).not.toBe(hBase);

        const modPerspV = { ...base, geometry: { ...base.geometry, perspective_v: 10 } };
        expect(hashAdjustments(modPerspV)).not.toBe(hBase);

        const modPerspH = { ...base, geometry: { ...base.geometry, perspective_h: -8 } };
        expect(hashAdjustments(modPerspH)).not.toBe(hBase);

        const modAsShot = { ...base, as_shot_wb: { kelvin: 5200, neutral_rgb: null } };
        expect(hashAdjustments(modAsShot)).not.toBe(hBase);

        const modShadows = {
            ...base,
            color_balance: {
                ...base.color_balance,
                shadows: { ...base.color_balance.shadows, hue: 45 },
            },
        };
        expect(hashAdjustments(modShadows)).not.toBe(hBase);

        const modMidtones = {
            ...base,
            color_balance: {
                ...base.color_balance,
                midtones: { ...base.color_balance.midtones, saturation: 20 },
            },
        };
        expect(hashAdjustments(modMidtones)).not.toBe(hBase);

        const modHighlights = {
            ...base,
            color_balance: {
                ...base.color_balance,
                highlights: { ...base.color_balance.highlights, luminance: -10 },
            },
        };
        expect(hashAdjustments(modHighlights)).not.toBe(hBase);

        const modSelectiveRed = {
            ...base,
            selective_color: {
                ...base.selective_color,
                red: { ...base.selective_color.red, hue: 15 },
            },
        };
        expect(hashAdjustments(modSelectiveRed)).not.toBe(hBase);

        const modSelectiveBlue = {
            ...base,
            selective_color: {
                ...base.selective_color,
                blue: { ...base.selective_color.blue, saturation: -30 },
            },
        };
        expect(hashAdjustments(modSelectiveBlue)).not.toBe(hBase);

        const modSelectiveGreen = {
            ...base,
            selective_color: {
                ...base.selective_color,
                green: { ...base.selective_color.green, luminance: 25 },
            },
        };
        expect(hashAdjustments(modSelectiveGreen)).not.toBe(hBase);
    });

    it("has collision resistance across many continuous variations", () => {
        const hashes = new Set<number>();
        const total = 500;
        for (let i = 0; i < total; i++) {
            const adj = {
                ...DEFAULT_ADJUSTMENTS,
                light: { ...DEFAULT_ADJUSTMENTS.light, exposure: i * 0.01 },
            };
            hashes.add(hashAdjustments(adj));
        }
        expect(hashes.size).toBe(total);
    });
});
