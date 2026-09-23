import { render, screen, act, fireEvent } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderThumbnails = vi.fn(async () => [] as never[]);
vi.mock("../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({
        renderPreview: vi.fn(),
        renderThumbnail: vi.fn(),
        renderThumbnails,
        autoWhiteBalance: vi.fn(async () => ({ temperature: 0, tint: 0 })),
        import: vi.fn(async () => null),
        export: vi.fn(async () => {}),
        unload: vi.fn(async () => {}),
        clearAllAdjustments: vi.fn(async () => {}),
    })),
}));

import { AppLayout } from "./AppLayout.tsx";
import { getBackend } from "../backend/index.ts";
import { ImageProcessor } from "../services/ImageProcessor.ts";
import { useAppState } from "../state/appState.ts";
import { Panel } from "./constants/index.ts";
import { ADJ_SET, DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import type { PixelData } from "../backend/types.ts";

if (typeof globalThis.createImageBitmap === "undefined") {
    globalThis.createImageBitmap = vi.fn(async () => ({
        width: 10,
        height: 10,
        close: vi.fn(),
    } as unknown as ImageBitmap));
}

function pixelData(width = 10, height = 10): PixelData {
    return { kind: "raw", width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function histogram() {
    const arr = () => new Uint32Array(256);
    return { red: arr(), green: arr(), blue: arr(), luma: arr() };
}

function image(id: string) {
    return { id, filename: `${id}.jpg`, adjustments: structuredClone(DEFAULT_ADJUSTMENTS) };
}

describe("AppLayout editing-state visibility", () => {
    beforeEach(() => {
        useAppState.setState({
            images: [image("a"), image("b"), image("c")],
            activeIndex: 0,
            renderedData: pixelData(),
            renderedImageId: "a",
            renderedHistogram: histogram(),
            filmstripView: "strip",
            focusPanel: Panel.Adjustments,
            selectedIds: new Set(["a"]),
        });
    });

    it("keeps image, histogram, filmstrip and adjustments panel visible while editing", async () => {
        const processor = new ImageProcessor(await getBackend());
        render(<AppLayout processor={processor} />);

        const assertEditingUiVisible = () => {
            expect(screen.getByTestId("image-pane")).toBeVisible();
            expect(screen.getByTestId("histogram")).toBeVisible();
            expect(screen.getByTestId("filmstrip")).toBeVisible();
            expect(screen.getByTestId("adjustments-panel")).toBeVisible();
        };

        assertEditingUiVisible();

        // Simulate an adjustment edit from the panel.
        act(() => {
            useAppState.getState().updateImage("a", (img) => {
                img.adjustments = ADJ_SET.exposure(img.adjustments, 1.0);
            });
        });
        assertEditingUiVisible();

        // Simulate a real slider change through the DOM (mouse drag / click).
        const firstSlider = screen.getAllByRole("slider")[0];
        if (firstSlider) {
            act(() => {
                fireEvent.change(firstSlider, { target: { value: "0.5" } });
            });
        }
        assertEditingUiVisible();

        // Simulate entering geometry edit mode.
        act(() => {
            useAppState.getState().setGeometryEdit(true);
        });
        assertEditingUiVisible();

        // Simulate switching the active image while editing.
        act(() => {
            useAppState.getState().setActiveImage(1);
        });
        assertEditingUiVisible();

        // Leaving geometry mode keeps everything visible.
        act(() => {
            useAppState.getState().setGeometryEdit(false);
        });
        assertEditingUiVisible();

        // A stale/out-of-range activeIndex must not remove the panel.
        act(() => {
            useAppState.setState({ activeIndex: 99 });
        });
        assertEditingUiVisible();
    });

    it("switches the focused panel on mouse interaction", async () => {
        const processor = new ImageProcessor(await getBackend());
        render(<AppLayout processor={processor} />);
        act(() => {
            useAppState.getState().setFocusPanel(Panel.Filmstrip);
        });
        act(() => {
            fireEvent.pointerDown(screen.getByTestId("adjustments-panel"));
        });
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);

        act(() => {
            fireEvent.pointerDown(screen.getByTestId("filmstrip"));
        });
        expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
    });

    it("leaves geometry mode when clicking the panel or the filmstrip", async () => {
        const processor = new ImageProcessor(await getBackend());
        render(<AppLayout processor={processor} />);

        act(() => {
            useAppState.getState().setGeometryEdit(true);
        });
        expect(screen.getByTestId("geometry-overlay")).toBeTruthy();

        act(() => {
            fireEvent.pointerDown(screen.getByTestId("adjustments-panel"));
        });
        expect(useAppState.getState().geometryEdit).toBe(false);

        act(() => {
            useAppState.getState().setGeometryEdit(true);
        });
        act(() => {
            fireEvent.pointerDown(screen.getByTestId("filmstrip"));
        });
        expect(useAppState.getState().geometryEdit).toBe(false);
    });
});
