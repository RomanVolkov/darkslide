import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
const { listen } = await import("@tauri-apps/api/event");
import { sep } from "@tauri-apps/api/path";
import { unpackBatch, unpackThumbnails } from "./utils.ts"
import type { Adjustments, PixelData } from "./types.ts";
import type { RenderPreviewResult, ProcessingBackend, AutoWbResult } from "./index.ts";
import type { SessionSummary, CreateSessionResult } from "../types";

const extensions = ["jpg", "jpeg", "png", "tiff", "tif", "webp", "bmp", "heic", "heif"];

export const backend: ProcessingBackend = {
    renderPreview: async (id: string, adj: Adjustments): Promise<RenderPreviewResult> => {
        // render_preview returns raw binary: [width u32 LE][height u32 LE][RGBA bytes...]
        const buf = await invoke<ArrayBuffer>("render_preview", { id, adjustments: adj });
        const HEADER_BYTES = 8;
        if (buf.byteLength < HEADER_BYTES) {
            throw new Error(`render_preview: buffer too small (${buf.byteLength} bytes)`);
        }
        const dv = new DataView(buf);
        const width = dv.getUint32(0, true);
        const height = dv.getUint32(4, true);
        const pixelBytes = width * height * 4;
        const pixelsDataOffset = HEADER_BYTES + pixelBytes;
        const histogramBytes = 256 * 4 * 4;
        if (buf.byteLength < pixelsDataOffset + histogramBytes) {
            throw new Error(`render_preview: buffer truncated (got ${buf.byteLength}, need ${pixelsDataOffset + histogramBytes}) for ${width}x${height}`);
        }
        const data = new Uint8ClampedArray(buf, HEADER_BYTES, pixelBytes); // assuming rgba

        const red = new Uint32Array(new Uint32Array(buf, pixelsDataOffset + 256 * 4 * 0, 256));
        const green = new Uint32Array(new Uint32Array(buf, pixelsDataOffset + 256 * 4 * 1, 256));
        const blue = new Uint32Array(new Uint32Array(buf, pixelsDataOffset + 256 * 4 * 2, 256));
        const luma = new Uint32Array(new Uint32Array(buf, pixelsDataOffset + 256 * 4 * 3, 256));
        return {
            data: { kind: "raw", width, height, data },
            histogram: { red, green, blue, luma }
        }
    },

    renderThumbnail: async (id: string, adj: Adjustments): Promise<PixelData> => {
        // render_thumbnail returns raw binary: [width u32 LE][height u32 LE][RGBA bytes...]
        const buf = await invoke<ArrayBuffer>("render_thumbnail", { id, adjustments: adj });
        const HEADER_BYTES = 8;
        if (buf.byteLength < HEADER_BYTES) {
            throw new Error(`render_thumbnail: buffer too small (${buf.byteLength} bytes)`);
        }
        const dv = new DataView(buf);
        const width = dv.getUint32(0, true);
        const height = dv.getUint32(4, true);
        const pixelBytes = width * height * 4;
        if (buf.byteLength < HEADER_BYTES + pixelBytes) {
            throw new Error(`render_thumbnail: buffer truncated (got ${buf.byteLength}, need ${HEADER_BYTES + pixelBytes}) for ${width}x${height}`);
        }
        const data = new Uint8ClampedArray(buf, HEADER_BYTES, pixelBytes);
        return { kind: "raw", width, height, data };
    },

    renderThumbnails: async (items): Promise<PixelData[]> => {
        if (items.length === 0) return [];
        const files = items.map((item) => ({
            id: item.id,
            adjustments: item.adj,
            quality: item.quality,
            maxDim: item.maxDim,
        }));
        const buf = await invoke<ArrayBuffer>("render_thumbnails_batch", { files });
        return unpackThumbnails(buf);
    },

    autoWhiteBalance: async (id: string, adjustments: Adjustments): Promise<AutoWbResult> => {
        return invoke<AutoWbResult>("auto_white_balance", { id, adjustments });
    },

    export: async (images, imageType, quality, pngCompression, onProgress) => {
        const folder = await open({ directory: true, multiple: false, title: "Export to Folder" });
        if (!folder || typeof folder !== "string") return;

        let done = 0;
        const total = images.length;
        const separator = sep();

        const exportPromises = images.map(async (img) => {
            const stem = img.filename.replace(/\.[^.]+$/, "");
            const path = `${folder}${separator}${stem}.${imageType}`;
            await invoke("export", {
                id: img.id,
                adjustments: img.adj,
                path,
                imageType: imageType as string,
                quality,
                pngCompression,
            });
            done++;
            onProgress(done, total);
        });
        await Promise.all(exportPromises);
    },

    unload: (ids: string[], sessionId?: number | null) => invoke("unload_images", { ids, sessionId: sessionId ?? null }),

    clearAllAdjustments: () => invoke("clear_all_adjustments"),

    pickImages: async () => {
        const selected = await open({
            filters: [{ name: "Image", extensions }],
            multiple: true,
        });
        if (!selected) return null;
        return Array.isArray(selected) ? selected : [selected];
    },

    createSession: (paths) => invoke<CreateSessionResult | null>("create_session", { paths }),

    listSessions: () => invoke<SessionSummary[]>("list_sessions"),

    getSessionPaths: (id) => invoke<string[]>("get_session_paths", { id }),

    renameSession: (id, name) => invoke("rename_session", { id, name }),

    deleteSession: (id) => invoke("delete_session", { id }),

    import: async (paths, onProgress) => {
        if (paths === null) {
            paths = await open({
                filters: [{ name: "Image", extensions: extensions }],
                multiple: true,
            }) as string[] | null;
        }

        if (!paths || !(paths as string[]).length) return null;
        const pathList = paths as string[];

        const files: Array<string> = pathList;

        onProgress(0, files.length);

        const unsubscribe = await listen<{ done: number; total: number }>(
            "load-progress",
            (event) => onProgress(event.payload.done, event.payload.total),
        );

        try {
            const buf = await invoke<ArrayBuffer>("load_images_batch", { files });
            const results = unpackBatch(buf);
            return results.map((r) => ({
                id: r.id,
                filename: r.filename,
                adjustments: r.adj,
            }));
        } finally {
            unsubscribe();
        }
    },
};
