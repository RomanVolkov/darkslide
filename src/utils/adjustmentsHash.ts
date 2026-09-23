import type { Adjustments } from "../backend/types";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const floatBuf = new Float64Array(1);
const intBuf = new Int32Array(floatBuf.buffer);

function hashNumber(h: number, n: number): number {
    floatBuf[0] = Object.is(n, -0) ? 0 : (n || 0);
    const low = intBuf[0] ?? 0;
    const high = intBuf[1] ?? 0;
    h = Math.imul(h ^ (low & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((low >>> 8) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((low >>> 16) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((low >>> 24) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ (high & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((high >>> 8) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((high >>> 16) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((high >>> 24) & 0xff), FNV_PRIME);
    return h >>> 0;
}

export function hashAdjustments(adj: Adjustments | null | undefined): number {
    if (!adj) return 0;

    let h = FNV_OFFSET;

    const light = adj.light;
    h = hashNumber(h, light?.exposure ?? 0);
    h = hashNumber(h, light?.contrast ?? 0);
    h = hashNumber(h, light?.highlights ?? 0);
    h = hashNumber(h, light?.shadows ?? 0);
    h = hashNumber(h, light?.whites ?? 0);
    h = hashNumber(h, light?.blacks ?? 0);
    h = hashNumber(h, light?.brightness ?? 0);

    const color = adj.color;
    h = hashNumber(h, color?.temperature ?? 0);
    h = hashNumber(h, color?.tint ?? 0);

    const hsl = adj.hsl;
    h = hashNumber(h, hsl?.hue ?? 0);
    h = hashNumber(h, hsl?.saturation ?? 0);
    h = hashNumber(h, hsl?.vibrance ?? 0);

    const detail = adj.detail;
    h = hashNumber(h, detail?.black_point ?? 0);
    h = hashNumber(h, detail?.texture ?? 0);
    h = hashNumber(h, detail?.clarity ?? 0);
    h = hashNumber(h, detail?.sharpen?.amount ?? 0);
    h = hashNumber(h, detail?.sharpen?.radius ?? 0);
    h = hashNumber(h, detail?.grain?.amount ?? 0);
    h = hashNumber(h, detail?.grain?.size ?? 0);
    h = hashNumber(h, detail?.grain?.roughness ?? 0);
    h = hashNumber(h, detail?.denoise?.strength ?? 0);
    h = hashNumber(h, detail?.denoise?.preserve ?? 0);

    h = hashNumber(h, adj.rotation ?? 0);

    if (adj.lut_id !== null && adj.lut_id !== undefined) {
        h = Math.imul(h ^ 1, FNV_PRIME) >>> 0;
        h = hashNumber(h, adj.lut_id);
    } else {
        h = Math.imul(h ^ 0, FNV_PRIME) >>> 0;
    }

    h = hashNumber(h, adj.lut_intensity ?? 0);

    const geometry = adj.geometry;
    h = hashNumber(h, geometry?.straighten ?? 0);
    h = hashNumber(h, geometry?.zoom ?? 1);
    h = hashNumber(h, geometry?.crop_x ?? 0);
    h = hashNumber(h, geometry?.crop_y ?? 0);
    h = hashNumber(h, geometry?.distortion ?? 0);
    h = hashNumber(h, geometry?.perspective_v ?? 0);
    h = hashNumber(h, geometry?.perspective_h ?? 0);

    const wb = adj.as_shot_wb;
    h = hashNumber(h, wb?.kelvin ?? -1);
    const neutral = wb?.neutral_rgb;
    if (neutral) {
        h = Math.imul(h ^ 1, FNV_PRIME) >>> 0;
        h = hashNumber(h, neutral[0]);
        h = hashNumber(h, neutral[1]);
        h = hashNumber(h, neutral[2]);
    } else {
        h = Math.imul(h ^ 0, FNV_PRIME) >>> 0;
    }

    const curves = adj.curves;
    for (const channel of [curves?.rgb, curves?.red, curves?.green, curves?.blue]) {
        const len = channel ? channel.length : 0;
        h = hashNumber(h, len);
        if (channel) {
            for (let i = 0; i < len; i++) {
                const pt = channel[i];
                h = hashNumber(h, pt?.x ?? 0);
                h = hashNumber(h, pt?.y ?? 0);
            }
        }
    }

    const cb = adj.color_balance;
    for (const tone of [cb?.shadows, cb?.midtones, cb?.highlights]) {
        h = hashNumber(h, tone?.hue ?? 0);
        h = hashNumber(h, tone?.saturation ?? 0);
        h = hashNumber(h, tone?.luminance ?? 0);
    }

    const sc = adj.selective_color;
    for (const ch of [
        sc?.red,
        sc?.orange,
        sc?.yellow,
        sc?.green,
        sc?.aqua,
        sc?.blue,
        sc?.purple,
        sc?.magenta,
    ]) {
        h = hashNumber(h, ch?.hue ?? 0);
        h = hashNumber(h, ch?.saturation ?? 0);
        h = hashNumber(h, ch?.luminance ?? 0);
    }

    return h >>> 0;
}
