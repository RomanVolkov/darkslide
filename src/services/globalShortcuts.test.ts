import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGlobalShortcuts } from "./globalShortcuts.ts";
import { keyboardManager, RegistrationID } from "./KeyboardManager.ts";
import { useAppState } from "../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { thumbnailRegistry } from "./thumbnailRegistry.ts";
import { initHistory, resetHistoryForTests } from "./undoHistory.ts";
import { ActionService } from "./ActionService.ts";
import { filmstripHistory } from "./filmstripHistory.ts";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async () => {}),
}));

import { invoke } from "@tauri-apps/api/core";

function makeKeydown(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", { key, bubbles: true, ...overrides });
}

function makeKeyup(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent("keyup", { key, bubbles: true, ...overrides });
}

describe("globalShortcuts erase all adjustments", () => {
    let unregister: (() => void) | null = null;
    const mockProcessor = {
        backend: {
            unload: vi.fn(async () => {}),
        },
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
        useAppState.setState({
            showEraseConfirm: false,
            images: [
                {
                    id: "img-1",
                    filename: "test.jpg",
                    adjustments: {
                        ...DEFAULT_ADJUSTMENTS,
                        light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 50 },
                    },
                },
            ],
        });
        unregister = registerGlobalShortcuts(mockProcessor);
        keyboardManager.setActive(RegistrationID.global);
    });

    afterEach(() => {
        if (unregister) unregister();
    });

    it("opens erase confirmation modal on Shift+Cmd+Option+X", () => {
        expect(useAppState.getState().showEraseConfirm).toBe(false);

        const evt = makeKeydown("X", {
            code: "KeyX",
            shiftKey: true,
            metaKey: true,
            altKey: true,
        });
        keyboardManager.dispatch(evt);

        expect(useAppState.getState().showEraseConfirm).toBe(true);
    });

    it("closes erase confirmation modal on Escape", () => {
        useAppState.setState({ showEraseConfirm: true });

        const evt = makeKeydown("Escape");
        keyboardManager.dispatch(evt);

        expect(useAppState.getState().showEraseConfirm).toBe(false);
    });

    it("eraseAllAdjustments calls clear_all_adjustments and resets adjustments", async () => {
        thumbnailRegistry.set("img-1", {
            data: { kind: "raw", width: 10, height: 10, data: new Uint8ClampedArray(400) },
            quality: "hq",
            adjHash: 123,
        });

        await useAppState.getState().eraseAllAdjustments();

        expect(invoke).toHaveBeenCalledWith("clear_all_adjustments");
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
        expect(thumbnailRegistry.has("img-1")).toBe(false);
        expect(useAppState.getState().toastMessage).toBe("All adjustments erased from database");
    });

    it("passes the active session id to unload when deleting images and finalized", async () => {
        useAppState.setState({
            sessionId: 42,
            selectedIds: new Set(["img-1"]),
            images: [
                {
                    id: "img-1",
                    filename: "test.jpg",
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                },
            ],
            activeIndex: 0,
        });

        keyboardManager.dispatch(makeKeydown("d"));
        await Promise.resolve();

        expect(useAppState.getState().images.length).toBe(0);
        expect(mockProcessor.backend.unload).not.toHaveBeenCalled();

        await filmstripHistory.clear(true);
        expect(mockProcessor.backend.unload).toHaveBeenCalledWith(["img-1"], 42);
    });

    it("toggles grid view on f without blinking or double-firing", () => {
        expect(useAppState.getState().filmstripView).toBe("strip");

        keyboardManager.dispatch(makeKeydown("f"));
        expect(useAppState.getState().filmstripView).toBe("grid");

        // Simultaneous duplicate dispatch (e.g. from Tauri menu accelerator)
        keyboardManager.dispatch(makeKeydown("f"));
        expect(useAppState.getState().filmstripView).toBe("grid");

        // Next user action after debounce period toggles it back
        ActionService.resetDeduplicationForTests();
        keyboardManager.dispatch(makeKeydown("f"));
        expect(useAppState.getState().filmstripView).toBe("strip");
    });
});

