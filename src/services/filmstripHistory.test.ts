import { describe, it, expect, vi, beforeEach } from "vitest";
import { filmstripHistory, FILMSTRIP_HISTORY_CAP } from "./filmstripHistory";
import { thumbnailRegistry } from "./thumbnailRegistry";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import type { ImageEntry } from "../types";

describe("filmstripHistory", () => {
    const mockBackend = {
        unload: vi.fn(async () => {}),
    } as any;

    const createDummyEntry = (id: string, name: string): ImageEntry => ({
        id,
        filename: name,
        adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
    });

    beforeEach(() => {
        vi.clearAllMocks();
        filmstripHistory.resetForTests();
        thumbnailRegistry.clear();
    });

    it("tracks push, undo, and redo transitions correctly", async () => {
        expect(filmstripHistory.canUndo()).toBe(false);
        expect(filmstripHistory.canRedo()).toBe(false);

        const img1 = createDummyEntry("img-1", "test1.jpg");
        await filmstripHistory.pushRemoval([{ entry: img1, index: 0 }], 10, mockBackend);

        expect(filmstripHistory.canUndo()).toBe(true);
        expect(filmstripHistory.canRedo()).toBe(false);
        expect(filmstripHistory.undoCount).toBe(1);

        const undone = filmstripHistory.popUndo();
        expect(undone).toBeDefined();
        expect(undone?.items[0]?.entry.id).toBe("img-1");
        expect(undone?.sessionId).toBe(10);
        expect(filmstripHistory.canUndo()).toBe(false);
        expect(filmstripHistory.canRedo()).toBe(true);

        const redone = filmstripHistory.popRedo();
        expect(redone).toBeDefined();
        expect(redone?.items[0]?.entry.id).toBe("img-1");
        expect(filmstripHistory.canUndo()).toBe(true);
        expect(filmstripHistory.canRedo()).toBe(false);
    });

    it("unloads discarded redo items when a new removal occurs", async () => {
        const img1 = createDummyEntry("img-1", "test1.jpg");
        const img2 = createDummyEntry("img-2", "test2.jpg");

        await filmstripHistory.pushRemoval([{ entry: img1, index: 0 }], 10, mockBackend);
        filmstripHistory.popUndo(); // img1 is now in redoStack

        expect(mockBackend.unload).not.toHaveBeenCalled();

        // Pushing img2 invalidates img1 in redoStack -> permanently unloads img1
        await filmstripHistory.pushRemoval([{ entry: img2, index: 1 }], 10, mockBackend);

        expect(mockBackend.unload).toHaveBeenCalledWith(["img-1"], 10);
        expect(filmstripHistory.canRedo()).toBe(false);
        expect(filmstripHistory.undoCount).toBe(1);
    });

    it("caps history at FILMSTRIP_HISTORY_CAP and unloads evicted items", async () => {
        for (let i = 0; i < FILMSTRIP_HISTORY_CAP; i++) {
            const img = createDummyEntry(`img-${i}`, `test-${i}.jpg`);
            await filmstripHistory.pushRemoval([{ entry: img, index: i }], 10, mockBackend);
        }

        expect(filmstripHistory.undoCount).toBe(FILMSTRIP_HISTORY_CAP);
        expect(mockBackend.unload).not.toHaveBeenCalled();

        // 21st push evicts img-0
        const img20 = createDummyEntry("img-20", "test-20.jpg");
        await filmstripHistory.pushRemoval([{ entry: img20, index: 20 }], 10, mockBackend);

        expect(filmstripHistory.undoCount).toBe(FILMSTRIP_HISTORY_CAP);
        expect(mockBackend.unload).toHaveBeenCalledWith(["img-0"], 10);
    });

    it("clear(true) unloads all pending items across undo and redo stacks", async () => {
        const img1 = createDummyEntry("img-1", "test1.jpg");
        const img2 = createDummyEntry("img-2", "test2.jpg");

        await filmstripHistory.pushRemoval([{ entry: img1, index: 0 }], 10, mockBackend);
        await filmstripHistory.pushRemoval([{ entry: img2, index: 1 }], 10, mockBackend);
        filmstripHistory.popUndo(); // img2 in redo, img1 in undo

        await filmstripHistory.clear(true);

        expect(filmstripHistory.canUndo()).toBe(false);
        expect(filmstripHistory.canRedo()).toBe(false);
        expect(mockBackend.unload).toHaveBeenCalledWith(["img-1"], 10);
        expect(mockBackend.unload).toHaveBeenCalledWith(["img-2"], 10);
    });
});
