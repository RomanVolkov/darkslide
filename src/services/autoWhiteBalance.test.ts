import { beforeEach, describe, expect, it, vi } from "vitest";

const autoWhiteBalance = vi.fn();
vi.mock("../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({ autoWhiteBalance })),
}));

import { useAppState } from "../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { applyAutoWhiteBalance } from "./autoWhiteBalance.ts";

describe("applyAutoWhiteBalance", () => {
    beforeEach(() => {
        autoWhiteBalance.mockReset();
        useAppState.setState({
            images: [{ id: "img-1", filename: "img-1.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) }],
            activeIndex: 0,
        });
    });

    it("writes the estimated temperature/tint into the image adjustments", async () => {
        autoWhiteBalance.mockResolvedValue({ temperature: 25, tint: -10 });

        const result = await applyAutoWhiteBalance("img-1");

        expect(autoWhiteBalance.mock.calls[0]?.[0]).toBe("img-1");
        expect(result).toEqual({ temperature: 25, tint: -10 });

        const adj = useAppState.getState().images[0]?.adjustments;
        expect(adj?.color.temperature).toBe(25);
        expect(adj?.color.tint).toBe(-10);
    });

    it("leaves other adjustments untouched", async () => {
        autoWhiteBalance.mockResolvedValue({ temperature: -30, tint: 0 });

        await applyAutoWhiteBalance("img-1");

        const adj = useAppState.getState().images[0]?.adjustments;
        expect(adj?.light.exposure).toBe(0);
        expect(adj?.hsl.saturation).toBe(0);
    });
});
