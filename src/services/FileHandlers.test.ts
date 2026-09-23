import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadImages } from "./FileHandlers";
import { ImageProcessor } from "./ImageProcessor";
import { useAppState } from "../state/appState";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import { thumbnailRegistry } from "./thumbnailRegistry";

vi.mock("./PanelManager", () => ({ setActivePanel: vi.fn() }));

function image(id: string) {
    return { id, filename: `${id}.jpg`, adjustments: structuredClone(DEFAULT_ADJUSTMENTS) };
}

function makeBackend(overrides: Record<string, unknown> = {}) {
    const backend = {
        import: vi.fn(async (paths: string[] | null) =>
            paths?.map((p, i) => ({
                id: `new-${i}`,
                filename: p.split("/").pop()!,
                adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
            })) ?? null),
        unload: vi.fn(async () => {}),
        createSession: vi.fn(async () => ({ id: 7, name: "test session", is_existing: false })),
        pickImages: vi.fn(async () => ["/a/one.jpg", "/a/two.jpg"]),
        ...overrides,
    };
    return { processor: new ImageProcessor(backend as never), backend };
}

describe("loadImages session + replace semantics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        thumbnailRegistry.clear();
        useAppState.setState({
            images: [],
            sessionId: null,
            sessions: [],
            showSessions: false,
            selectedIds: new Set(),
            loadProgress: null,
            renderedData: null,
            renderedImageId: null,
            renderedHistogram: null,
            toastMessage: "",
        });
    });

    it("creates a session when the explicit flag is true", async () => {
        const { processor, backend } = makeBackend();

        const loaded = await loadImages(["/a/one.jpg"], useAppState, processor, true, true);

        expect(loaded).toBe(1);
        expect(backend.createSession).toHaveBeenCalledWith(["/a/one.jpg"]);
        expect(useAppState.getState().sessionId).toBe(7);
        expect(useAppState.getState().toastMessage).toBe("");
    });

    it("shows toast when attaching to an existing session", async () => {
        const { processor, backend } = makeBackend({
            createSession: vi.fn(async () => ({ id: 12, name: "iceland · Sep 16", is_existing: true })),
        });

        const loaded = await loadImages(["/a/one.jpg"], useAppState, processor, true, true);

        expect(loaded).toBe(1);
        expect(backend.createSession).toHaveBeenCalledWith(["/a/one.jpg"]);
        expect(useAppState.getState().sessionId).toBe(12);
        expect(useAppState.getState().toastMessage).toBe('Attached to session "iceland · Sep 16"');
    });

    it("handles null session result (scenario mode) gracefully", async () => {
        const { processor, backend } = makeBackend({
            createSession: vi.fn(async () => null),
        });
        useAppState.setState({ sessionId: 5 });

        const loaded = await loadImages(["/a/one.jpg"], useAppState, processor, true, true);

        expect(loaded).toBe(1);
        expect(backend.createSession).toHaveBeenCalledWith(["/a/one.jpg"]);
        expect(useAppState.getState().sessionId).toBeNull();
        expect(useAppState.getState().toastMessage).toBe("");
    });

    it("does not create a session when the flag is false, even on replace", async () => {
        const { processor, backend } = makeBackend();
        useAppState.setState({ images: [image("old")], sessionId: 3 });

        await loadImages(["/a/one.jpg"], useAppState, processor, true, false);

        expect(backend.createSession).not.toHaveBeenCalled();
        expect(useAppState.getState().sessionId).toBe(3);
    });

    it("creates a session on append into an empty view (explicit true, replace false)", async () => {
        const { processor, backend } = makeBackend();

        await loadImages(["/a/one.jpg"], useAppState, processor, false, true);

        expect(backend.createSession).toHaveBeenCalledWith(["/a/one.jpg"]);
        expect(useAppState.getState().sessionId).toBe(7);
    });

    it("unloads previous images on a replace-load (cache leak fix)", async () => {
        const { processor, backend } = makeBackend();
        useAppState.setState({ images: [image("old-1"), image("old-2")] });

        await loadImages(["/a/one.jpg"], useAppState, processor, true, false);

        expect(backend.unload).toHaveBeenCalledWith(["old-1", "old-2"]);
    });

    it("does not unload anything on an append-load", async () => {
        const { processor, backend } = makeBackend();
        useAppState.setState({ images: [image("old")] });

        await loadImages(["/a/one.jpg"], useAppState, processor, false, false);

        expect(backend.unload).not.toHaveBeenCalled();
    });

    it("erases previous-session thumbnails and rendered preview on replace", async () => {
        const { processor } = makeBackend();
        thumbnailRegistry.set("old-1", {
            data: { kind: "raw", width: 4, height: 4, data: new Uint8ClampedArray(64) },
            quality: "hq",
            adjHash: 1,
        });
        useAppState.setState({
            images: [image("old-1")],
            renderedData: { kind: "raw", width: 4, height: 4, data: new Uint8ClampedArray(64) },
            renderedImageId: "old-1",
            renderedHistogram: {
                red: new Uint32Array(256),
                green: new Uint32Array(256),
                blue: new Uint32Array(256),
                luma: new Uint32Array(256),
            },
        });

        await loadImages(["/a/one.jpg"], useAppState, processor, true, false);

        expect(thumbnailRegistry.has("old-1")).toBe(false);
        expect(thumbnailRegistry.size).toBe(0);
        expect(useAppState.getState().renderedData).toBeNull();
        expect(useAppState.getState().renderedImageId).toBeNull();
        expect(useAppState.getState().renderedHistogram).toBeNull();
    });

    it("resolves dialog paths via pickImages when paths is null", async () => {
        const { processor, backend } = makeBackend();

        await loadImages(null, useAppState, processor, false, true);

        expect(backend.pickImages).toHaveBeenCalled();
        expect(backend.import).toHaveBeenCalledWith(
            ["/a/one.jpg", "/a/two.jpg"],
            expect.any(Function),
        );
        expect(backend.createSession).toHaveBeenCalledWith(["/a/one.jpg", "/a/two.jpg"]);
    });

    it("loads nothing when the dialog is cancelled", async () => {
        const { processor, backend } = makeBackend({ pickImages: vi.fn(async () => null) });

        const loaded = await loadImages(null, useAppState, processor, false, false);

        expect(loaded).toBe(0);
        expect(backend.import).not.toHaveBeenCalled();
    });

    it("loads nothing when the picker rejects", async () => {
        const { processor, backend } = makeBackend({
            pickImages: vi.fn(async () => {
                throw new Error("dialog failed");
            }),
        });

        const loaded = await loadImages(null, useAppState, processor, false, false);

        expect(loaded).toBe(0);
        expect(backend.import).not.toHaveBeenCalled();
    });
});
