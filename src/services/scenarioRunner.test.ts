import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async () => undefined),
}));

import { WebTraceRecorder } from "./webTraceRecorder.ts";
import { measureHqPair, timeThumbnailTier, runUndoRedoHistoryStep, type ThumbnailRenderer } from "./scenarioRunner.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { useAppState } from "../state/appState.ts";
import { initHistory, resetHistoryForTests, historyDepth } from "./undoHistory.ts";
import * as undoHistoryModule from "./undoHistory.ts";

describe("timeThumbnailTier", () => {
    it("passes the requested quality and maxDim through to the renderer", async () => {
        const batches: { id: string; adj: typeof DEFAULT_ADJUSTMENTS; quality?: "fast" | "hq"; maxDim?: number }[][] = [];
        const render: ThumbnailRenderer = async (items) => {
            batches.push(items);
            return [];
        };

        const ids = ["a", "b", "c", "d", "e"];
        const stat = await timeThumbnailTier(ids, "hq", 200, DEFAULT_ADJUSTMENTS, render);

        expect(stat.count).toBe(5);
        expect(batches).toHaveLength(2);
        expect(batches[0]!.every(i => i.quality === "hq" && i.maxDim === 200)).toBe(true);
        expect(batches[0]!.every(i => i.adj === DEFAULT_ADJUSTMENTS)).toBe(true);
        expect(batches[0]).toHaveLength(4);
        expect(batches[1]).toHaveLength(1);
    });

    it("uses the fast batch size of 12 for fast tiers", async () => {
        const sizes: number[] = [];
        const render: ThumbnailRenderer = async (items) => {
            sizes.push(items.length);
            return [];
        };

        const ids = Array.from({ length: 25 }, (_, i) => `id${i}`);
        await timeThumbnailTier(ids, "fast", 160, DEFAULT_ADJUSTMENTS, render);

        expect(sizes).toEqual([12, 12, 1]);
    });

    it("reports the derived average across the whole set", async () => {
        const render: ThumbnailRenderer = async () => {
            await new Promise(r => setTimeout(r, 6));
            return [];
        };

        const ids = Array.from({ length: 8 }, (_, i) => `id${i}`);
        const stat = await timeThumbnailTier(ids, "hq", 400, DEFAULT_ADJUSTMENTS, render);

        expect(stat.count).toBe(8);
        expect(stat.avgMs).toBeGreaterThan(0);
        expect(stat.maxMs).toBeGreaterThanOrEqual(stat.avgMs);
    });

    it("returns a zeroed result for an empty id list", async () => {
        const render = vi.fn(async () => []);
        expect(await timeThumbnailTier([], "fast", 160, DEFAULT_ADJUSTMENTS, render)).toEqual({
            count: 0,
            avgMs: 0,
            maxMs: 0,
        });
        expect(render).not.toHaveBeenCalled();
    });

    it("propagates backend failures", async () => {
        const render: ThumbnailRenderer = async () => {
            throw new Error("ipc down");
        };

        await expect(timeThumbnailTier(["a"], "hq", 200, DEFAULT_ADJUSTMENTS, render)).rejects.toThrow("ipc down");
    });
});

describe("measureHqPair", () => {
    it("measures both HQ sizes per image with alternating order", async () => {
        const byId = new Map<string, Array<"fast" | "hq" | undefined>>();
        const maxDims: number[] = [];
        const render: ThumbnailRenderer = async (items) => {
            for (const item of items) {
                const list = byId.get(item.id) ?? [];
                list.push(item.quality);
                byId.set(item.id, list);
                maxDims.push(item.maxDim!);
            }
            await new Promise(r => setTimeout(r, 4));
            return [];
        };

        const result = await measureHqPair(["a", "b", "c", "d"], DEFAULT_ADJUSTMENTS, render);

        expect(result.count).toBe(4);
        expect(result.legacyAvgMs).toBeGreaterThan(0);
        expect(result.newAvgMs).toBeGreaterThan(0);
        // Each image is measured twice (400 and 200), alternating order.
        for (const list of byId.values()) {
            expect(list).toEqual(["hq", "hq"]);
        }
        expect(maxDims.filter(d => d === 400)).toHaveLength(4);
        expect(maxDims.filter(d => d === 200)).toHaveLength(4);
    });

    it("returns a zeroed result for an empty id list", async () => {
        const render = vi.fn(async () => []);
        const result = await measureHqPair([], DEFAULT_ADJUSTMENTS, render);
        expect(result).toEqual({ count: 0, legacyAvgMs: 0, newAvgMs: 0, legacyPeakMs: 0, newPeakMs: 0 });
        expect(render).not.toHaveBeenCalled();
    });
});

