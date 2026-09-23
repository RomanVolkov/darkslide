import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { useAppState } from "../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import type { Adjustments, LoadedImage } from "../backend/types.ts";
import {
    beginApply,
    COALESCE_MS,
    endApply,
    HISTORY_CAP,
    historyDepth,
    initHistory,
    redo,
    resetHistoryForTests,
    sealBurst,
    undo,
} from "./undoHistory.ts";

function loaded(id: string): LoadedImage {
    return { id, filename: `${id}.jpg`, adjustments: structuredClone(DEFAULT_ADJUSTMENTS) };
}

function withExposure(adj: Adjustments, exposure: number): Adjustments {
    return { ...adj, light: { ...adj.light, exposure } };
}

/** Apply an edit through the real store action, exactly like the UI does. */
function edit(id: string, exposure: number): void {
    useAppState.getState().updateImage(id, (img) => {
        img.adjustments = withExposure(img.adjustments, exposure);
    });
}

function currentExposure(id: string): number {
    const img = useAppState.getState().images.find((i) => i.id === id)!;
    return img.adjustments.light.exposure;
}

let unsubscribe: () => void;
const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
    mockInvoke.mockClear();
    resetHistoryForTests();
    useAppState.setState({ images: [], activeIndex: 0, selectedIds: new Set() });
    unsubscribe = initHistory(useAppState);
});

afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
});

describe("undoHistory: baseline", () => {
    it("freshly loaded images have empty history — loaded adjustments are the baseline", () => {
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        expect(historyDepth("a")).toEqual({ undo: 0, redo: 0 });
        expect(undo("a")).toBeNull();
        expect(redo("a")).toBeNull();
    });

    it("undo/redo round-trip restores snapshots", () => {
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1.5);
        expect(currentExposure("a")).toBe(1.5);
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });

        const snapshot = undo("a")!;
        expect(snapshot.light.exposure).toBe(0);
        // Apply through the mute flag, exactly like the store action does.
        beginApply();
        useAppState.getState().updateImage("a", (img) => { img.adjustments = snapshot; });
        endApply();
        expect(currentExposure("a")).toBe(0);
        expect(historyDepth("a")).toEqual({ undo: 0, redo: 1 });

        const forward = redo("a")!;
        expect(forward.light.exposure).toBe(1.5);
    });
});

describe("undoHistory: sliding window coalescing", () => {
    it("two edits 0.5s apart coalesce into one entry holding the pre-burst snapshot", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1);
        vi.advanceTimersByTime(500);
        edit("a", 2);
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });
        expect(undo("a")!.light.exposure).toBe(0);
    });

    it("a long continuous burst (10s of edits < 1s apart) is one undo step", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        for (let i = 1; i <= 20; i++) {
            edit("a", i);
            vi.advanceTimersByTime(500);
        }
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });
    });

    it("two edits 1.5s apart produce two entries", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1);
        vi.advanceTimersByTime(COALESCE_MS + 500);
        edit("a", 2);
        expect(historyDepth("a")).toEqual({ undo: 2, redo: 0 });
        expect(undo("a")!.light.exposure).toBe(1);
    });

    it("sealBurst forces a new entry inside the window", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1);
        sealBurst("a");
        edit("a", 2);
        expect(historyDepth("a")).toEqual({ undo: 2, redo: 0 });
        expect(undo("a")!.light.exposure).toBe(1);
    });
});

describe("undoHistory: cap and redo semantics", () => {
    it(`evicts the oldest entry beyond the cap of ${HISTORY_CAP}`, () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        for (let i = 1; i <= HISTORY_CAP + 1; i++) {
            edit("a", i);
            sealBurst("a");
        }
        const depth = historyDepth("a")!;
        expect(depth.undo).toBe(HISTORY_CAP);
        // Oldest surviving snapshot is the state before edit #2 (exposure 1).
        let first: Adjustments | null = null;
        for (let i = 0; i < HISTORY_CAP; i++) first = undo("a");
        expect(first!.light.exposure).toBe(1);
    });

    it("a new edit clears the image's own redo stack but not other images'", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        edit("a", 1);
        edit("b", 10);
        sealBurst("a");
        sealBurst("b");
        undo("a");
        undo("b");
        expect(historyDepth("a")!.redo).toBe(1);
        expect(historyDepth("b")!.redo).toBe(1);

        edit("b", 20);
        expect(historyDepth("b")!.redo).toBe(0);
        expect(historyDepth("a")!.redo).toBe(1);
    });
});

