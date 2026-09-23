import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageRenderer, Scheduler } from "./ImageRenderer.ts";
import { ImageProcessor } from "./ImageProcessor.ts";
import { useAppState } from "../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import type { Adjustments, Histogram, PixelData } from "../backend/types.ts";

function makeAdjustments(overrides: Partial<Adjustments> = {}): Adjustments {
    return { ...DEFAULT_ADJUSTMENTS, ...overrides } as Adjustments;
}

function makeHistogram(): Histogram {
    return {
        red: new Uint32Array(256),
        green: new Uint32Array(256),
        blue: new Uint32Array(256),
        luma: new Uint32Array(256),
    };
}

function makePixelData(): PixelData {
    return {
        kind: "raw",
        width: 10,
        height: 10,
        data: new Uint8ClampedArray(10 * 10 * 4),
    };
}

class FakeScheduler implements Scheduler {
    rafCallbacks = new Map<number, FrameRequestCallback>();
    timeoutCallbacks = new Map<number, () => void>();
    nextRafId = 1;
    nextTimeoutId = 1;

    requestAnimationFrame(callback: FrameRequestCallback): number {
        const id = this.nextRafId++;
        this.rafCallbacks.set(id, callback);
        return id;
    }

    cancelAnimationFrame(handle: number): void {
        this.rafCallbacks.delete(handle);
    }

    setTimeout(callback: () => void, _ms: number): ReturnType<typeof setTimeout> {
        const id = this.nextTimeoutId++;
        this.timeoutCallbacks.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
    }

    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
        this.timeoutCallbacks.delete(handle as unknown as number);
    }

    flushTimeouts() {
        const callbacks = Array.from(this.timeoutCallbacks.values());
        this.timeoutCallbacks.clear();
        for (const cb of callbacks) cb();
    }

    flushRafs() {
        const callbacks = Array.from(this.rafCallbacks.values());
        this.rafCallbacks.clear();
        for (const cb of callbacks) cb(performance.now());
    }

    flushAll() {
        this.flushTimeouts();
        this.flushRafs();
    }
}

function makeProcessor(): ImageProcessor {
    return {
        render: vi.fn(async (_id, _adj, _renderCount, onRender) => {
            onRender(_id, makePixelData(), makeHistogram(), _renderCount);
        }),
    } as unknown as ImageProcessor;
}

function resetStore() {
    useAppState.setState(() => ({
        images: [],
        activeIndex: 0,
        selectedIds: new Set(),
        showOriginal: false,
        renderedData: null,
        renderedHistogram: null,
    }));
}

