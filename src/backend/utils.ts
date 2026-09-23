import type {
    Adjustments,
    AsShotWb,
    ColorBalance,
    CurvePoint,
    Curves,
    PixelData,
    SelectiveChannel,
    SelectiveColor,
    ToneBalance,
} from "./types.ts";

const BATCH_VERSION = 6;

/**
 * Parse the binary buffer returned by `load_images_batch`.
 *
 * Layout per image (repeated until end of buffer):
 *   [id_len: u32 LE] [id: UTF-8]
 *   [filename_len: u32 LE] [filename: UTF-8]
 *   [version: u8]
 *   [light:   exposure f32 LE, contrast i32 LE, highlights i32 LE,
 *             shadows i32 LE, whites i32 LE, blacks i32 LE, brightness i32 LE]
 *   [color:   temperature i32 LE, tint i32 LE]
 *   [hsl:     hue i32 LE, saturation i32 LE, vibrance i32 LE]
 *   [detail:  black_point i32 LE, texture i32 LE, clarity i32 LE,
 *             sharpen.amount i32 LE, sharpen.radius i32 LE,
 *             grain.amount i32 LE, grain.size i32 LE, grain.roughness i32 LE,
 *             denoise.strength i32 LE, denoise.preserve i32 LE]
 *   [rotation: u32 LE]
 *   [lut_id_present: u32 LE] [lut_id: u32 LE]
 *   [lut_intensity: u32 LE]
 *   [curve_rgb_len: u32 LE] then points...; same for red, green, blue
 *   [wb_kelvin_present: u32 LE] [wb_kelvin: u32 LE]
 *   [wb_neutral_present: u32 LE] [neutral_r: f32 LE] [neutral_g: f32 LE] [neutral_b: f32 LE]
 *   [geometry: straighten f32 LE, zoom f32 LE, crop_x f32 LE, crop_y f32 LE, distortion f32 LE, perspective_v f32 LE, perspective_h f32 LE]
 *   [color_balance: shadows, midtones, highlights (9 f32 LE)]
 *   [selective_color: red..magenta (24 f32 LE)]
 */
