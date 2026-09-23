import { render, act } from "@testing-library/preact";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const {
    getMenuActionCallback,
    setMenuActionCallback,
    mockInvoke,
    mockLoadImages,
    mockOpenPalette,
    mockAutoWhiteBalance,
    mockUnload,
} = vi.hoisted(() => {
    let cb: ((event: { payload: string }) => void) | null = null;
    return {
        getMenuActionCallback: () => cb,
        setMenuActionCallback: (c: any) => { cb = c; },
        mockInvoke: vi.fn(async () => []),
        mockLoadImages: vi.fn(async () => {}),
        mockOpenPalette: vi.fn(),
        mockAutoWhiteBalance: vi.fn(async () => ({ temperature: 10, tint: -5 })),
        mockUnload: vi.fn(async () => {}),
    };
});

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (eventName: string, cb: any) => {
        if (eventName === "menu-action") {
            setMenuActionCallback(cb);
        }
        return vi.fn();
    }),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: vi.fn(() => ({ setTitle: vi.fn() })),
}));

vi.mock("../services/FileHandlers.ts", () => ({
    loadImages: mockLoadImages,
}));

vi.mock("../services/SessionService.ts", () => ({
    openPalette: mockOpenPalette,
}));

vi.mock("../services/autoWhiteBalance.ts", () => ({
    applyAutoWhiteBalance: mockAutoWhiteBalance,
}));

vi.mock("../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({
        renderPreview: vi.fn(),
        renderThumbnail: vi.fn(),
        renderThumbnails: vi.fn(async () => []),
        autoWhiteBalance: mockAutoWhiteBalance,
        import: vi.fn(async () => null),
        export: vi.fn(async () => {}),
        unload: mockUnload,
        clearAllAdjustments: vi.fn(async () => {}),
    })),
}));

if (typeof globalThis.createImageBitmap === "undefined") {
    globalThis.createImageBitmap = vi.fn(async () => ({
        width: 10,
        height: 10,
        close: vi.fn(),
    } as unknown as ImageBitmap));
}

import { AppEffects } from "../effects/AppEffects.tsx";
import { getBackend } from "../backend/index.ts";
import { ImageProcessor } from "../services/ImageProcessor.ts";
import { useAppState } from "../state/appState.ts";
import { ActionService, CommandId } from "../services/ActionService.ts";
import { keyboardManager, RegistrationID } from "../services/KeyboardManager.ts";
import { Panel } from "../components/constants/index.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { resetHistoryForTests, sealBurst, historyDepth } from "../services/undoHistory.ts";
import { filmstripHistory } from "../services/filmstripHistory.ts";

