import { invoke } from "@tauri-apps/api/core";
import { ImageProcessor } from "./ImageProcessor";
import { useAppState } from "../state/appState";
import { loadImages } from "./FileHandlers";
import type { SessionSummary } from "../types";
import { debug } from "../utils/debug";

/**
 * Refresh the session list and open the palette modal. On failure the stale
 * list is kept and the palette still opens.
 */
export async function openPalette(): Promise<void> {
    const store = useAppState;
    try {
        const sessions = await invoke<SessionSummary[]>("list_sessions");
        store.getState().setSessions(sessions);
    } catch (err) {
        debug.error("list_sessions failed", err);
    }
    store.getState().setShowSessions(true);
}

/**
 * Attach a session: fetch its paths, replace the current view with them, and
 * mark the session active. Missing files are skipped with a toast; the DB is
 * never pruned.
 */
export async function openSession(id: number, processor: ImageProcessor): Promise<void> {
    const store = useAppState;
    try {
        const paths = await invoke<string[]>("get_session_paths", { id });
        const loaded = await loadImages(paths, store, processor, true, false);
        // Only mark the session active when something actually loaded — if every
        // file is missing the view still shows the previous images, so claiming
        // the session would let a later `d` mutate the wrong membership.
        if (loaded > 0) {
            store.getState().setSession(id);
        }
        if (paths.length > 0 && loaded < paths.length) {
            store.getState().showToast(`${paths.length - loaded} of ${paths.length} files unavailable`);
        }
    } catch (err) {
        debug.error("openSession failed", err);
        store.getState().showToast("Failed to open session");
    }
}

export async function renameSession(id: number, name: string): Promise<void> {
    await invoke("rename_session", { id, name });
    const store = useAppState;
    store.getState().setSessions(
        store.getState().sessions.map((s) => (s.id === id ? { ...s, name } : s)),
    );
}

export async function deleteSession(id: number): Promise<void> {
    await invoke("delete_session", { id });
    const store = useAppState;
    if (store.getState().sessionId === id) {
        store.getState().setSession(null);
    }
    store.getState().setSessions(store.getState().sessions.filter((s) => s.id !== id));
}

/** Open a session, select every loaded image, and launch the export modal. */
export async function exportSession(id: number, processor: ImageProcessor): Promise<void> {
    const store = useAppState;
    store.getState().setShowSessions(false);
    await openSession(id, processor);
    if (store.getState().images.length > 0) {
        store.getState().selectAll();
        store.getState().setShowExport(true);
    }
}