describe("ImageRenderer", () => {
    let processor: ImageProcessor;
    let scheduler: FakeScheduler;
    let renderer: ImageRenderer;

    beforeEach(() => {
        resetStore();
        processor = makeProcessor();
        scheduler = new FakeScheduler();
    });

    afterEach(() => {
        renderer?.dispose();
    });

    it("renders immediately on start", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();

        expect(scheduler.rafCallbacks.size).toBe(1);
        scheduler.flushRafs();
        expect(processor.render).toHaveBeenCalledTimes(1);
    });

    it("coalesces rapid adjustment changes into one render", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments({ light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 0 } }) }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        expect(processor.render).toHaveBeenCalledTimes(1);
        vi.mocked(processor.render).mockClear();

        // Fire many adjustment changes rapidly.
        for (let i = 1; i <= 5; i++) {
            useAppState.setState((state) => {
                const img = state.images[0];
                if (img) {
                    img.adjustments = makeAdjustments({ light: { ...DEFAULT_ADJUSTMENTS.light, exposure: i } });
                }
            });
        }

        // RAF should not fire until the coalescing timeout completes.
        expect(scheduler.timeoutCallbacks.size).toBe(1);
        expect(scheduler.rafCallbacks.size).toBe(0);

        scheduler.flushAll();

        // Only one render should run for the whole burst.
        expect(processor.render).toHaveBeenCalledTimes(1);
        const lastCallAdj = vi.mocked(processor.render).mock.calls[0]![1] as Adjustments;
        expect(lastCallAdj.light.exposure).toBe(5);
    });

    it("coalesces active image navigation renders", () => {
        useAppState.setState({
            images: [
                { id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() },
                { id: "img-2", filename: "b.jpg", adjustments: makeAdjustments() },
            ],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        useAppState.setState({ activeIndex: 1 });

        // Navigation changes are coalesced to prevent 4K preview flood during rapid scrubbing
        expect(scheduler.timeoutCallbacks.size).toBe(1);
        expect(scheduler.rafCallbacks.size).toBe(0);
        scheduler.flushAll();

        expect(processor.render).toHaveBeenCalledTimes(1);
        expect(vi.mocked(processor.render).mock.calls[0]![0]).toBe("img-2");
    });

    it("coalesces rapid active image navigation into one render", () => {
        useAppState.setState({
            images: [
                { id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() },
                { id: "img-2", filename: "b.jpg", adjustments: makeAdjustments() },
                { id: "img-3", filename: "c.jpg", adjustments: makeAdjustments() },
            ],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        // Rapidly switch from 0 to 1 to 2
        useAppState.setState({ activeIndex: 1 });
        useAppState.setState({ activeIndex: 2 });

        expect(scheduler.timeoutCallbacks.size).toBe(1);
        expect(scheduler.rafCallbacks.size).toBe(0);
        scheduler.flushAll();

        expect(processor.render).toHaveBeenCalledTimes(1);
        expect(vi.mocked(processor.render).mock.calls[0]![0]).toBe("img-3");
    });

    it("renders immediately when showOriginal toggles", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        useAppState.setState({ showOriginal: true });

        expect(scheduler.rafCallbacks.size).toBe(1);
        scheduler.flushRafs();

        expect(processor.render).toHaveBeenCalledTimes(1);
        const adj = vi.mocked(processor.render).mock.calls[0]![1] as Adjustments;
        expect(adj).toBe(DEFAULT_ADJUSTMENTS);
    });

    it("preserves rotation when showOriginal is true", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments({ rotation: 90 }) }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        useAppState.setState({ showOriginal: true });

        expect(scheduler.rafCallbacks.size).toBe(1);
        scheduler.flushRafs();

        expect(processor.render).toHaveBeenCalledTimes(1);
        const adj = vi.mocked(processor.render).mock.calls[0]![1] as Adjustments;
        expect(adj.rotation).toBe(90);
        expect(adj.light.exposure).toBe(DEFAULT_ADJUSTMENTS.light.exposure);
        expect(adj.color.temperature).toBe(DEFAULT_ADJUSTMENTS.color.temperature);
    });

    it("drops a stale coalesced render when an immediate render superseded it", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        // Start a coalesced adjustment update.
        useAppState.setState((state) => {
            const img = state.images[0];
            if (img) img.adjustments = makeAdjustments({ light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 1 } });
        });

        // Before the timeout fires, switch images (immediate).
        useAppState.setState({ activeIndex: 0 });
        // Simulate new image id by replacing images array.
        useAppState.setState({
            images: [{ id: "img-2", filename: "b.jpg", adjustments: makeAdjustments() }],
        });

        scheduler.flushAll();

        // Only the immediate render for img-2 should run.
        expect(processor.render).toHaveBeenCalledTimes(1);
        expect(vi.mocked(processor.render).mock.calls[0]![0]).toBe("img-2");
    });

    it("clears pending work on dispose", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() }],
        });

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        vi.mocked(processor.render).mockClear();

        useAppState.setState((state) => {
            const img = state.images[0];
            if (img) img.adjustments = makeAdjustments({ light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 1 } });
        });

        renderer.dispose();

        expect(scheduler.timeoutCallbacks.size).toBe(0);
        expect(scheduler.rafCallbacks.size).toBe(0);

        scheduler.flushAll();
        expect(processor.render).not.toHaveBeenCalled();
    });

    it("drops stale preview responses when a newer render has already updated the preview", () => {
        useAppState.setState({
            images: [{ id: "img-1", filename: "a.jpg", adjustments: makeAdjustments() }],
        });

        const callbacks: { renderCount: number; callback: (data: PixelData, histogram: Histogram) => void }[] = [];
        processor = {
            render: vi.fn((_id, _adj, renderCount, onRender) => {
                callbacks.push({
                    renderCount,
                    callback: (data, histogram) => onRender(_id, data, histogram, renderCount),
                });
            }),
        } as unknown as ImageProcessor;

        renderer = new ImageRenderer(processor, scheduler);
        renderer.start();
        scheduler.flushAll();
        expect(callbacks.length).toBe(1);

        // Simulate a newer render completing and updating the preview.
        useAppState.setState((state) => {
            const img = state.images[0];
            if (img) img.adjustments = makeAdjustments({ light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 1 } });
        });
        scheduler.flushAll();
        expect(callbacks.length).toBe(2);

        callbacks[1]!.callback(makePixelData(), makeHistogram());
        expect(useAppState.getState().renderedData).not.toBeNull();

        // Reset marker to detect a stale write.
        useAppState.getState().setRenderedPreview(null, null);

        // Older response should be ignored.
        callbacks[0]!.callback(makePixelData(), makeHistogram());
        expect(useAppState.getState().renderedData).toBeNull();
    });
});