export function unpackBatch(buf: ArrayBuffer): Array<{ id: string; filename: string; adj: Adjustments }> {
    const dv = new DataView(buf);
    const dec = new TextDecoder();
    const results: Array<{ id: string; filename: string; adj: Adjustments }> = [];
    let offset = 0;

    const need = (n: number, what: string) => {
        if (offset + n > buf.byteLength) {
            throw new Error(`unpackBatch: truncated ${what} at ${offset}`);
        }
    };

    while (offset < buf.byteLength) {
        need(4, "id length header");
        const idLen = dv.getUint32(offset, true); offset += 4;
        need(idLen, "id");
        const id = dec.decode(new Uint8Array(buf, offset, idLen)); offset += idLen;

        need(4, "filename length header");
        const filenameLen = dv.getUint32(offset, true); offset += 4;
        need(filenameLen, "filename");
        const filename = dec.decode(new Uint8Array(buf, offset, filenameLen)); offset += filenameLen;

        need(1, "version");
        const version = dv.getUint8(offset); offset += 1;
        if (version !== BATCH_VERSION) {
            throw new Error(`unpackBatch: unsupported adjustment version ${version}`);
        }

        const readFloat = () => {
            need(4, "f32");
            const v = dv.getFloat32(offset, true); offset += 4; return v;
        };
        const readInt = () => {
            need(4, "i32");
            const v = dv.getInt32(offset, true); offset += 4; return v;
        };
        const readUInt = () => {
            need(4, "u32");
            const v = dv.getUint32(offset, true); offset += 4; return v;
        };

        const light: Adjustments["light"] = {
            exposure: readFloat(),
            contrast: readInt(),
            highlights: readInt(),
            shadows: readInt(),
            whites: readInt(),
            blacks: readInt(),
            brightness: readInt(),
        };
        const color: Adjustments["color"] = {
            temperature: readInt(),
            tint: readInt(),
        };
        const hsl: Adjustments["hsl"] = {
            hue: readInt(),
            saturation: readInt(),
            vibrance: readInt(),
        };
        const detail: Adjustments["detail"] = {
            black_point: readInt(),
            texture: readInt(),
            clarity: readInt(),
            sharpen: { amount: readInt(), radius: readInt() },
            grain: { amount: readInt(), size: readInt(), roughness: readInt() },
            denoise: { strength: readInt(), preserve: readInt() },
        };
        const rotation = readUInt();
        const lutIdPresent = readUInt();
        const lutIdValue = readUInt();
        const lut_id: number | null = lutIdPresent ? lutIdValue : null;
        const lut_intensity = readUInt();

        const readCurve = (): CurvePoint[] => {
            const len = readUInt();
            const pts: CurvePoint[] = [];
            for (let i = 0; i < len; i++) {
                need(8, "curve point x");
                const x = dv.getFloat64(offset, true); offset += 8;
                need(8, "curve point y");
                const y = dv.getFloat64(offset, true); offset += 8;
                pts.push({ x, y });
            }
            return pts;
        };
        const curves: Curves = {
            rgb: readCurve(),
            red: readCurve(),
            green: readCurve(),
            blue: readCurve(),
        };

        const wbKelvinPresent = readUInt();
        const wbKelvin = readUInt();
        const wbNeutralPresent = readUInt();
        const wbNeutralR = readFloat();
        const wbNeutralG = readFloat();
        const wbNeutralB = readFloat();
        const as_shot_wb: AsShotWb = {
            kelvin: wbKelvinPresent ? wbKelvin : null,
            neutral_rgb: wbNeutralPresent ? [wbNeutralR, wbNeutralG, wbNeutralB] : null,
        };

        const geometry: Adjustments["geometry"] = {
            straighten: readFloat(),
            zoom: readFloat(),
            crop_x: readFloat(),
            crop_y: readFloat(),
            distortion: readFloat(),
            perspective_v: readFloat(),
            perspective_h: readFloat(),
        };

        const readTone = (): ToneBalance => ({
            hue: readFloat(),
            saturation: readFloat(),
            luminance: readFloat(),
        });
        const color_balance: ColorBalance = {
            shadows: readTone(),
            midtones: readTone(),
            highlights: readTone(),
        };

        const readChannel = (): SelectiveChannel => ({
            hue: readFloat(),
            saturation: readFloat(),
            luminance: readFloat(),
        });
        const selective_color: SelectiveColor = {
            red: readChannel(),
            orange: readChannel(),
            yellow: readChannel(),
            green: readChannel(),
            aqua: readChannel(),
            blue: readChannel(),
            purple: readChannel(),
            magenta: readChannel(),
        };

        results.push({
            id,
            filename,
            adj: {
                light,
                color,
                hsl,
                curves,
                detail,
                as_shot_wb,
                rotation,
                geometry,
                color_balance,
                selective_color,
                lut_id,
                lut_intensity,
            },
        });
    }
    return results;
}

/**
 * Parse the binary buffer returned by `render_thumbnails_batch`.
 *
 * Layout:
 *   [count: u32 LE]
 *   for each thumbnail:
 *     [width:  u32 LE]
 *     [height: u32 LE]
 *     [rgba:   width * height * 4 bytes]
 */
export function unpackThumbnails(buf: ArrayBuffer): PixelData[] {
    const HEADER_BYTES = 4;
    if (buf.byteLength < HEADER_BYTES) {
        throw new Error(`unpackThumbnails: buffer too small (${buf.byteLength} bytes)`);
    }
    const dv = new DataView(buf);
    let offset = 0;
    const count = dv.getUint32(offset, true); offset += 4;

    const results: PixelData[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.byteLength < offset + 8) {
            throw new Error(`unpackThumbnails: truncated header for thumbnail ${i}`);
        }
        const width = dv.getUint32(offset, true); offset += 4;
        const height = dv.getUint32(offset, true); offset += 4;
        const pixelBytes = width * height * 4;
        if (buf.byteLength < offset + pixelBytes) {
            throw new Error(`unpackThumbnails: truncated pixels for thumbnail ${i} (${width}x${height})`);
        }
        const data = new Uint8ClampedArray(buf, offset, pixelBytes);
        offset += pixelBytes;
        results.push({ kind: "raw", width, height, data });
    }
    return results;
}

