import type { Adjustments } from "../backend/types";
import type { ImageID } from "../types";
import type { useAppState } from "../state/appState";

/**
 * Per-image, in-memory undo/redo history for adjustments.
 *
 * A single passive store subscription detects every adjustment change:
 * immer never mutates an `Adjustments` object in place, so a changed
 * reference IS a change, and the previously seen reference IS a valid
 * immutable snapshot (stored as-is, never cloned).
 *
 * Coalescing: a change pushes a new undo entry only after COALESCE_MS of
 * silence for that image (sliding window) or after `sealBurst`. During a
 * burst only the shadow map advances, so the stack top keeps the pre-burst
 * snapshot — one slider drag / held key = one undo step.
 *
 * History is wiped when an image leaves the store (deleteImages, or
 * loadImages(replace: true) on session switch). Nothing is persisted.
 */

export const COALESCE_MS = 1000;
export const HISTORY_CAP = 30;

interface ImageHistory {
    undo: Adjustments[];
    redo: Adjustments[];
    /** Timestamp of the last recorded change; drives the sliding window. */
    lastChange: number;
    /** Set by sealBurst: the next change always starts a new undo entry. */
    sealNext: boolean;
}

const histories = new Map<ImageID, ImageHistory>();
const shadow = new Map<ImageID, Adjustments>();
let applyingHistory = false;

export function initHistory(store: typeof useAppState): () => void {
    // Initial pass: register baseline for any images currently in the store
    for (const img of store.getState().images) {
        shadow.set(img.id, img.adjustments);
        if (!histories.has(img.id)) {
            histories.set(img.id, { undo: [], redo: [], lastChange: 0, sealNext: false });
        }
    }

    return store.subscribe((state) => {
        const seen = new Set<ImageID>();
        for (const img of state.images) {
            seen.add(img.id);
            const prev = shadow.get(img.id);
            if (prev === undefined) {
                // New image: its loaded adjustments are the baseline, not an undoable edit.
                shadow.set(img.id, img.adjustments);
                histories.set(img.id, { undo: [], redo: [], lastChange: 0, sealNext: false });
                continue;
            }
            if (prev === img.adjustments) continue;
            if (applyingHistory) {
                // Our own undo/redo apply: track the new value, record nothing.
                shadow.set(img.id, img.adjustments);
                continue;
            }
            const h = histories.get(img.id)!;
            const now = Date.now();
            if (h.sealNext || now - h.lastChange >= COALESCE_MS) {
                h.undo.push(prev);
                if (h.undo.length > HISTORY_CAP) h.undo.shift();
                h.sealNext = false;
            }
            h.lastChange = now;
            h.redo = [];
            shadow.set(img.id, img.adjustments);
        }
        for (const id of [...histories.keys()]) {
            if (!seen.has(id)) {
                histories.delete(id);
                shadow.delete(id);
            }
        }
    });
}

export function undo(id: ImageID): Adjustments | null {
    const h = histories.get(id);
    const current = shadow.get(id);
    if (!h || current === undefined || h.undo.length === 0) return null;
    const snapshot = h.undo.pop()!;
    h.redo.push(current);
    return snapshot;
}

export function redo(id: ImageID): Adjustments | null {
    const h = histories.get(id);
    const current = shadow.get(id);
    if (!h || current === undefined || h.redo.length === 0) return null;
    const snapshot = h.redo.pop()!;
    h.undo.push(current);
    return snapshot;
}

/** Close the coalescing window: the next change for `id` starts a new undo entry. */
export function sealBurst(id: ImageID): void {
    const h = histories.get(id);
    if (h) h.sealNext = true;
}

/**
 * Mute flag wrapping the undo/redo apply in the store actions. Zustand
 * listeners fire synchronously inside set(), so a plain boolean is airtight.
 */
export function beginApply(): void {
    applyingHistory = true;
}

export function endApply(): void {
    applyingHistory = false;
}

/** Introspection for tests and the profiling scenario. */
export function historyDepth(id: ImageID): { undo: number; redo: number } | null {
    const h = histories.get(id);
    return h ? { undo: h.undo.length, redo: h.redo.length } : null;
}

export function resetHistoryForTests(): void {
    histories.clear();
    shadow.clear();
    applyingHistory = false;
}
