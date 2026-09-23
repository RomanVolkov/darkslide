import { beforeEach, describe, expect, it } from "vitest";
import { useAppState } from "./appState.ts";
import type { PixelData } from "../backend/types.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { thumbnailRegistry } from "../services/thumbnailRegistry.ts";

function pixelData(): PixelData {
    return { kind: "raw", width: 1, height: 1, data: new Uint8ClampedArray(4) };
}

function image(id: string) {
    return { id, filename: `${id}.jpg`, adjustments: structuredClone(DEFAULT_ADJUSTMENTS) };
}

describe("renderSeq", () => {
    beforeEach(() => {
        useAppState.setState({ renderSeq: 0 });
    });

    it("increments when a preview render completes", () => {
        const before = useAppState.getState().renderSeq;
        useAppState.getState().setRenderedPreview(pixelData(), null, "a");
        expect(useAppState.getState().renderSeq).toBe(before + 1);
    });

    it("does not increment when the preview is cleared", () => {
        const before = useAppState.getState().renderSeq;
        useAppState.getState().setRenderedPreview(null, null);
        expect(useAppState.getState().renderSeq).toBe(before);
    });
});

describe("session slice", () => {
    beforeEach(() => {
        useAppState.setState({
            images: [],
            selectedIds: new Set(),
            activeIndex: 0,
            sessionId: null,
            sessions: [],
            showSessions: false,
        });
    });

    it("sets and clears the active session", () => {
        useAppState.getState().setSession(3);
        expect(useAppState.getState().sessionId).toBe(3);
        useAppState.getState().setSession(null);
        expect(useAppState.getState().sessionId).toBeNull();
    });

    it("stores session summaries and toggles the palette flag", () => {
        const sessions = [{ id: 1, name: "a", image_count: 2, updated_at: "t" }];
        useAppState.getState().setSessions(sessions);
        expect(useAppState.getState().sessions).toEqual(sessions);
        useAppState.getState().setShowSessions(true);
        expect(useAppState.getState().showSessions).toBe(true);
    });

    it("selectAll selects every loaded image", () => {
        useAppState.setState({ images: [image("a"), image("b")], selectedIds: new Set() });
        useAppState.getState().selectAll();
        expect([...useAppState.getState().selectedIds].sort()).toEqual(["a", "b"]);
    });

    it("clears sessionId when the last image is deleted", () => {
        useAppState.setState({ sessionId: 9, images: [image("a")], selectedIds: new Set(["a"]) });
        useAppState.getState().deleteImages(new Set(["a"]));
        expect(useAppState.getState().sessionId).toBeNull();
    });

    it("drops thumbnails for deleted images only", () => {
        const data = { kind: "raw" as const, width: 1, height: 1, data: new Uint8ClampedArray(4) };
        thumbnailRegistry.clear();
        thumbnailRegistry.set("a", { data, quality: "hq" });
        thumbnailRegistry.set("b", { data, quality: "hq" });
        useAppState.setState({ images: [image("a"), image("b")], selectedIds: new Set() });

        useAppState.getState().deleteImages(new Set(["a"]));

        expect(thumbnailRegistry.has("a")).toBe(false);
        expect(thumbnailRegistry.has("b")).toBe(true);
    });
});