describe("undoHistory: multi-image operations", () => {
    it("paste to 3 images records one independent entry per image", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a"), loaded("b"), loaded("c")], true);
        useAppState.setState({ activeIndex: 0 });
        edit("a", 3);
        sealBurst("a"); // end the edit's burst so the paste is its own entry
        useAppState.getState().yankAdjustments();
        useAppState.getState().pasteAdjustments(new Set(["a", "b", "c"]));

        expect(historyDepth("a")!.undo).toBe(2); // its own edit + paste
        expect(historyDepth("b")!.undo).toBe(1); // paste only
        expect(historyDepth("c")!.undo).toBe(1);

        // Undoing b reverts only b.
        const snap = undo("b")!;
        useAppState.getState().updateImage("b", (img) => { img.adjustments = snap; });
        expect(currentExposure("b")).toBe(0);
        expect(currentExposure("c")).toBe(3);
    });
});

describe("undoHistory: lifecycle", () => {
    it("loadImages(replace: true) — session switch — wipes all history", () => {
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        edit("a", 1);
        edit("b", 2);
        expect(historyDepth("a")!.undo).toBe(1);

        useAppState.getState().loadImages([loaded("c")], true);
        expect(historyDepth("a")).toBeNull();
        expect(historyDepth("b")).toBeNull();
        expect(historyDepth("c")).toEqual({ undo: 0, redo: 0 });
    });

    it("loadImages append keeps existing histories", () => {
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1);
        useAppState.getState().loadImages([loaded("b")], false);
        expect(historyDepth("a")!.undo).toBe(1);
        expect(historyDepth("b")).toEqual({ undo: 0, redo: 0 });
    });

    it("deleteImages prunes the removed image's history", () => {
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        edit("a", 1);
        edit("b", 2);
        useAppState.getState().deleteImages(new Set(["a"]));
        expect(historyDepth("a")).toBeNull();
        expect(historyDepth("b")!.undo).toBe(1);
    });
});

describe("undoHistory: mute flag", () => {
    it("a muted apply records nothing and updates the shadow value", () => {
        vi.useFakeTimers();
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 1);
        sealBurst("a");

        const snapshot = undo("a")!;
        beginApply();
        useAppState.getState().updateImage("a", (img) => { img.adjustments = snapshot; });
        endApply();

        expect(historyDepth("a")).toEqual({ undo: 0, redo: 1 });
        // A subsequent edit uses the applied value as its baseline.
        edit("a", 5);
        expect(undo("a")!.light.exposure).toBe(0);
    });
});

describe("undoAdjustment / redoAdjustment store actions", () => {
    it("undoAdjustment applies the snapshot to the active image and persists it", () => {
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        useAppState.setState({ activeIndex: 1 });
        edit("b", 2);

        useAppState.getState().undoAdjustment();

        expect(currentExposure("b")).toBe(0);
        expect(mockInvoke).toHaveBeenCalledWith("update_adjustments", expect.objectContaining({ id: "b" }));
        // The apply was muted: no new entry, and the snapshot landed on redo.
        expect(historyDepth("b")).toEqual({ undo: 0, redo: 1 });
    });

    it("redoAdjustment re-applies the undone state and persists it", () => {
        useAppState.getState().loadImages([loaded("a")], true);
        edit("a", 2);
        useAppState.getState().undoAdjustment();
        mockInvoke.mockClear();

        useAppState.getState().redoAdjustment();

        expect(currentExposure("a")).toBe(2);
        expect(mockInvoke).toHaveBeenCalledWith("update_adjustments", expect.objectContaining({ id: "a" }));
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });
    });

    it("is a silent no-op on empty history and with no images", () => {
        useAppState.getState().loadImages([loaded("a")], true);
        useAppState.getState().undoAdjustment();
        useAppState.getState().redoAdjustment();
        expect(currentExposure("a")).toBe(0);
        expect(mockInvoke).not.toHaveBeenCalled();

        useAppState.setState({ images: [] });
        useAppState.getState().undoAdjustment();
        useAppState.getState().redoAdjustment();
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("undoing one image leaves other images untouched", () => {
        useAppState.getState().loadImages([loaded("a"), loaded("b")], true);
        edit("a", 1);
        edit("b", 2);
        useAppState.setState({ activeIndex: 0 });

        useAppState.getState().undoAdjustment();

        expect(currentExposure("a")).toBe(0);
        expect(currentExposure("b")).toBe(2);
    });
});

describe("undoHistory: lifecycle and cleanup", () => {
    it("edits after cleanup record nothing, and remounting does not double-record", () => {
        unsubscribe();
        resetHistoryForTests();

        useAppState.getState().loadImages([loaded("a")], true);

        const unmount1 = initHistory(useAppState);
        sealBurst("a");
        edit("a", 10);
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });

        unmount1();

        sealBurst("a");
        edit("a", 20);
        expect(historyDepth("a")).toEqual({ undo: 1, redo: 0 });

        const unmount2 = initHistory(useAppState);
        sealBurst("a");
        edit("a", 30);
        expect(historyDepth("a")).toEqual({ undo: 2, redo: 0 });

        unsubscribe = unmount2;
    });
});

