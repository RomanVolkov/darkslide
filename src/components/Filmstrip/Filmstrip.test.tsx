import { render, screen, fireEvent, waitFor } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    FilmstripItem,
    Filmstrip,
    thumbnailRegistry,
    MAX_CONCURRENT_THUMB_BATCHES,
    FAST_THUMBNAILS_PER_BATCH,
    HQ_THUMBNAILS_PER_BATCH,
} from "./Filmstrip.tsx";
import { DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";
import { useAppState } from "../../state/appState.ts";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { Panel } from "../constants/index.ts";
import type { ImageEntry } from "../../types/index.ts";
import type { PixelData } from "../../backend/types.ts";
import { ActionService } from "../../services/ActionService.ts";

const SAMPLE_IMAGE: ImageEntry = {
    id: "test-img-1",
    filename: "sample.jpg",
    adjustments: DEFAULT_ADJUSTMENTS,
};

function makePixelData(width = 10, height = 10): PixelData {
    return {
        kind: "raw",
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
    };
}

type ThumbRequest = { id: string; adj: typeof DEFAULT_ADJUSTMENTS; quality?: "fast" | "hq"; maxDim?: number };

let pendingItems: ThumbRequest[] = [];
let allBatches: ThumbRequest[][] = [];
/** When set, the mocked backend holds each batch until its resolver is invoked. */
let gateBatches = false;
let releaseBatch: (() => void) | null = null;
/** When set, the next batch to arrive rejects instead of resolving. */
let rejectNextBatch = false;

vi.mock("../../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({
        renderThumbnails: vi.fn(async (items: ThumbRequest[]) => {
            pendingItems = items;
            allBatches.push(items);
            if (rejectNextBatch) {
                rejectNextBatch = false;
                throw new Error("ipc failure");
            }
            if (gateBatches) {
                await new Promise<void>((resolve) => { releaseBatch = resolve; });
            }
            return items.map(() => makePixelData());
        }),
    })),
}));

function renderFilmstripItem(overrides: Partial<Parameters<typeof FilmstripItem>[0]> = {}) {
    const props = {
        img: SAMPLE_IMAGE,
        active: false,
        selected: false,
        index: 0,
        onSelect: vi.fn(),
        grid: false,
        pixelData: undefined as PixelData | undefined,
        onVisible: vi.fn(),
        ...overrides,
    };
    const result = render(<FilmstripItem {...props} />);
    return { ...result, props };
}

describe("FilmstripItem", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pendingItems = [];
    });

    it("renders loading spinner when pixelData is missing", () => {
        const { container } = renderFilmstripItem();
        const spinner = container.querySelector('[class*="spinner"]');
        expect(spinner).toBeInTheDocument();
    });

    it("hides loading spinner after pixelData is provided", () => {
        const { container, rerender, props } = renderFilmstripItem();
        expect(container.querySelector('[class*="spinner"]')).toBeInTheDocument();

        rerender(<FilmstripItem {...props} pixelData={makePixelData()} />);
        expect(container.querySelector('[class*="spinner"]')).not.toBeInTheDocument();
    });

    it("does not show loading spinner again when pixelData updates", () => {
        const { container, rerender, props } = renderFilmstripItem({ pixelData: makePixelData() });
        expect(container.querySelector('[class*="spinner"]')).not.toBeInTheDocument();

        rerender(<FilmstripItem {...props} pixelData={makePixelData(20, 20)} />);
        expect(container.querySelector('[class*="spinner"]')).not.toBeInTheDocument();
    });

    it("calls onSelect when clicked", () => {
        const onSelect = vi.fn();
        renderFilmstripItem({ index: 2, onSelect, pixelData: makePixelData() });
        fireEvent.click(screen.getByText("sample.jpg"));
        expect(onSelect).toHaveBeenCalledWith(2, expect.anything());
    });

    it("calls ActionService.deleteSelected when clicking the delete button", () => {
        const deleteSpy = vi.spyOn(ActionService, "deleteSelected").mockImplementation(async () => {});
        renderFilmstripItem({ pixelData: makePixelData() });
        const delBtn = screen.getByTestId("filmstrip-delete-btn-test-img-1");
        fireEvent.click(delBtn);
        expect(deleteSpy).toHaveBeenCalledWith(["test-img-1"]);
    });

    it("renders filename in strip mode but not in grid mode", () => {
        const { rerender, props } = renderFilmstripItem({ grid: false, pixelData: makePixelData() });
        expect(screen.getByText("sample.jpg")).toBeInTheDocument();

        rerender(<FilmstripItem {...props} grid={true} />);
        expect(screen.queryByText("sample.jpg")).not.toBeInTheDocument();
    });
});

