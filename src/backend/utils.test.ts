import { describe, expect, it } from "vitest";
import { unpackBatch, unpackThumbnails } from "./utils.ts";
import type { Adjustments } from "./types.ts";

const TEXT_ENCODER = new TextEncoder();

function float32Bytes(v: number): Uint8Array {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    return new Uint8Array(buf);
}

function int32Bytes(v: number): Uint8Array {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, v, true);
    return new Uint8Array(buf);
}

function uint32Bytes(v: number): Uint8Array {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, v, true);
    return new Uint8Array(buf);
}

function float64Bytes(v: number): Uint8Array {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, true);
    return new Uint8Array(buf);
}

function packAdjustmentEntry(
    id: string,
    adj: Adjustments,
    filename: string = id,
): Uint8Array {
    const idBytes = TEXT_ENCODER.encode(id);
    const filenameBytes = TEXT_ENCODER.encode(filename);
    const parts: Uint8Array[] = [];

    parts.push(uint32Bytes(idBytes.length));
    parts.push(idBytes);
    parts.push(uint32Bytes(filenameBytes.length));
    parts.push(filenameBytes);
    parts.push(new Uint8Array([6])); // version

    parts.push(float32Bytes(adj.light.exposure));
    parts.push(int32Bytes(adj.light.contrast));
    parts.push(int32Bytes(adj.light.highlights));
    parts.push(int32Bytes(adj.light.shadows));
    parts.push(int32Bytes(adj.light.whites));
    parts.push(int32Bytes(adj.light.blacks));
    parts.push(int32Bytes(adj.light.brightness));

    parts.push(int32Bytes(adj.color.temperature));
    parts.push(int32Bytes(adj.color.tint));

    parts.push(int32Bytes(adj.hsl.hue));
    parts.push(int32Bytes(adj.hsl.saturation));
    parts.push(int32Bytes(adj.hsl.vibrance));

    parts.push(int32Bytes(adj.detail.black_point));
    parts.push(int32Bytes(adj.detail.texture));
    parts.push(int32Bytes(adj.detail.clarity));
    parts.push(int32Bytes(adj.detail.sharpen.amount));
    parts.push(int32Bytes(adj.detail.sharpen.radius));
    parts.push(int32Bytes(adj.detail.grain.amount));
    parts.push(int32Bytes(adj.detail.grain.size));
    parts.push(int32Bytes(adj.detail.grain.roughness));
    parts.push(int32Bytes(adj.detail.denoise.strength));
    parts.push(int32Bytes(adj.detail.denoise.preserve));

    parts.push(uint32Bytes(adj.rotation));
    parts.push(uint32Bytes(adj.lut_id === null ? 0 : 1));
    parts.push(uint32Bytes(adj.lut_id ?? 0));
    parts.push(uint32Bytes(adj.lut_intensity));

    for (const channel of [adj.curves.rgb, adj.curves.red, adj.curves.green, adj.curves.blue]) {
        parts.push(uint32Bytes(channel.length));
        for (const pt of channel) {
            parts.push(float64Bytes(pt.x));
            parts.push(float64Bytes(pt.y));
        }
    }

    parts.push(uint32Bytes(adj.as_shot_wb.kelvin === null ? 0 : 1));
    parts.push(uint32Bytes(adj.as_shot_wb.kelvin ?? 0));
    parts.push(uint32Bytes(adj.as_shot_wb.neutral_rgb === null ? 0 : 1));
    const wbRgb = adj.as_shot_wb.neutral_rgb ?? [0, 0, 0];
    parts.push(float32Bytes(wbRgb[0]));
    parts.push(float32Bytes(wbRgb[1]));
    parts.push(float32Bytes(wbRgb[2]));

    parts.push(float32Bytes(adj.geometry.straighten));
    parts.push(float32Bytes(adj.geometry.zoom));
    parts.push(float32Bytes(adj.geometry.crop_x));
    parts.push(float32Bytes(adj.geometry.crop_y));
    parts.push(float32Bytes(adj.geometry.distortion));
    parts.push(float32Bytes(adj.geometry.perspective_v));
    parts.push(float32Bytes(adj.geometry.perspective_h));

    for (const tone of [adj.color_balance.shadows, adj.color_balance.midtones, adj.color_balance.highlights]) {
        parts.push(float32Bytes(tone.hue));
        parts.push(float32Bytes(tone.saturation));
        parts.push(float32Bytes(tone.luminance));
    }

    for (const ch of [
        adj.selective_color.red,
        adj.selective_color.orange,
        adj.selective_color.yellow,
        adj.selective_color.green,
        adj.selective_color.aqua,
        adj.selective_color.blue,
        adj.selective_color.purple,
        adj.selective_color.magenta,
    ]) {
        parts.push(float32Bytes(ch.hue));
        parts.push(float32Bytes(ch.saturation));
        parts.push(float32Bytes(ch.luminance));
    }

    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

describe("unpackBatch", () => {
    it("decodes a single binary adjustment entry", () => {
        const adj: Adjustments = {
            light: {
                exposure: 1.5,
                contrast: 10,
                highlights: -20,
                shadows: 30,
                whites: 5,
                blacks: -5,
                brightness: 7,
            },
            color: { temperature: 25, tint: 5 },
            hsl: { hue: 10, saturation: -10, vibrance: 15 },
            detail: {
                black_point: 5,
                texture: 10,
                clarity: -10,
                sharpen: { amount: 25, radius: 1 },
                grain: { amount: 0, size: 10, roughness: 50 },
                denoise: { strength: 30, preserve: 40 },
            },
            curves: {
                rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
                red: [{ x: 0, y: 10 }, { x: 255, y: 245 }],
                green: [],
                blue: [{ x: 128, y: 100 }],
            },
            as_shot_wb: { kelvin: 5200, neutral_rgb: [0.5, 1, 2] },
            rotation: 90,
            geometry: { straighten: 2.5, zoom: 1.25, crop_x: 0.1, crop_y: -0.2, distortion: 10, perspective_v: 5, perspective_h: -5 },
            lut_id: 42,
            lut_intensity: 75,
            color_balance: {
                shadows: { hue: 15, saturation: 20, luminance: -5 },
                midtones: { hue: 45, saturation: 10, luminance: 5 },
                highlights: { hue: 210, saturation: 30, luminance: 0 },
            },
            selective_color: {
                red: { hue: 5, saturation: -10, luminance: 15 },
                orange: { hue: 0, saturation: 25, luminance: 0 },
                yellow: { hue: -5, saturation: 0, luminance: 10 },
                green: { hue: 10, saturation: 30, luminance: -10 },
                aqua: { hue: 0, saturation: 0, luminance: 0 },
                blue: { hue: -15, saturation: 40, luminance: 5 },
                purple: { hue: 0, saturation: 0, luminance: 0 },
                magenta: { hue: 20, saturation: -20, luminance: 0 },
            },
        };
        const bytes = packAdjustmentEntry("img-1", adj, "photo_1.jpg");
        const result = unpackBatch(bytes.buffer)[0];
        if (result === undefined) throw new Error("unpackBatch returned empty");

        expect(result.id).toBe("img-1");
        expect(result.filename).toBe("photo_1.jpg");
        expect(result.adj.light.exposure).toBeCloseTo(adj.light.exposure);
        expect(result.adj.light.contrast).toBe(adj.light.contrast);
        expect(result.adj.light.highlights).toBe(adj.light.highlights);
        expect(result.adj.color.temperature).toBe(adj.color.temperature);
        expect(result.adj.hsl.vibrance).toBe(adj.hsl.vibrance);
        expect(result.adj.detail.sharpen.radius).toBe(adj.detail.sharpen.radius);
        expect(result.adj.detail.grain.roughness).toBe(adj.detail.grain.roughness);
        expect(result.adj.detail.denoise.strength).toBe(adj.detail.denoise.strength);
        expect(result.adj.detail.denoise.preserve).toBe(adj.detail.denoise.preserve);
        expect(result.adj.rotation).toBe(adj.rotation);
        expect(result.adj.lut_id).toBe(adj.lut_id);
        expect(result.adj.lut_intensity).toBe(adj.lut_intensity);
        expect(result.adj.curves).toEqual(adj.curves);
        expect(result.adj.as_shot_wb.kelvin).toBe(adj.as_shot_wb.kelvin);
        expect(result.adj.as_shot_wb.neutral_rgb).toEqual(adj.as_shot_wb.neutral_rgb);
        expect(result.adj.geometry.straighten).toBeCloseTo(adj.geometry.straighten);
        expect(result.adj.geometry.zoom).toBeCloseTo(adj.geometry.zoom);
        expect(result.adj.geometry.crop_x).toBeCloseTo(adj.geometry.crop_x);
        expect(result.adj.geometry.crop_y).toBeCloseTo(adj.geometry.crop_y);
        expect(result.adj.geometry.distortion).toBeCloseTo(adj.geometry.distortion);
        expect(result.adj.geometry.perspective_v).toBeCloseTo(adj.geometry.perspective_v);
        expect(result.adj.geometry.perspective_h).toBeCloseTo(adj.geometry.perspective_h);
        expect(result.adj.color_balance.shadows.hue).toBeCloseTo(adj.color_balance.shadows.hue);
        expect(result.adj.color_balance.shadows.saturation).toBeCloseTo(adj.color_balance.shadows.saturation);
        expect(result.adj.color_balance.shadows.luminance).toBeCloseTo(adj.color_balance.shadows.luminance);
        expect(result.adj.color_balance.midtones.hue).toBeCloseTo(adj.color_balance.midtones.hue);
        expect(result.adj.color_balance.highlights.hue).toBeCloseTo(adj.color_balance.highlights.hue);
        expect(result.adj.selective_color.red.hue).toBeCloseTo(adj.selective_color.red.hue);
        expect(result.adj.selective_color.green.saturation).toBeCloseTo(adj.selective_color.green.saturation);
        expect(result.adj.selective_color.blue.luminance).toBeCloseTo(adj.selective_color.blue.luminance);
    });

    it("decodes null lut_id", () => {
        const adj: Adjustments = {
            light: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, brightness: 0 },
            color: { temperature: 0, tint: 0 },
            hsl: { hue: 0, saturation: 0, vibrance: 0 },
            detail: {
                black_point: 0,
                texture: 0,
                clarity: 0,
                sharpen: { amount: 0, radius: 0 },
                grain: { amount: 0, size: 0, roughness: 0 },
                denoise: { strength: 0, preserve: 0 },
            },
            curves: { rgb: [], red: [], green: [], blue: [] },
            as_shot_wb: { kelvin: null, neutral_rgb: null },
            rotation: 0,
            geometry: { straighten: 0, zoom: 1, crop_x: 0, crop_y: 0, distortion: 0, perspective_v: 0, perspective_h: 0 },
            color_balance: {
                shadows: { hue: 0, saturation: 0, luminance: 0 },
                midtones: { hue: 0, saturation: 0, luminance: 0 },
                highlights: { hue: 0, saturation: 0, luminance: 0 },
            },
            selective_color: {
                red: { hue: 0, saturation: 0, luminance: 0 },
                orange: { hue: 0, saturation: 0, luminance: 0 },
                yellow: { hue: 0, saturation: 0, luminance: 0 },
                green: { hue: 0, saturation: 0, luminance: 0 },
                aqua: { hue: 0, saturation: 0, luminance: 0 },
                blue: { hue: 0, saturation: 0, luminance: 0 },
                purple: { hue: 0, saturation: 0, luminance: 0 },
                magenta: { hue: 0, saturation: 0, luminance: 0 },
            },
            lut_id: null,
            lut_intensity: 0,
        };
        const bytes = packAdjustmentEntry("img-null", adj);
        const result = unpackBatch(bytes.buffer)[0];
        if (result === undefined) throw new Error("unpackBatch returned empty");
        expect(result.filename).toBe("img-null");
        expect(result.adj.lut_id).toBeNull();
    });

    it("throws on unsupported version", () => {
        const idBytes = TEXT_ENCODER.encode("x");
        const filenameBytes = TEXT_ENCODER.encode("f");
        const buf = new ArrayBuffer(4 + idBytes.length + 4 + filenameBytes.length + 1);
        const view = new DataView(buf);
        let offset = 0;
        view.setUint32(offset, idBytes.length, true); offset += 4;
        new Uint8Array(buf).set(idBytes, offset); offset += idBytes.length;
        view.setUint32(offset, filenameBytes.length, true); offset += 4;
        new Uint8Array(buf).set(filenameBytes, offset); offset += filenameBytes.length;
        new Uint8Array(buf)[offset] = 42;
        expect(() => unpackBatch(buf)).toThrow("unsupported adjustment version");
    });
});

