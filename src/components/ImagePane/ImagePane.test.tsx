import { render, waitFor } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImagePane } from "./ImagePane.tsx";
import { useAppState } from "../../state/appState.ts";
import { thumbnailRegistry } from "../Filmstrip/Filmstrip.tsx";
import { DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";
import type { PixelData } from "../../backend/types.ts";

if (typeof globalThis.createImageBitmap === "undefined") {
    globalThis.createImageBitmap = vi.fn(async () => ({
        width: 100,
        height: 100,
        close: vi.fn(),
    } as unknown as ImageBitmap));
}

if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
}

function makePixelData(width = 10, height = 10): PixelData {
    return {
        kind: "raw",
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
    };
}

describe("ImagePane", () => {
    beforeEach(() => {
        thumbnailRegistry.clear();
        useAppState.setState({
            images: [],
            activeIndex: 0,
            renderedData: null,
            renderedImageId: null,
            renderedHistogram: null,
        });
    });

    it("renders placeholder when no image is loaded", () => {
        const { container } = render(<ImagePane />);
        expect(container.querySelector("canvas")).toBeNull();
    });

    it("renders canvas with thumbnail placeholder when preview is in flight", async () => {
        const testId = "img-placeholder-1";
        thumbnailRegistry.set(testId, { data: makePixelData(80, 60), quality: "fast", adjJson: "{}" });

        useAppState.setState({
            images: [{ id: testId, filename: "test.jpg", adjustments: DEFAULT_ADJUSTMENTS }],
            activeIndex: 0,
            renderedData: null,
            renderedImageId: null,
        });

        const { container } = render(<ImagePane />);
        await waitFor(() => {
            expect(container.querySelector("canvas")).not.toBeNull();
        });
    });

    it("renders full preview when renderedData matches active image", async () => {
        const testId = "img-full-1";
        useAppState.setState({
            images: [{ id: testId, filename: "test.jpg", adjustments: DEFAULT_ADJUSTMENTS }],
            activeIndex: 0,
            renderedData: makePixelData(2000, 1500),
            renderedImageId: testId,
        });

        const { container } = render(<ImagePane />);
        await waitFor(() => {
            expect(container.querySelector("canvas")).not.toBeNull();
        });
    });
});