describe("Filmstrip", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pendingItems = [];
        allBatches = [];
        gateBatches = false;
        releaseBatch = null;
        rejectNextBatch = false;
        thumbnailRegistry.clear();
    });

    it("batches visible thumbnail requests", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "c.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images }));

        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
        });

        expect(allBatches[0]!.map(i => i.id)).toEqual(["img-1", "img-2", "img-3"]);
    });

    it("repairs an out-of-range activeIndex so the panel/preview keep a target", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "c.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];
        useAppState.setState(() => ({ images, activeIndex: 99 }));

        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(useAppState.getState().activeIndex).toBe(2);
        });
    });

    it("prioritizes the active image thumbnail in each chunk", async () => {
        const images: ImageEntry[] = Array.from({ length: 5 }, (_, i) => ({
            id: `img-${i + 1}`,
            filename: `${i + 1}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 3 }));

        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
        });

        expect(allBatches[0]![0]!.id).toBe("img-4");
        const fastIds = allBatches
            .filter(b => b.every(i => i.quality === "fast"))
            .flat()
            .map(i => i.id);
        const distanceOrder = ["img-4", "img-3", "img-5", "img-2", "img-1"];
        expect(fastIds).toEqual(distanceOrder);
    });

    it("packs fast drafts into deep batches of up to 12", async () => {
        const images: ImageEntry[] = Array.from({ length: 12 }, (_, i) => ({
            id: `img-${i + 1}`,
            filename: `${i + 1}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images }));

        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
        });

        const fastBatches = allBatches.filter(b => b.every(i => i.quality === "fast"));
        expect(fastBatches.length).toBeGreaterThan(0);
        expect(fastBatches[0]!.length).toBeGreaterThan(4);
        expect(fastBatches[0]!.length).toBeLessThanOrEqual(12);
    });

    it("schedules fast draft thumbnail first then upgrades to hq quality", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images }));

        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThanOrEqual(2);
        });

        expect(allBatches[0]!.every(item => item.quality === "fast")).toBe(true);
        expect(allBatches[1]!.every(item => item.quality === "hq")).toBe(true);
    });

    it("re-requests thumbnail when image adjustments change", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(pendingItems.length).toBe(1);
        });

        pendingItems = [];

        useAppState.setState(state => {
            state.images[0]!.adjustments = {
                ...DEFAULT_ADJUSTMENTS,
                light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 10 },
            };
        });

        await waitFor(() => {
            expect(pendingItems.length).toBe(1);
            expect(pendingItems[0]!.adj.light.exposure).toBe(10);
        });
    });

    it("re-requests thumbnails when adjustments are pasted to multiple images", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: { ...DEFAULT_ADJUSTMENTS, light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 42 } } },
            { id: "img-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "c.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, selectedIds: new Set(["img-2", "img-3"]) }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(pendingItems.length).toBe(3);
        });

        pendingItems = [];

        useAppState.getState().yankAdjustments();
        useAppState.getState().pasteAdjustments(new Set(["img-2", "img-3"]));

        await waitFor(() => {
            expect(pendingItems.length).toBe(2);
            expect(pendingItems.map(p => p.id).sort()).toEqual(["img-2", "img-3"]);
            expect(pendingItems[0]!.adj.light.exposure).toBe(42);
            expect(pendingItems[1]!.adj.light.exposure).toBe(42);
        });
    });

    it("debounces rapid navigation key events and updates active image after delay", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "c.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-4", filename: "d.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, selectedIds: new Set(["img-1"]) }));
        render(<Filmstrip focused={true} />);
        keyboardManager.setActive(RegistrationID.filmstrip);

        keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "l" }));
        keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "l" }));

        expect(useAppState.getState().activeIndex).toBe(0);

        await waitFor(() => {
            expect(useAppState.getState().activeIndex).toBe(2);
        });

        keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "l" }));
        await waitFor(() => {
            expect(useAppState.getState().activeIndex).toBe(3);
        });
    });

    it("virtualizes filmstrip items in line mode, rendering only visible and overscan items", () => {
        const images: ImageEntry[] = Array.from({ length: 100 }, (_, i) => ({
            id: `img-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        const { container } = render(<Filmstrip focused={false} />);
        const renderedItems = container.querySelectorAll('[class*="item"]');

        expect(renderedItems.length).toBeLessThan(30);
        expect(renderedItems.length).toBeGreaterThan(0);
    });

    it("virtualizes filmstrip items in grid mode, rendering only visible and overscan rows", () => {
        const images: ImageEntry[] = Array.from({ length: 150 }, (_, i) => ({
            id: `img-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        const { container } = render(<Filmstrip focused={false} />);
        const renderedItems = container.querySelectorAll('[class*="item"]');

        expect(renderedItems.length).toBeLessThan(80);
        expect(renderedItems.length).toBeGreaterThan(0);
    });

    it("coalesces visible thumbnail requests into grouped batches", async () => {
        const images: ImageEntry[] = Array.from({ length: 6 }, (_, i) => ({
            id: `img-coalesce-${i + 1}`,
            filename: `${i + 1}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0 }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
        });

        const dispatched = new Set(allBatches.flat().map(i => i.id));
        for (const img of images) {
            expect(dispatched.has(img.id)).toBe(true);
        }
    });

    it("cancels pending batch requests for items that scrolled offscreen before dispatch", async () => {
        const images: ImageEntry[] = [
            { id: "img-off-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-off-2", filename: "2.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0 }));
        const { unmount } = render(<Filmstrip focused={false} />);
        unmount();

        await new Promise(r => setTimeout(r, 40));
        const requestedOffscreen = allBatches.flat().filter(b => b.id.startsWith("img-off-"));
        expect(requestedOffscreen.length).toBe(0);
    });

    it("positions grid items at 0px and multiples of 188px within centered track", () => {
        const images: ImageEntry[] = Array.from({ length: 12 }, (_, i) => ({
            id: `img-pos-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        const { container } = render(<Filmstrip focused={false} />);
        const items = container.querySelectorAll<HTMLElement>('[class*="item"]');
        expect(items.length).toBeGreaterThan(0);
        expect(items[0]!.style.left).toBe("0px");
        expect(items[1]!.style.left).toBe("188px");
    });

    it("exits grid mode to strip mode on item double click", () => {
        const images: ImageEntry[] = [
            { id: "img-dbl-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-dbl-2", filename: "2.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        const { container } = render(<Filmstrip focused={false} />);
        const items = container.querySelectorAll('[class*="item"]');
        expect(items.length).toBeGreaterThan(1);

        fireEvent.dblClick(items[1]!);
        expect(useAppState.getState().filmstripView).toBe("strip");
        expect(useAppState.getState().activeIndex).toBe(1);
    });

    it("exits grid mode when pressing Escape", () => {
        const images: ImageEntry[] = [
            { id: "img-close-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        render(<Filmstrip focused={true} />);
        keyboardManager.setActive(RegistrationID.filmstrip);
        keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(useAppState.getState().filmstripView).toBe("strip");
    });

    it("navigates down across rows when pressing j in grid mode", async () => {
        const images: ImageEntry[] = Array.from({ length: 20 }, (_, i) => ({
            id: `img-j-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        render(<Filmstrip focused={true} />);
        keyboardManager.setActive(RegistrationID.filmstrip);

        keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        await new Promise(r => setTimeout(r, 60));

        expect(useAppState.getState().activeIndex).toBeGreaterThan(0);
    });

    it("commits completed thumbnails and continues queue after rapid scroll updates", async () => {
        const images: ImageEntry[] = Array.from({ length: 10 }, (_, i) => ({
            id: `img-scroll-${i + 1}`,
            filename: `${i + 1}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0 }));
        const { container } = render(<Filmstrip focused={false} />);

        const scrollEl = container.querySelector('[class*="strip"]');
        if (scrollEl) {
            fireEvent.scroll(scrollEl, { target: { scrollLeft: 200 } });
            fireEvent.scroll(scrollEl, { target: { scrollLeft: 400 } });
        }

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
            expect(thumbnailRegistry.size).toBeGreaterThan(0);
        });
    });

    it("keeps focus on the filmstrip when a thumbnail is clicked", () => {
        const images: ImageEntry[] = [
            { id: "img-focus-1", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-focus-2", filename: "b.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({
            images,
            activeIndex: 0,
            filmstripView: "strip",
            focusPanel: Panel.Filmstrip,
        }));
        const { container } = render(<Filmstrip focused={true} />);
        const items = container.querySelectorAll<HTMLElement>('[class*="item"]');
        expect(items.length).toBeGreaterThan(1);

        fireEvent.click(items[1]!);

        expect(useAppState.getState().activeIndex).toBe(1);
        expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
    });

    it("keeps multiple thumbnail batches in flight up to the concurrency cap", async () => {
        // 40 visible tiles in a wide viewport => fast queue packs 12 per batch,
        // so three batches can genuinely be in flight at once.
        const images: ImageEntry[] = Array.from({ length: 40 }, (_, i) => ({
            id: `img-conc-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        const originalInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", { value: 4000, configurable: true });

        gateBatches = true;
        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        try {
            await waitFor(() => {
                expect(allBatches.length).toBe(MAX_CONCURRENT_THUMB_BATCHES);
            });

            // Releasing one gated batch must admit exactly one more.
            for (let i = 0; i < 4; i++) {
                await waitFor(() => {
                    expect(releaseBatch).not.toBeNull();
                });
                const release = releaseBatch!;
                releaseBatch = null;
                release();
                await new Promise(r => setTimeout(r, 0));
            }
        } finally {
            Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
        }
    });

    it("advertises a concurrency cap of 3 and a fast chunk of 12", () => {
        expect(MAX_CONCURRENT_THUMB_BATCHES).toBe(3);
        expect(FAST_THUMBNAILS_PER_BATCH).toBe(12);
        expect(HQ_THUMBNAILS_PER_BATCH).toBe(4);
    });

    it("drops queued items whose adjustments changed before dispatch", async () => {
        const images: ImageEntry[] = Array.from({ length: 40 }, (_, i) => ({
            id: `img-stale-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        const originalInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", { value: 4000, configurable: true });

        gateBatches = true;
        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        try {
            // Batches 1..3 are gated in flight; the rest sit in the queue.
            await waitFor(() => {
                expect(allBatches.length).toBe(MAX_CONCURRENT_THUMB_BATCHES);
            });
            const dispatchedIds = new Set(allBatches.flat().map(i => i.id));
            const queuedImage = images.find(i => !dispatchedIds.has(i.id));
            expect(queuedImage).toBeDefined();

            allBatches = [];
            useAppState.setState(state => {
                const target = state.images.find(i => i.id === queuedImage!.id)!;
                target.adjustments = { ...DEFAULT_ADJUSTMENTS, light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 77 } };
            });

            while (releaseBatch) {
                const release = releaseBatch;
                releaseBatch = null;
                release();
                await new Promise(r => setTimeout(r, 0));
            }

            // The mutated queued item must not be rendered with its stale payload.
            await waitFor(() => {
                const staleDispatches = allBatches.flat().filter(i => i.id === queuedImage!.id && i.adj.light.exposure !== 77);
                expect(staleDispatches.length).toBe(0);
            });
        } finally {
            Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
        }
    });

    it("drops a queued image that leaves the visible set before dispatch", async () => {
        const images: ImageEntry[] = Array.from({ length: 60 }, (_, i) => ({
            id: `img-drop-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        const originalInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", { value: 4000, configurable: true });

        gateBatches = true;
        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        try {
            // Wide viewport => more visible tiles than the 3-batch concurrency
            // window, so some fast requests sit queued (not yet dispatched).
            await waitFor(() => {
                expect(allBatches.length).toBe(MAX_CONCURRENT_THUMB_BATCHES);
            });
            const dispatchedIds = new Set(allBatches.flat().map(i => i.id));
            const queuedImage = images.find(i => !dispatchedIds.has(i.id));
            expect(queuedImage).toBeDefined();

            allBatches = [];
            // Removing the image from the set also removes it from `visibleIds`,
            // exercising the same dispatch-time visibility drop.
            useAppState.setState(state => {
                state.images = state.images.filter(i => i.id !== queuedImage!.id);
            });

            while (releaseBatch) {
                const release = releaseBatch;
                releaseBatch = null;
                release();
                await new Promise(r => setTimeout(r, 0));
            }

            await new Promise(r => setTimeout(r, 30));
            expect(allBatches.flat().some(i => i.id === queuedImage!.id)).toBe(false);
        } finally {
            Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
        }
    });

    it("frees the dispatcher slot when a batch rejects", async () => {
        const images: ImageEntry[] = Array.from({ length: 40 }, (_, i) => ({
            id: `img-reject-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        const originalInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", { value: 4000, configurable: true });

        rejectNextBatch = true;
        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        try {
            // The rejected slot must be reclaimed so every image still dispatches.
            await waitFor(() => {
                const dispatched = new Set(allBatches.flat().map(i => i.id));
                expect(dispatched.size).toBe(images.length);
            }, { timeout: 2000 });

            // The rejected batch may be retried, so counts can exceed 1 — the
            // guarantee under test is that the slot frees and nothing deadlocks.
            const dispatched = new Set(allBatches.flat().map(i => i.id));
            for (const img of images) {
                expect(dispatched.has(img.id)).toBe(true);
            }
        } finally {
            Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
        }
    });

    it("does not dispatch duplicate keys for the same image", async () => {
        const images: ImageEntry[] = Array.from({ length: 10 }, (_, i) => ({
            id: `img-dup-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(thumbnailRegistry.size).toBe(images.length);
        });

        const fastIds = allBatches.filter(b => b.every(i => i.quality === "fast")).flat().map(i => i.id);
        expect(new Set(fastIds).size).toBe(fastIds.length);
    });

    it("requests strip HQ thumbnails at maxDim 200", async () => {
        const images: ImageEntry[] = [
            { id: "img-hq-strip", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThanOrEqual(2);
        });

        const hqBatch = allBatches.find(b => b.every(i => i.quality === "hq"));
        expect(hqBatch).toBeDefined();
        expect(hqBatch!.every(i => i.maxDim === 200)).toBe(true);
    });

    it("requests grid HQ thumbnails at maxDim 400", async () => {
        const images: ImageEntry[] = [
            { id: "img-hq-grid", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThanOrEqual(2);
        });

        const hqBatch = allBatches.find(b => b.every(i => i.quality === "hq"));
        expect(hqBatch).toBeDefined();
        expect(hqBatch!.every(i => i.maxDim === 400)).toBe(true);
    });

    it("requests fast drafts at maxDim 160", async () => {
        const images: ImageEntry[] = [
            { id: "img-fast", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.length).toBeGreaterThan(0);
        });

        const fastBatch = allBatches.find(b => b.every(i => i.quality === "fast"));
        expect(fastBatch).toBeDefined();
        expect(fastBatch!.every(i => i.maxDim === 160)).toBe(true);
    });

    it("re-requests an HQ entry whose maxDim does not match the current view", async () => {
        const images: ImageEntry[] = [
            { id: "img-mismatch", filename: "a.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "strip" }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(allBatches.some(b => b.every(i => i.quality === "hq"))).toBe(true);
        });

        // Simulate a registry entry produced by grid sizing appearing while in strip mode.
        const existing = thumbnailRegistry.get("img-mismatch");
        if (existing?.adjHash !== undefined) {
            thumbnailRegistry.set("img-mismatch", { ...existing, maxDim: 400 });
        }
        allBatches = [];

        fireEvent(window, new Event("focus"));

        await waitFor(() => {
            const hq = allBatches.find(b => b.every(i => i.quality === "hq"));
            expect(hq).toBeDefined();
            expect(hq!.every(i => i.maxDim === 200)).toBe(true);
        });
    });

    it("re-triggers thumbnail processing when window receives focus", async () => {
        const images: ImageEntry[] = [
            { id: "img-focus-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({ images, activeIndex: 0 }));
        render(<Filmstrip focused={false} />);

        await waitFor(() => {
            expect(thumbnailRegistry.has("img-focus-1")).toBe(true);
        });

        thumbnailRegistry.delete("img-focus-1");
        expect(thumbnailRegistry.has("img-focus-1")).toBe(false);

        window.dispatchEvent(new Event("focus"));

        await waitFor(() => {
            expect(thumbnailRegistry.has("img-focus-1")).toBe(true);
        });
    });

    it("supports Shift+Click range selection", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "2.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "3.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-4", filename: "4.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({
            images,
            activeIndex: 0,
            selectedIds: new Set(["img-1"]),
        }));

        render(<Filmstrip focused={false} />);

        const item3 = screen.getByTestId("filmstrip-item-img-3");
        fireEvent.click(item3, { shiftKey: true });

        expect(useAppState.getState().activeIndex).toBe(2);
        expect(Array.from(useAppState.getState().selectedIds).sort()).toEqual(["img-1", "img-2", "img-3"]);
    });

    it("supports Cmd/Ctrl+Click toggle selection", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "2.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-3", filename: "3.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({
            images,
            activeIndex: 0,
            selectedIds: new Set(["img-1"]),
        }));

        render(<Filmstrip focused={false} />);

        const item3 = screen.getByTestId("filmstrip-item-img-3");
        fireEvent.click(item3, { metaKey: true });

        expect(useAppState.getState().activeIndex).toBe(2);
        expect(Array.from(useAppState.getState().selectedIds).sort()).toEqual(["img-1", "img-3"]);

        // Toggle off img-1
        const item1 = screen.getByTestId("filmstrip-item-img-1");
        fireEvent.click(item1, { metaKey: true });
        expect(Array.from(useAppState.getState().selectedIds)).toEqual(["img-3"]);
    });

    it("opens context menu on right-click and dispatches actions", async () => {
        const images: ImageEntry[] = [
            { id: "img-1", filename: "1.jpg", adjustments: DEFAULT_ADJUSTMENTS },
            { id: "img-2", filename: "2.jpg", adjustments: DEFAULT_ADJUSTMENTS },
        ];

        useAppState.setState(() => ({
            images,
            activeIndex: 0,
            selectedIds: new Set(["img-1"]),
        }));

        const copySpy = vi.spyOn(ActionService, "copyAdjustments").mockImplementation(() => {});
        const rotateSpy = vi.spyOn(ActionService, "rotateCW").mockImplementation(() => {});
        const exportSpy = vi.spyOn(ActionService, "openExport").mockImplementation(() => {});
        const deleteSpy = vi.spyOn(ActionService, "deleteSelected").mockImplementation(async () => {});

        render(<Filmstrip focused={false} />);

        const item2 = screen.getByTestId("filmstrip-item-img-2");
        fireEvent.contextMenu(item2, { clientX: 150, clientY: 200 });

        // Context menu should appear
        expect(screen.getByTestId("context-menu")).toBeTruthy();
        expect(screen.getByText("Copy Adjustments")).toBeTruthy();
        expect(screen.getByText("Paste Adjustments")).toBeTruthy();
        expect(screen.getByText("Rotate 90° Clockwise")).toBeTruthy();
        expect(screen.getByText("Export Selected...")).toBeTruthy();
        expect(screen.getByText("Remove from Session")).toBeTruthy();

        // Clicking Copy Adjustments
        fireEvent.click(screen.getByText("Copy Adjustments"));
        expect(copySpy).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("context-menu")).toBeNull();

        // Right-click again to test Rotate
        fireEvent.contextMenu(item2, { clientX: 150, clientY: 200 });
        fireEvent.click(screen.getByText("Rotate 90° Clockwise"));
        expect(rotateSpy).toHaveBeenCalledTimes(1);

        // Right-click again to test Export
        fireEvent.contextMenu(item2, { clientX: 150, clientY: 200 });
        fireEvent.click(screen.getByText("Export Selected..."));
        expect(exportSpy).toHaveBeenCalledTimes(1);

        // Right-click again to test Remove from Session
        fireEvent.contextMenu(item2, { clientX: 150, clientY: 200 });
        fireEvent.click(screen.getByText("Remove from Session"));
        expect(deleteSpy).toHaveBeenCalledWith(["img-2"]);
    });

    it("stabilizes and terminates batch requests for large collections exceeding 50 images", async () => {
        const images: ImageEntry[] = Array.from({ length: 70 }, (_, i) => ({
            id: `img-stab-${i}`,
            filename: `${i}.jpg`,
            adjustments: DEFAULT_ADJUSTMENTS,
        }));

        useAppState.setState(() => ({ images, activeIndex: 0, filmstripView: "grid" }));
        render(<Filmstrip focused={false} />);

        // Wait for batches to settle
        await new Promise(r => setTimeout(r, 200));
        const finalCount = allBatches.length;
        expect(finalCount).toBeGreaterThan(0);

        // Wait another interval: allBatches should NOT keep increasing
        await new Promise(r => setTimeout(r, 150));
        expect(allBatches.length).toBe(finalCount);
    });
});

