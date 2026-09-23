import { ProcessingBackend, } from "../backend";
import { Adjustments, PixelData, Histogram, LoadedImage } from "../backend/types";
import { ImageID } from "../types";
import { StoreApi } from "zustand";
import { AppState } from "../state/appState";
import { ImageEntry } from "../types";
import { ImageFormat, PngCompression } from "../components/types";
import { debug } from "../utils/debug";

export class ImageProcessor {
    backend: ProcessingBackend
    private renderingInProgress = false
    private pendingRenderingRequest: {
        id: ImageID,
        adjustments: Adjustments,
        renderCount: number,
        onRender: (id: ImageID, data: PixelData, histogram: Histogram, renderCount: number) => void
    } | null = null

    constructor(backend: ProcessingBackend) {
        this.backend = backend;
    }

    async loadImages(
        paths: string[] | null,
        onProgress: (done: number, total: number) => void,
    ): Promise<LoadedImage[] | null> {
        return await this.backend.import?.(paths, onProgress) ?? null;
    }

    /**
     * Render a preview for the active image.
     *
     * Only one render runs at a time; newer calls replace any pending request.
     * The `renderCount` is an opaque token from the caller (ImageRenderer) that
     * is echoed back in `onRender` so the caller can ignore responses for stale
     * renders that were superseded while in flight.
     */
    async render(
        id: ImageID,
        adjustments: Adjustments,
        renderCount: number,
        onRender: (id: ImageID, data: PixelData, histogram: Histogram, renderCount: number) => void
    ): Promise<void> {
        if (this.renderingInProgress) {
            this.pendingRenderingRequest = { id, adjustments, renderCount, onRender };
            return;
        }
        this.renderingInProgress = true;

        try {
            const result = await this.backend.renderPreview(id, adjustments);
            onRender(id, result.data, result.histogram, renderCount);
        } catch {
            // Stale renders may be cancelled on the backend when the user
            // switches images; just move on to the pending request.
        }
        finally {
            this.renderingInProgress = false;
        }

        if (this.pendingRenderingRequest) {
            const next = this.pendingRenderingRequest;
            this.pendingRenderingRequest = null;
            await this.render(next.id, next.adjustments, next.renderCount, next.onRender);
        }
    }

    async exportImages(
        store: StoreApi<AppState>,
        imgs: ImageEntry[],
        exportType: ImageFormat,
        quality: number | null,
        pngCompression: PngCompression | null,
        showToast: (msg: string) => void
    ) {
        try {
            store.getState().setExportProgress({ done: 0, total: imgs.length });

            const exportItems = imgs.map(img => ({
                id: img.id,
                filename: img.filename,
                adj: img.adjustments,
            }));

            await this.backend.export(
                exportItems,
                exportType,
                quality,
                pngCompression,
                (done, total) => {
                    store.getState().setExportProgress(
                        done >= total ? null : { done, total }
                    );
                }
            );
        } catch (err) {
            debug.error("export failed", err);
            showToast("export failed");
        } finally {
            store.getState().setExportProgress(null);
        }
    }

}
