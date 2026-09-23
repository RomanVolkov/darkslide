import { AppState } from "../state/appState";
import { StoreApi } from "zustand";
import { ImageProcessor } from "./ImageProcessor";
import type { LoadedImage } from "../backend/types";
import { debug } from "../utils/debug";
import { Panel } from "../components/constants";
import { setActivePanel } from "./PanelManager";
import { thumbnailRegistry } from "./thumbnailRegistry";
import { filmstripHistory } from "./filmstripHistory";

/**
 * Load images into the store.
 *
 * @returns the number of images actually loaded (0 when cancelled or failed).
 *
 * `createSession` is an explicit caller decision, NOT inferred from `replace`:
 * a session attach also replaces the view but must not spawn a duplicate
 * session. Append-into-empty passes `true` (it is a de-facto open), non-empty
 * append and session attach pass `false`.
 */
export async function loadImages(
    paths: string[] | null,
    store: StoreApi<AppState>,
    processor: ImageProcessor,
    replace: boolean,
    createSession: boolean,
): Promise<number> {
    let targetPaths = paths;
    if (targetPaths === null) {
        try {
            targetPaths = (await processor.backend.pickImages?.()) ?? null;
        } catch (err) {
            debug.error("pickImages failed", err);
            targetPaths = null;
        }
        if (targetPaths === null) {
            debug.log("loadImages: no files selected");
            return 0;
        }
    }

    // A replace-load supersedes whatever is in memory: drop the previous
    // images' backend caches first so base_images / base_images_cache /
    // exif_cache / thumbnails do not leak across opens. Session membership is
    // deliberately left intact — switching away must not mutate the session
    // being left. Awaited so this unload cannot race the incoming
    // load_images_batch (which may re-insert the same ids) and evict freshly
    // loaded images. The previous session's frontend thumbnails and rendered
    // preview are erased outright, so no stale pixel state survives a switch.
    if (replace) {
        await filmstripHistory.clear(true);
        const staleIds = store.getState().images.map((img) => img.id);
        if (staleIds.length > 0) {
            try {
                await processor.backend.unload(staleIds);
            } catch (err) {
                debug.error("unload on replace failed", err);
            }
        }
        thumbnailRegistry.clear();
        store.getState().setRenderedPreview(null, null, null);
    }

    store.getState().setLoadProgress({ done: 0, total: targetPaths.length });

    let result: LoadedImage[] | null;
    try {
        result = await processor.loadImages(targetPaths, (done, total) => {
            store.getState().setLoadProgress({ done, total });
        });
    } catch (err) {
        debug.error("loadImages failed", err);
        store.getState().setLoadProgress(null);
        return 0;
    }

    if (!result || result.length === 0) {
        store.getState().setLoadProgress(null);
        return 0;
    }

    store.getState().setLoadProgress(null);
    store.getState().loadImages(result, replace);
    setActivePanel(Panel.Adjustments);

    if (createSession) {
        try {
            const result = await processor.backend.createSession?.(targetPaths);
            if (result) {
                store.getState().setSession(result.id);
                if (result.is_existing) {
                    store.getState().showToast(`Attached to session "${result.name}"`);
                }
            } else {
                store.getState().setSession(null);
            }
        } catch (err) {
            debug.error("create_session failed", err);
        }
    }

    return result.length;
}