describe("unpackThumbnails", () => {
    it("unpacks thumbnails with zero-copy subarray views of the buffer", () => {
        const buf = new ArrayBuffer(4 + 8 + 16 + 8 + 8);
        const dv = new DataView(buf);
        let offset = 0;

        dv.setUint32(offset, 2, true); offset += 4;

        dv.setUint32(offset, 2, true); offset += 4;
        dv.setUint32(offset, 2, true); offset += 4;
        new Uint8Array(buf, offset, 16).fill(128); offset += 16;

        dv.setUint32(offset, 2, true); offset += 4;
        dv.setUint32(offset, 1, true); offset += 4;
        new Uint8Array(buf, offset, 8).fill(200); offset += 8;

        const results = unpackThumbnails(buf);
        expect(results.length).toBe(2);

        expect(results[0]?.width).toBe(2);
        expect(results[0]?.height).toBe(2);
        expect(results[0]?.data.length).toBe(16);
        expect(results[0]?.data[0]).toBe(128);

        expect(results[1]?.width).toBe(2);
        expect(results[1]?.height).toBe(1);
        expect(results[1]?.data.length).toBe(8);
        expect(results[1]?.data[0]).toBe(200);

        // Zero-copy: both views share the underlying ArrayBuffer without cloning
        expect(results[0]?.data.buffer).toBe(buf);
        expect(results[1]?.data.buffer).toBe(buf);
        expect(results[0]?.data.byteOffset).toBe(12);
        expect(results[1]?.data.byteOffset).toBe(36);
    });

    it("throws on buffer too small", () => {
        const buf = new ArrayBuffer(2);
        expect(() => unpackThumbnails(buf)).toThrow("buffer too small");
    });

    it("throws on truncated header", () => {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint32(0, 1, true);
        expect(() => unpackThumbnails(buf)).toThrow("truncated header");
    });
});