describe("Shortcut and Menu Action Parity Test Suite", () => {
    let processor: ImageProcessor;
    let unmountFn: (() => void) | null = null;

    beforeEach(async () => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
        resetHistoryForTests();
        filmstripHistory.resetForTests();

        useAppState.setState({
            images: [
                {
                    id: "img-1",
                    filename: "photo1.jpg",
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                },
                {
                    id: "img-2",
                    filename: "photo2.jpg",
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                },
            ],
            activeIndex: 0,
            selectedIds: new Set<string>(),
            filmstripView: "strip",
            showExport: false,
            showSessions: false,
            showKeymap: false,
            showEraseConfirm: false,
            showOriginal: false,
            toastMessage: "",
            sessionId: null,
            sessions: [],
        });

        processor = new ImageProcessor(await getBackend());
        const { unmount } = render(<AppEffects processor={processor} />);
        unmountFn = unmount;
        keyboardManager.setActive(RegistrationID.global);
    });

    afterEach(() => {
        if (unmountFn) {
            unmountFn();
            unmountFn = null;
        }
        document.body.innerHTML = "";
    });

    function dispatchKey(key: string, overrides: Partial<KeyboardEventInit> = {}) {
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...overrides }));
        });
    }

    function dispatchKeyUp(key: string, overrides: Partial<KeyboardEventInit> = {}) {
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, ...overrides }));
        });
    }

    function dispatchMenu(action: CommandId | string) {
        const cb = getMenuActionCallback();
        if (!cb) throw new Error("menu-action callback is not registered");
        act(() => {
            cb({ payload: action });
        });
    }

    function dispatchDual(key: string, keyOverrides: Partial<KeyboardEventInit>, menuAction: CommandId | string) {
        // Simulates rapid dual dispatch (DOM keydown followed immediately by native menu accelerator)
        dispatchKey(key, keyOverrides);
        dispatchMenu(menuAction);
    }

    // =========================================================================
    // Suite 1: Single Keypress Parity (Keyboard Only)
    // =========================================================================
    describe("Suite 1: Single Keypress Actions", () => {
        it("'f' toggles grid view once", () => {
            expect(useAppState.getState().filmstripView).toBe("strip");
            dispatchKey("f");
            expect(useAppState.getState().filmstripView).toBe("grid");

            ActionService.resetDeduplicationForTests();
            dispatchKey("f");
            expect(useAppState.getState().filmstripView).toBe("strip");
        });

        it("'u' undos adjustment exactly once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            expect(historyDepth("img-1")?.undo).toBe(2);

            dispatchKey("u");
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);
            expect(historyDepth("img-1")?.undo).toBe(1);
        });

        it("'Cmd+Z' undos adjustment exactly once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });

            dispatchKey("z", { metaKey: true });
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);
            expect(historyDepth("img-1")?.undo).toBe(1);
        });

        it("'r' redoes adjustment exactly once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            useAppState.getState().undoAdjustment();
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);

            dispatchKey("r");
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(20);
            expect(historyDepth("img-1")?.redo).toBe(0);
        });

        it("'Shift+Cmd+Z' redoes adjustment exactly once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            useAppState.getState().undoAdjustment();

            dispatchKey("Z", { metaKey: true, shiftKey: true });
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(20);
        });

        it("'Shift+R' rotates active image clockwise by 90 degrees once", () => {
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(0);
            dispatchKey("R", { shiftKey: true });
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(90);
        });

        it("'o' opens images dialog once", () => {
            dispatchKey("o");
            expect(mockLoadImages).toHaveBeenCalledTimes(1);
            expect(mockLoadImages).toHaveBeenCalledWith(null, expect.anything(), processor, false, false);
        });

        it("'Shift+O' opens images replace dialog once", () => {
            dispatchKey("O", { shiftKey: true });
            expect(mockLoadImages).toHaveBeenCalledTimes(1);
            expect(mockLoadImages).toHaveBeenCalledWith(null, expect.anything(), processor, true, true);
        });

        it("'s' opens sessions palette once", () => {
            dispatchKey("s");
            expect(mockOpenPalette).toHaveBeenCalledTimes(1);
        });

        it("'e' opens export modal once", () => {
            expect(useAppState.getState().showExport).toBe(false);
            dispatchKey("e");
            expect(useAppState.getState().showExport).toBe(true);
        });

        it("'y' copies adjustments and shows 'yanked' toast once", () => {
            dispatchKey("y");
            expect(useAppState.getState().toastMessage).toBe("yanked");
        });

        it("'Cmd+C' copies adjustments once", () => {
            dispatchKey("c", { metaKey: true });
            expect(useAppState.getState().toastMessage).toBe("yanked");
        });

        it("'p' pastes adjustments and shows 'pasted' toast once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 35;
            });
            ActionService.copyAdjustments();
            useAppState.setState({ activeIndex: 1 });

            dispatchKey("p");
            expect(useAppState.getState().images[1]!.adjustments.light.exposure).toBe(35);
            expect(useAppState.getState().toastMessage).toBe("pasted");
        });

        it("'Cmd+V' pastes adjustments once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 35;
            });
            ActionService.copyAdjustments();
            useAppState.setState({ activeIndex: 1 });

            dispatchKey("v", { metaKey: true });
            expect(useAppState.getState().images[1]!.adjustments.light.exposure).toBe(35);
            expect(useAppState.getState().toastMessage).toBe("pasted");
        });

        it("'Shift+X' resets adjustments on active image once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 50;
            });
            dispatchKey("X", { shiftKey: true });
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
            expect(useAppState.getState().toastMessage).toBe("reset all");
        });

        it("'w' triggers auto white balance once", () => {
            dispatchKey("w");
            expect(mockAutoWhiteBalance).toHaveBeenCalledTimes(1);
            expect(mockAutoWhiteBalance).toHaveBeenCalledWith("img-1");
        });

        it("'d' deletes active image once", async () => {
            expect(useAppState.getState().images.length).toBe(2);
            dispatchKey("d");
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");
            expect(mockUnload).not.toHaveBeenCalled();

            await filmstripHistory.clear(true);
            expect(mockUnload).toHaveBeenCalledWith(["img-1"], null);
        });

        it("'Backspace' deletes active image once", async () => {
            expect(useAppState.getState().images.length).toBe(2);
            dispatchKey("Backspace");
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");
            expect(mockUnload).not.toHaveBeenCalled();

            await filmstripHistory.clear(true);
            expect(mockUnload).toHaveBeenCalledWith(["img-1"], null);
        });

        it("'?' toggles help modal once", () => {
            expect(useAppState.getState().showKeymap).toBe(false);
            dispatchKey("?");
            expect(useAppState.getState().showKeymap).toBe(true);

            ActionService.resetDeduplicationForTests();
            dispatchKey("?");
            expect(useAppState.getState().showKeymap).toBe(false);
        });

        it("'Shift+Cmd+Option+X' opens erase db confirmation modal once", () => {
            expect(useAppState.getState().showEraseConfirm).toBe(false);
            dispatchKey("X", { shiftKey: true, metaKey: true, altKey: true, code: "KeyX" });
            expect(useAppState.getState().showEraseConfirm).toBe(true);
        });

        it("'Escape' closes open modals", () => {
            useAppState.setState({ showExport: true });
            dispatchKey("Escape");
            expect(useAppState.getState().showExport).toBe(false);

            useAppState.setState({ showKeymap: true });
            dispatchKey("Escape");
            expect(useAppState.getState().showKeymap).toBe(false);

            useAppState.setState({ showEraseConfirm: true });
            dispatchKey("Escape");
            expect(useAppState.getState().showEraseConfirm).toBe(false);

            useAppState.setState({ showSessions: true });
            dispatchKey("Escape");
            expect(useAppState.getState().showSessions).toBe(false);
        });
    });

    // =========================================================================
    // Suite 2: Menu Event Parity (Tauri Native Menu Actions)
    // =========================================================================
    describe("Suite 2: Menu Event Actions", () => {
        it("'view_grid' menu action toggles grid view once", () => {
            expect(useAppState.getState().filmstripView).toBe("strip");
            dispatchMenu("view_grid");
            expect(useAppState.getState().filmstripView).toBe("grid");

            ActionService.resetDeduplicationForTests();
            dispatchMenu("view_grid");
            expect(useAppState.getState().filmstripView).toBe("strip");
        });

        it("'edit_undo' menu action undos once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });

            dispatchMenu("edit_undo");
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);
            expect(historyDepth("img-1")?.undo).toBe(1);
        });

        it("'edit_redo' menu action redoes once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            useAppState.getState().undoAdjustment();

            dispatchMenu("edit_redo");
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(20);
        });

        it("'image_rotate' menu action rotates image once", () => {
            dispatchMenu("image_rotate");
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(90);
        });

        it("'file_open' menu action opens file dialog once", () => {
            dispatchMenu("file_open");
            expect(mockLoadImages).toHaveBeenCalledTimes(1);
            expect(mockLoadImages).toHaveBeenCalledWith(null, expect.anything(), processor, false, false);
        });

        it("'file_open_replace' menu action opens replace file dialog once", () => {
            dispatchMenu("file_open_replace");
            expect(mockLoadImages).toHaveBeenCalledTimes(1);
            expect(mockLoadImages).toHaveBeenCalledWith(null, expect.anything(), processor, true, true);
        });

        it("'session_palette' menu action opens session palette once", () => {
            dispatchMenu("session_palette");
            expect(mockOpenPalette).toHaveBeenCalledTimes(1);
        });

        it("'file_export' menu action opens export modal once", () => {
            dispatchMenu("file_export");
            expect(useAppState.getState().showExport).toBe(true);
        });

        it("'adjustments_yank' menu action copies adjustments once", () => {
            dispatchMenu("adjustments_yank");
            expect(useAppState.getState().toastMessage).toBe("yanked");
        });

        it("'adjustments_paste' menu action pastes adjustments once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 42;
            });
            ActionService.copyAdjustments();
            useAppState.setState({ activeIndex: 1 });

            dispatchMenu("adjustments_paste");
            expect(useAppState.getState().images[1]!.adjustments.light.exposure).toBe(42);
        });

        it("'adjustments_reset' menu action resets adjustments once", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 42;
            });
            dispatchMenu("adjustments_reset");
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
            expect(useAppState.getState().toastMessage).toBe("reset all");
        });

        it("'image_auto_wb' menu action triggers auto white balance once", () => {
            dispatchMenu("image_auto_wb");
            expect(mockAutoWhiteBalance).toHaveBeenCalledTimes(1);
            expect(mockAutoWhiteBalance).toHaveBeenCalledWith("img-1");
        });

        it("'filmstrip_delete' menu action deletes active image once", async () => {
            dispatchMenu("filmstrip_delete");
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");
            expect(mockUnload).not.toHaveBeenCalled();

            await filmstripHistory.clear(true);
            expect(mockUnload).toHaveBeenCalledWith(["img-1"], null);
        });

        it("'help_toggle' menu action toggles help modal once", () => {
            dispatchMenu("help_toggle");
            expect(useAppState.getState().showKeymap).toBe(true);
        });

        it("'edit_erase_db' menu action opens erase db confirmation once", () => {
            dispatchMenu("edit_erase_db");
            expect(useAppState.getState().showEraseConfirm).toBe(true);
        });
    });

    // =========================================================================
    // Suite 3: Dual-Dispatch Race Parity (DOM keydown + Menu accelerator within 100ms)
    // =========================================================================
    describe("Suite 3: Simultaneous Dual-Dispatch Race Deduplication", () => {
        it("'f' keydown + 'view_grid' menu action does NOT blink back to strip", () => {
            expect(useAppState.getState().filmstripView).toBe("strip");
            // Simultaneous dispatch: DOM keydown followed immediately by menu-action
            dispatchDual("f", {}, "view_grid");
            // Stays in grid view; second event is dropped by deduplication
            expect(useAppState.getState().filmstripView).toBe("grid");
        });

        it("'u' keydown + 'edit_undo' menu action undoes only 1 step, NOT 2", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            expect(historyDepth("img-1")?.undo).toBe(2);

            dispatchDual("u", {}, "edit_undo");
            // Exactly 1 step undone (exposure becomes 10, not 0)
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);
            expect(historyDepth("img-1")?.undo).toBe(1);
        });

        it("'r' keydown + 'edit_redo' menu action redoes only 1 step, NOT 2", () => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 10;
            });
            sealBurst("img-1");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            useAppState.getState().undoAdjustment();
            useAppState.getState().undoAdjustment();
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);

            dispatchDual("r", {}, "edit_redo");
            // Exactly 1 step redone (exposure becomes 10, not 20)
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(10);
        });

        it("'Shift+R' keydown + 'image_rotate' menu action rotates 90 degrees, NOT 180 degrees", () => {
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(0);
            dispatchDual("R", { shiftKey: true }, "image_rotate");
            // Rotated only 90 degrees, not 180 degrees
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(90);
        });

        it("'Shift+X' keydown + 'adjustments_reset' menu action resets only once", () => {
            const spy = vi.spyOn(ActionService, "resetAdjustments");
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 50;
            });
            dispatchDual("X", { shiftKey: true }, "adjustments_reset");
            expect(spy).toHaveBeenCalledTimes(1);
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
            spy.mockRestore();
        });

        it("'w' keydown + 'image_auto_wb' menu action calls auto WB only once", () => {
            dispatchDual("w", {}, "image_auto_wb");
            expect(mockAutoWhiteBalance).toHaveBeenCalledTimes(1);
        });

        it("'d' keydown + 'filmstrip_delete' menu action deletes only 1 image, NOT 2", async () => {
            expect(useAppState.getState().images.length).toBe(2);
            dispatchDual("d", {}, "filmstrip_delete");
            // Only 1 image deleted
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");

            await filmstripHistory.clear(true);
            expect(mockUnload).toHaveBeenCalledTimes(1);
        });

        it("'Backspace' keydown + 'filmstrip_delete' menu action deletes only 1 image, NOT 2", async () => {
            expect(useAppState.getState().images.length).toBe(2);
            dispatchDual("Backspace", {}, "filmstrip_delete");
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");

            await filmstripHistory.clear(true);
            expect(mockUnload).toHaveBeenCalledTimes(1);
        });

        it("'s' keydown + 'session_palette' menu action calls openSessions only once", () => {
            dispatchDual("s", {}, "session_palette");
            expect(mockOpenPalette).toHaveBeenCalledTimes(1);
        });

        it("'e' keydown + 'file_export' menu action opens export modal only once", () => {
            const spy = vi.spyOn(ActionService, "openExport");
            dispatchDual("e", {}, "file_export");
            expect(spy).toHaveBeenCalledTimes(1);
            expect(useAppState.getState().showExport).toBe(true);
            spy.mockRestore();
        });

        it("'?' keydown + 'help_toggle' menu action stays open, does NOT toggle back closed", () => {
            expect(useAppState.getState().showKeymap).toBe(false);
            dispatchDual("?", {}, "help_toggle");
            // Stays open; does not toggle open then immediately closed!
            expect(useAppState.getState().showKeymap).toBe(true);
        });
    });

    // =========================================================================
    // Suite 4: Text Input Protection
    // =========================================================================
    describe("Suite 4: Text Input Focus Protection", () => {
        let inputEl: HTMLInputElement;

        beforeEach(() => {
            inputEl = document.createElement("input");
            inputEl.type = "text";
            document.body.appendChild(inputEl);
            inputEl.focus();
        });

        afterEach(() => {
            inputEl.remove();
        });

        it("typing 'f', 'u', 'r', 'd', 'Backspace', 'w' in text input does NOT trigger shortcuts", () => {
            // Typing 'f' does not toggle grid
            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
            });
            expect(useAppState.getState().filmstripView).toBe("strip");

            // Typing 'u' does not undo
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 20;
            });
            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
            });
            expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(20);

            // Typing 'd' or 'Backspace' does not delete images
            expect(useAppState.getState().images.length).toBe(2);
            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
            });
            expect(useAppState.getState().images.length).toBe(2);

            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
            });
            expect(useAppState.getState().images.length).toBe(2);

            // Typing 'w' does not trigger auto WB
            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true }));
            });
            expect(mockAutoWhiteBalance).not.toHaveBeenCalled();
        });

        it("menu actions with bare accelerators are blocked while typing in text input", () => {
            dispatchMenu("view_grid");
            expect(useAppState.getState().filmstripView).toBe("strip");

            dispatchMenu("filmstrip_delete");
            expect(useAppState.getState().images.length).toBe(2);

            dispatchMenu("image_rotate");
            expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(0);

            dispatchMenu("image_auto_wb");
            expect(mockAutoWhiteBalance).not.toHaveBeenCalled();
        });

        it("exempt menu actions (like file_open, session_palette) still work while typing in text input", () => {
            dispatchMenu("file_open");
            expect(mockLoadImages).toHaveBeenCalledTimes(1);

            dispatchMenu("session_palette");
            expect(mockOpenPalette).toHaveBeenCalledTimes(1);
        });

        it("'Escape' key in text input still closes open modals", () => {
            useAppState.setState({ showExport: true });
            act(() => {
                inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            });
            expect(useAppState.getState().showExport).toBe(false);
        });
    });

    // =========================================================================
    // Suite 5: Compare with Original ('\') Hold-to-Show Parity
    // =========================================================================
    describe("Suite 5: 'Compare with Original' (\\) Hold-to-Show Parity", () => {
        it("presses '\\' to show original and releases to restore", () => {
            expect(useAppState.getState().showOriginal).toBe(false);

            // Keydown shows original
            dispatchKey("\\");
            expect(useAppState.getState().showOriginal).toBe(true);

            // Keyup restores adjusted
            dispatchKeyUp("\\");
            expect(useAppState.getState().showOriginal).toBe(false);
        });

        it("holding '\\' with repeat events does NOT blink or toggle off", () => {
            expect(useAppState.getState().showOriginal).toBe(false);

            // Initial keydown
            dispatchKey("\\");
            expect(useAppState.getState().showOriginal).toBe(true);

            // OS key repeats while holding down the key
            dispatchKey("\\", { repeat: true });
            expect(useAppState.getState().showOriginal).toBe(true);

            dispatchKey("\\", { repeat: true });
            expect(useAppState.getState().showOriginal).toBe(true);

            // Release restores
            dispatchKeyUp("\\");
            expect(useAppState.getState().showOriginal).toBe(false);
        });

        it("window blur while holding '\\' restores adjusted view", () => {
            dispatchKey("\\");
            expect(useAppState.getState().showOriginal).toBe(true);

            act(() => {
                window.dispatchEvent(new FocusEvent("blur"));
            });
            expect(useAppState.getState().showOriginal).toBe(false);
        });

        it("native menu 'view_original' toggles showOriginal", () => {
            expect(useAppState.getState().showOriginal).toBe(false);

            dispatchMenu("view_original");
            expect(useAppState.getState().showOriginal).toBe(true);

            ActionService.resetDeduplicationForTests();
            dispatchMenu("view_original");
            expect(useAppState.getState().showOriginal).toBe(false);
        });
    });

    // =========================================================================
    // Suite 6: Select All (Cmd+A) and Web Selection Prevention Parity
    // =========================================================================
    describe("Suite 6: Select All (Cmd+A) and Parity", () => {
        it("'Cmd+A' keyboard shortcut selects all images and focuses filmstrip", () => {
            // Initially only img-1 is selected
            useAppState.setState({ selectedIds: new Set(["img-1"]), focusPanel: Panel.Adjustments });
            expect(useAppState.getState().selectedIds.size).toBe(1);

            dispatchKey("a", { metaKey: true });

            expect(useAppState.getState().selectedIds.size).toBe(2);
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
            expect(useAppState.getState().selectedIds.has("img-2")).toBe(true);
            expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
        });

        it("'Cmd+A' in fullscreen grid view selects all images", () => {
            useAppState.setState({
                filmstripView: "grid",
                selectedIds: new Set(["img-1"]),
                focusPanel: Panel.Filmstrip,
            });
            keyboardManager.setActive(RegistrationID.filmstrip);

            dispatchKey("a", { metaKey: true });

            expect(useAppState.getState().selectedIds.size).toBe(2);
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
            expect(useAppState.getState().selectedIds.has("img-2")).toBe(true);
        });

        it("menu action 'edit_select_all' selects all images", () => {
            useAppState.setState({ selectedIds: new Set(["img-1"]) });

            dispatchMenu(CommandId.EditSelectAll);

            expect(useAppState.getState().selectedIds.size).toBe(2);
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
            expect(useAppState.getState().selectedIds.has("img-2")).toBe(true);
        });

        it("rapid dual-dispatch of Cmd+A and menu action deduplicates cleanly", () => {
            useAppState.setState({ selectedIds: new Set(["img-1"]) });
            const selectAllSpy = vi.spyOn(ActionService, "selectAll");

            dispatchKey("a", { metaKey: true });
            dispatchMenu(CommandId.EditSelectAll);

            expect(selectAllSpy).toHaveBeenCalledTimes(1);
            selectAllSpy.mockRestore();
        });

        it("does NOT select images when typing inside a text input with Cmd+A", () => {
            useAppState.setState({ selectedIds: new Set(["img-1"]) });
            const input = document.createElement("input");
            input.type = "text";
            document.body.appendChild(input);
            input.focus();

            const evt = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true });
            act(() => {
                input.dispatchEvent(evt);
            });

            // e.preventDefault was NOT called for text target
            expect(evt.defaultPrevented).toBe(false);
            // Selected images remain unchanged
            expect(useAppState.getState().selectedIds.size).toBe(1);

            document.body.removeChild(input);
        });

        it("calls .select() on focused text input when edit_select_all menu action occurs", () => {
            useAppState.setState({ selectedIds: new Set(["img-1"]) });
            const input = document.createElement("input");
            input.type = "text";
            document.body.appendChild(input);
            input.focus();

            const selectSpy = vi.spyOn(input, "select");

            dispatchMenu(CommandId.EditSelectAll);

            expect(selectSpy).toHaveBeenCalledTimes(1);
            expect(useAppState.getState().selectedIds.size).toBe(1);

            document.body.removeChild(input);
        });

        it("does not select images when modal dialog is open", () => {
            useAppState.setState({ selectedIds: new Set(["img-1"]), showExport: true });

            dispatchKey("a", { metaKey: true });

            // Image selection untouched
            expect(useAppState.getState().selectedIds.size).toBe(1);
        });
    });

    describe("Filmstrip deletion undo/redo parity", () => {
        it("'u' key restores removed image when focused on filmstrip", async () => {
            useAppState.setState({ focusPanel: Panel.Filmstrip });
            keyboardManager.setActive(RegistrationID.filmstrip);

            dispatchKey("d");
            await Promise.resolve();
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");

            dispatchKey("u");
            expect(useAppState.getState().images.length).toBe(2);
            expect(useAppState.getState().images[0]!.id).toBe("img-1");
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
            expect(useAppState.getState().activeIndex).toBe(0);
        });

        it("'edit_undo' menu action restores removed image when focused on filmstrip", async () => {
            useAppState.setState({ focusPanel: Panel.Filmstrip });
            keyboardManager.setActive(RegistrationID.filmstrip);

            dispatchMenu("filmstrip_delete");
            await Promise.resolve();
            expect(useAppState.getState().images.length).toBe(1);

            dispatchMenu(CommandId.EditUndo);
            expect(useAppState.getState().images.length).toBe(2);
            expect(useAppState.getState().images[0]!.id).toBe("img-1");
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
        });

        it("'r' key and 'edit_redo' menu action redo image removal", async () => {
            useAppState.setState({ focusPanel: Panel.Filmstrip });
            keyboardManager.setActive(RegistrationID.filmstrip);

            dispatchKey("d");
            await Promise.resolve();
            dispatchKey("u");
            expect(useAppState.getState().images.length).toBe(2);

            dispatchKey("r");
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");

            dispatchMenu(CommandId.EditUndo);
            expect(useAppState.getState().images.length).toBe(2);

            dispatchMenu(CommandId.EditRedo);
            expect(useAppState.getState().images.length).toBe(1);
            expect(useAppState.getState().images[0]!.id).toBe("img-2");
        });

        it("restores removed images and Filmstrip focus when all images were deleted", async () => {
            useAppState.setState({
                selectedIds: new Set(["img-1", "img-2"]),
                focusPanel: Panel.Filmstrip,
            });
            keyboardManager.setActive(RegistrationID.filmstrip);

            dispatchKey("d");
            await Promise.resolve();
            expect(useAppState.getState().images.length).toBe(0);
            expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);

            // Undo in empty state restores both images and restores Filmstrip panel focus
            dispatchKey("u");
            expect(useAppState.getState().images.length).toBe(2);
            expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
            expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
            expect(useAppState.getState().selectedIds.has("img-2")).toBe(true);
        });
    });
});
