import { describe, expect, it } from "vitest";
import { NAV_SLOTS, SECTIONS, SLIDER_LABELS, SLIDER_MIN, COLOR_BALANCE_NAV_INDEX, SELECTIVE_COLOR_NAV_INDEX } from "./sliderConfig.ts";
import { ADJ_GET, ADJ_SET, DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";

describe("denoise slider wiring", () => {
    it("includes denoise rows in the Denoise section", () => {
        const denoise = SECTIONS.find((s) => s.label === "Denoise");
        expect(denoise?.keys).toContain("denoise_strength");
        expect(denoise?.keys).toContain("denoise_preserve");
    });

    it("includes grain rows in the Grain section", () => {
        const grain = SECTIONS.find((s) => s.label === "Grain");
        expect(grain?.keys).toContain("grain_amount");
        expect(grain?.keys).toContain("grain_size");
        expect(grain?.keys).toContain("grain_roughness");
    });

    it("includes denoise rows in the navigation order", () => {
        expect(NAV_SLOTS).toContain("denoise_strength");
        expect(NAV_SLOTS).toContain("denoise_preserve");
    });

    it("starts denoise sliders at 0", () => {
        expect(SLIDER_MIN.denoise_strength).toBe(0);
        expect(SLIDER_MIN.denoise_preserve).toBe(0);
    });

    it("has human-readable labels", () => {
        expect(SLIDER_LABELS.denoise_strength).toBe("Denoise");
        expect(SLIDER_LABELS.denoise_preserve).toBe("Preserve");
    });

    it("includes the Auto WB and Geometry special rows in navigation order", () => {
        expect(NAV_SLOTS).toContain("auto_wb");
        expect(NAV_SLOTS).toContain("geometry");
        expect(NAV_SLOTS.indexOf("auto_wb")).toBeGreaterThan(NAV_SLOTS.indexOf("tint"));
    });

    it("has a Geometry section containing only the geometry special row", () => {
        const geo = SECTIONS.find((s) => s.label === "Geometry");
        expect(geo?.keys).toEqual([]);
        expect(NAV_SLOTS).toContain("geometry");
        expect(NAV_SLOTS).not.toContain("distortion");
        expect(NAV_SLOTS).not.toContain("perspective_v");
        expect(NAV_SLOTS).not.toContain("perspective_h");

        expect(NAV_SLOTS.indexOf("geometry")).toBe(0);
        expect(NAV_SLOTS.indexOf("exposure")).toBe(1);
    });

    it("includes Color Balance and Selective Color in SECTIONS and NAV_SLOTS in correct order", () => {
        const cbSection = SECTIONS.find((s) => s.label === "Color Balance");
        const scSection = SECTIONS.find((s) => s.label === "Selective Color");
        expect(cbSection).toBeDefined();
        expect(scSection).toBeDefined();

        expect(NAV_SLOTS).toContain("color_balance");
        expect(NAV_SLOTS).toContain("selective_color");

        const vibranceIdx = NAV_SLOTS.indexOf("vibrance");
        const cbIdx = NAV_SLOTS.indexOf("color_balance");
        const scIdx = NAV_SLOTS.indexOf("selective_color");
        const curveIdx = NAV_SLOTS.indexOf("curve");

        expect(cbIdx).toBe(COLOR_BALANCE_NAV_INDEX);
        expect(scIdx).toBe(SELECTIVE_COLOR_NAV_INDEX);

        expect(cbIdx).toBeGreaterThan(vibranceIdx);
        expect(scIdx).toBeGreaterThan(cbIdx);
        expect(curveIdx).toBeGreaterThan(scIdx);
    });

    it("reads and writes denoise values via ADJ_GET/ADJ_SET", () => {
        expect(ADJ_GET.denoise_strength(DEFAULT_ADJUSTMENTS)).toBe(0);
        expect(ADJ_GET.denoise_preserve(DEFAULT_ADJUSTMENTS)).toBe(0);

        const strength = ADJ_SET.denoise_strength(DEFAULT_ADJUSTMENTS, 40);
        expect(ADJ_GET.denoise_strength(strength)).toBe(40);

        const preserve = ADJ_SET.denoise_preserve(strength, 60);
        expect(ADJ_GET.denoise_preserve(preserve)).toBe(60);
        // Strength is preserved when preserve changes.
        expect(ADJ_GET.denoise_strength(preserve)).toBe(40);
    });
});