describe("globalShortcuts undo/redo", () => {
    let unregister: (() => void) | null = null;
    let uninitHistory: (() => void) | null = null;
    const mockProcessor = {
        backend: {
            unload: vi.fn(async () => {}),
        },
    } as any;

    function exposure(): number {
        return useAppState.getState().images[0]!.adjustments.light.exposure;
    }

    function editExposure(v: number): void {
        useAppState.getState().updateImage("img-1", (img) => {
            img.adjustments = { ...img.adjustments, light: { ...img.adjustments.light, exposure: v } };
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
        resetHistoryForTests();
        useAppState.setState({
            images: [
                {
                    id: "img-1",
                    filename: "test.jpg",
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                },
            ],
            activeIndex: 0,
            selectedIds: new Set(["img-1"]),
        });
        uninitHistory = initHistory(useAppState);
        unregister = registerGlobalShortcuts(mockProcessor);
        keyboardManager.setActive(RegistrationID.global);
    });

    afterEach(() => {
        if (unregister) unregister();
        if (uninitHistory) uninitHistory();
    });

    it("u undoes the last edit", () => {
        editExposure(30);
        keyboardManager.dispatch(makeKeydown("u"));
        expect(exposure()).toBe(0);
    });

    it("r redoes the undone edit", () => {
        editExposure(30);
        keyboardManager.dispatch(makeKeydown("u"));
        keyboardManager.dispatch(makeKeydown("r"));
        expect(exposure()).toBe(30);
    });

    it("Cmd+Z undoes", () => {
        editExposure(30);
        keyboardManager.dispatch(makeKeydown("z", { metaKey: true }));
        expect(exposure()).toBe(0);
    });

    it("Cmd+Shift+Z redoes", () => {
        editExposure(30);
        keyboardManager.dispatch(makeKeydown("z", { metaKey: true }));
        keyboardManager.dispatch(makeKeydown("Z", { metaKey: true, shiftKey: true }));
        expect(exposure()).toBe(30);
    });

    it("does nothing when no images are loaded", () => {
        useAppState.setState({ images: [], activeIndex: 0, selectedIds: new Set() });
        expect(() => {
            keyboardManager.dispatch(makeKeydown("u"));
            keyboardManager.dispatch(makeKeydown("r"));
            keyboardManager.dispatch(makeKeydown("z", { metaKey: true }));
            keyboardManager.dispatch(makeKeydown("Z", { metaKey: true, shiftKey: true }));
        }).not.toThrow();
    });

    it("modal keyboard priority: typing u/r/z in modal does not trigger undo/redo", () => {
        editExposure(30);
        // Simulate a modal registering with override_global = true
        keyboardManager.register(RegistrationID.session, () => false, true);
        keyboardManager.setActive(RegistrationID.session);

        keyboardManager.dispatch(makeKeydown("u"));
        expect(exposure()).toBe(30);

        keyboardManager.dispatch(makeKeydown("z", { metaKey: true }));
        expect(exposure()).toBe(30);

        keyboardManager.dispatch(makeKeydown("r"));
        expect(exposure()).toBe(30);

        keyboardManager.unregister(RegistrationID.session);
    });
});

describe("globalShortcuts compare with original hold-to-show", () => {
    let unregister: (() => void) | null = null;
    const mockProcessor = {
        backend: {
            unload: vi.fn(async () => {}),
        },
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
        useAppState.setState({
            showOriginal: false,
            images: [
                {
                    id: "img-1",
                    filename: "test.jpg",
                    adjustments: {
                        ...DEFAULT_ADJUSTMENTS,
                        light: { ...DEFAULT_ADJUSTMENTS.light, exposure: 50 },
                    },
                },
            ],
        });
        unregister = registerGlobalShortcuts(mockProcessor);
        keyboardManager.setActive(RegistrationID.global);
    });

    afterEach(() => {
        if (unregister) unregister();
    });

    it("shows original on backslash keydown and restores on keyup", () => {
        expect(useAppState.getState().showOriginal).toBe(false);

        keyboardManager.dispatch(makeKeydown("\\"));
        expect(useAppState.getState().showOriginal).toBe(true);

        keyboardManager.dispatch(makeKeyup("\\"));
        expect(useAppState.getState().showOriginal).toBe(false);
    });

    it("does not blink or toggle when backslash keydown repeats while held", () => {
        expect(useAppState.getState().showOriginal).toBe(false);

        // Initial keydown
        keyboardManager.dispatch(makeKeydown("\\", { repeat: false }));
        expect(useAppState.getState().showOriginal).toBe(true);

        // Simulated OS key repeat events while holding
        for (let i = 0; i < 5; i++) {
            keyboardManager.dispatch(makeKeydown("\\", { repeat: true }));
            expect(useAppState.getState().showOriginal).toBe(true);
        }

        // Release
        keyboardManager.dispatch(makeKeyup("\\"));
        expect(useAppState.getState().showOriginal).toBe(false);
    });

    it("does not show original if images list is empty", () => {
        useAppState.setState({ images: [], showOriginal: false });

        keyboardManager.dispatch(makeKeydown("\\"));
        expect(useAppState.getState().showOriginal).toBe(false);
    });
});

