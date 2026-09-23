import { PngCompression } from "../components/types";
import type { PixelData, Histogram, Adjustments, LoadedImage } from "./types";
import type { SessionSummary, CreateSessionResult } from "../types";
import { ImageFormat } from "../components/types";

export interface RenderPreviewResult {
    data: PixelData,
    histogram: Histogram,
}

export interface AutoWbResult {
    temperature: number;
    tint: number;
}

export interface ProcessingBackend {
    /** Loads images from the given paths; opens a file dialog when paths is null. */
    import: (paths: string[] | null, onProgress: (done: number, total: number) => void) => Promise<LoadedImage[] | null>;
    /** Pick a folder and export each image with the given format/quality settings. */
    export: (
        images: { id: string, filename: string, adj: Adjustments }[],
        type: ImageFormat,
        quality: number | null,
        pngCompression: PngCompression | null,
        onProgress: (done: number, total: number) => void,
    ) => Promise<void>;
    /** Render a preview of the image with current adjustments. */
    renderPreview: (id: string, adj: Adjustments) => Promise<RenderPreviewResult>;
    /** Render a thumbnail of the image with current adjustments. */
    renderThumbnail: (id: string, adj: Adjustments) => Promise<PixelData>;
    /** Render multiple thumbnails in a single IPC call. */
    renderThumbnails: (items: { id: string; adj: Adjustments; quality?: "fast" | "hq"; maxDim?: number }[]) => Promise<PixelData[]>;
    /** Estimate auto white-balance offsets from the ungraded base image. */
    autoWhiteBalance: (id: string, adj: Adjustments) => Promise<AutoWbResult>;
    /** Drop images from the backend's in-memory cache. */
    unload: (ids: string[], sessionId?: number | null) => Promise<void>;
    clearAllAdjustments: () => Promise<void>;
    /** Open the native image picker and return absolute paths (null if cancelled). */
    pickImages?: () => Promise<string[] | null>;
    /** Create a session for the given paths; null in scenario mode. Reuses matching existing session. */
    createSession?: (paths: string[]) => Promise<CreateSessionResult | null>;
    /** List sessions, most recently updated first. */
    listSessions?: () => Promise<SessionSummary[]>;
    /** Session paths in load order (bumps recency). */
    getSessionPaths?: (id: number) => Promise<string[]>;
    /** Rename a session. */
    renameSession?: (id: number, name: string) => Promise<void>;
    /** Delete a session. */
    deleteSession?: (id: number) => Promise<void>;
}

let _backend: ProcessingBackend | null = null;

export async function getBackend(): Promise<ProcessingBackend> {
    if (_backend) return _backend;
    const { backend } = await import("./tauri");
    _backend = backend;
    return _backend;
}