describe("WebTraceRecorder", () => {
    it("starts, records steps, and finalizes a valid trace report", async () => {
        const recorder = new WebTraceRecorder();
        recorder.start();

        recorder.startStep("step_1");
        await new Promise((resolve) => setTimeout(resolve, 30));
        recorder.endStep("step_1", { key: "value" });

        recorder.recordInstant("milestone", { at: 1 });

        const jsonStr = recorder.finalize();
        const parsed = JSON.parse(jsonStr);

        expect(parsed.traceEvents).toBeDefined();
        expect(Array.isArray(parsed.traceEvents)).toBe(true);
        expect(parsed.traceEvents.length).toBeGreaterThanOrEqual(2);

        const stepEvent = parsed.traceEvents.find((e: { name: string }) => e.name === "step_1");
        expect(stepEvent).toBeDefined();
        expect(stepEvent.ph).toBe("X");
        expect(stepEvent.dur).toBeGreaterThan(0);
        expect(stepEvent.args).toEqual({ key: "value" });

        const instantEvent = parsed.traceEvents.find((e: { name: string }) => e.name === "milestone");
        expect(instantEvent).toBeDefined();
        expect(instantEvent.ph).toBe("i");

        expect(parsed.summary).toBeDefined();
        expect(parsed.summary.totalDurationMs).toBeGreaterThan(0);
        expect(parsed.summary.steps.step_1).toBeGreaterThan(0);
    });

    it("handles multiple sequential steps cleanly", () => {
        const recorder = new WebTraceRecorder();
        recorder.start();

        recorder.startStep("a");
        recorder.endStep("a");

        recorder.startStep("b");
        recorder.endStep("b");

        const parsed = JSON.parse(recorder.finalize());
        expect(parsed.summary.steps.a).toBeDefined();
        expect(parsed.summary.steps.b).toBeDefined();
    });
});

describe("runUndoRedoHistoryStep", () => {
    it("applies 35 distinct edits calling sealBurst per edit, proves eviction to 30, and executes 10 undos and 5 redos", async () => {
        resetHistoryForTests();
        useAppState.setState({
            images: [
                {
                    id: "test-img",
                    filename: "test.jpg",
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                },
            ],
            activeIndex: 0,
            renderSeq: 0,
        });
        const uninit = initHistory(useAppState);

        const sealBurstSpy = vi.spyOn(undoHistoryModule, "sealBurst");
        const undoSpy = vi.spyOn(undoHistoryModule, "undo");
        const redoSpy = vi.spyOn(undoHistoryModule, "redo");

        const fakeWaitRender = vi.fn(async () => 5);

        const result = await runUndoRedoHistoryStep(useAppState, fakeWaitRender);

        expect(result.edits).toBe(35);
        expect(result.undos).toBe(10);
        expect(result.redos).toBe(5);
        // sealBurst called per edit
        expect(sealBurstSpy).toHaveBeenCalledTimes(35);
        // History depth capped at 30 after 35 edits (proves eviction fired)
        expect(result.depthAfterBurst).toEqual({ undo: 30, redo: 0 });
        // undo called 10 times
        expect(undoSpy).toHaveBeenCalledTimes(10);
        // redo called 5 times
        expect(redoSpy).toHaveBeenCalledTimes(5);
        // Final history depth: 30 - 10 + 5 = 25 undos, 5 redos
        expect(historyDepth("test-img")).toEqual({ undo: 25, redo: 5 });

        uninit();
        sealBurstSpy.mockRestore();
        undoSpy.mockRestore();
        redoSpy.mockRestore();
    });

    it("returns zeroed result when no active image exists", async () => {
        useAppState.setState({ images: [], activeIndex: 0 });
        const result = await runUndoRedoHistoryStep(useAppState);
        expect(result).toEqual({ edits: 0, undos: 0, redos: 0, finalRenderMs: 0, depthAfterBurst: null });
    });
});

