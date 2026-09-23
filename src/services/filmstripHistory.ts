import type { ImageEntry } from "../types";
import type { ThumbnailEntry } from "./thumbnailRegistry";
import { thumbnailRegistry } from "./thumbnailRegistry";
import { getBackend, ProcessingBackend } from "../backend";
import { debug } from "../utils/debug";

export const FILMSTRIP_HISTORY_CAP = 20;

export interface RemovedImageItem {
    entry: ImageEntry;
    index: number;
    thumbnail?: ThumbnailEntry | undefined;
}

export interface FilmstripRemovalEntry {
    items: RemovedImageItem[];
    sessionId: number | null;
    backend?: ProcessingBackend | undefined;
}

class FilmstripHistory {
    private undoStack: FilmstripRemovalEntry[] = [];
    private redoStack: FilmstripRemovalEntry[] = [];

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    get undoCount(): number {
        return this.undoStack.length;
    }

    get redoCount(): number {
        return this.redoStack.length;
    }

    /**
     * Push a new removal to the undo stack.
     * Clears the redo stack and evicts any discarded redo entries to the backend.
     */
    async pushRemoval(
        items: RemovedImageItem[],
        sessionId: number | null,
        backend?: ProcessingBackend,
    ): Promise<void> {
        if (items.length === 0) return;

        const discarded = this.redoStack;
        this.redoStack = [];

        this.undoStack.push({ items, sessionId, backend });

        let evicted: FilmstripRemovalEntry | undefined;
        if (this.undoStack.length > FILMSTRIP_HISTORY_CAP) {
            evicted = this.undoStack.shift();
        }

        // Asynchronous unloads for discarded or evicted items happen in parallel
        const unloads: Promise<void>[] = [];
        for (const entry of discarded) {
            unloads.push(this.permanentlyUnload(entry));
        }
        if (evicted) {
            unloads.push(this.permanentlyUnload(evicted));
        }
        if (unloads.length > 0) {
            await Promise.all(unloads);
        }
    }

    /**
     * Pop the last removal for undo. Moves the entry onto the redo stack.
     */
    popUndo(): FilmstripRemovalEntry | null {
        const entry = this.undoStack.pop();
        if (!entry) return null;
        this.redoStack.push(entry);
        return entry;
    }

    /**
     * Pop the next redo entry. Moves the entry back onto the undo stack.
     */
    popRedo(): FilmstripRemovalEntry | null {
        const entry = this.redoStack.pop();
        if (!entry) return null;
        this.undoStack.push(entry);
        return entry;
    }

    /**
     * Clear all undo and redo history. Permanently unloads any pending removed images.
     */
    async clear(unloadBackend = true): Promise<void> {
        const allEntries = [...this.undoStack, ...this.redoStack];
        this.undoStack = [];
        this.redoStack = [];
        if (unloadBackend) {
            for (const entry of allEntries) {
                await this.permanentlyUnload(entry);
            }
        }
    }

    resetForTests(): void {
        this.undoStack = [];
        this.redoStack = [];
    }

    private async permanentlyUnload(entry: FilmstripRemovalEntry): Promise<void> {
        const ids = entry.items.map((item) => item.entry.id);
        if (ids.length === 0) return;
        for (const id of ids) {
            thumbnailRegistry.delete(id);
        }
        try {
            const backend = entry.backend ?? (await getBackend());
            await backend.unload(ids, entry.sessionId);
        } catch (err) {
            debug.error("filmstripHistory permanentlyUnload failed", err);
        }
    }
}

export const filmstripHistory = new FilmstripHistory();
