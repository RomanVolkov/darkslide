import { describe, expect, it } from "vitest";
import { Adjustments } from "./types.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";

describe("Adjustments.hasEdits", () => {
    it("reports no edits for defaults", () => {
        expect(Adjustments.hasEdits(DEFAULT_ADJUSTMENTS)).toBe(false);
    });

    it("reports an edit for a relative temperature offset", () => {
        const adj = {
            ...DEFAULT_ADJUSTMENTS,
            color: { ...DEFAULT_ADJUSTMENTS.color, temperature: 25 },
        };
        expect(Adjustments.hasEdits(adj)).toBe(true);
    });

    it("reports no edit when the relative temperature is neutral (0)", () => {
        const adj = { ...DEFAULT_ADJUSTMENTS, color: { temperature: 0, tint: 0 } };
        expect(Adjustments.hasEdits(adj)).toBe(false);
    });

    it("ignores as-shot WB metadata (not a user edit)", () => {
        const adj = {
            ...DEFAULT_ADJUSTMENTS,
            as_shot_wb: { kelvin: 5200, neutral_rgb: [0.5, 1, 2] as [number, number, number] },
        };
        expect(Adjustments.hasEdits(adj)).toBe(false);
    });
});
