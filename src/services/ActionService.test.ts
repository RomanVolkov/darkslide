import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionService, CommandId } from "./ActionService";
import { useAppState } from "../state/appState";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import { Panel } from "../components/constants";
import { filmstripHistory } from "./filmstripHistory";

vi.mock("./FileHandlers", () => ({
    loadImages: vi.fn(async () => {}),
}));

vi.mock("./SessionService", () => ({
    openPalette: vi.fn(),
}));

vi.mock("./autoWhiteBalance", () => ({
    applyAutoWhiteBalance: vi.fn(async () => ({ temperature: 10, tint: -5 })),
}));

import { loadImages } from "./FileHandlers";
import { openPalette } from "./SessionService";
import { applyAutoWhiteBalance } from "./autoWhiteBalance";

describe("ActionService", () => {
    const mockProcessor = {
        backend: {
            unload: vi.fn(async () => {}),
        },
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
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
            showExport: false,
            showSessions: false,
            showKeymap: false,
            showEraseConfirm: false,
            showOriginal: false,
            filmstripView: "strip",
            focusPanel: Panel.Adjustments,
            sessionId: 101,
        });
    });

    it("opens and closes export modal", () => {
        ActionService.openExport();
        expect(useAppState.getState().showExport).toBe(true);

        ActionService.closeExport();
        expect(useAppState.getState().showExport).toBe(false);

        // Does not open export when no images exist
        useAppState.setState({ images: [] });
        ActionService.openExport();
        expect(useAppState.getState().showExport).toBe(false);
    });

    it("opens and closes sessions modal", () => {
        ActionService.openSessions();
        expect(openPalette).toHaveBeenCalled();

        useAppState.setState({ showSessions: true });
        ActionService.closeSessions();
        expect(useAppState.getState().showSessions).toBe(false);
    });

    it("toggles and closes help modal", () => {
        ActionService.toggleHelp();
        expect(useAppState.getState().showKeymap).toBe(true);

        ActionService.toggleHelp();
        expect(useAppState.getState().showKeymap).toBe(false);

        useAppState.setState({ showKeymap: true });
        ActionService.closeHelp();
        expect(useAppState.getState().showKeymap).toBe(false);
    });

    it("opens and closes erase confirm modal", () => {
        ActionService.openEraseConfirm();
        expect(useAppState.getState().showEraseConfirm).toBe(true);

        ActionService.closeEraseConfirm();
        expect(useAppState.getState().showEraseConfirm).toBe(false);
    });

    it("closeAllModals closes all open modals at once", () => {
        useAppState.setState({
            showExport: true,
            showSessions: true,
            showKeymap: true,
            showEraseConfirm: true,
        });
        ActionService.closeAllModals();
        const st = useAppState.getState();
        expect(st.showExport).toBe(false);
        expect(st.showSessions).toBe(false);
        expect(st.showKeymap).toBe(false);
        expect(st.showEraseConfirm).toBe(false);
    });

    it("toggles original image compare preview", () => {
        ActionService.toggleOriginal(true);
        expect(useAppState.getState().showOriginal).toBe(true);

        ActionService.toggleOriginal(false);
        expect(useAppState.getState().showOriginal).toBe(false);

        ActionService.toggleOriginal();
        expect(useAppState.getState().showOriginal).toBe(true);

        useAppState.setState({ images: [] });
        ActionService.toggleOriginal(true);
        expect(useAppState.getState().showOriginal).toBe(false);
    });

    it("rotates active image clockwise by 90 degrees", () => {
        ActionService.rotateCW();
        expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(90);

        ActionService.rotateCW();
        expect(useAppState.getState().images[0]!.adjustments.rotation).toBe(180);
    });

    it("toggles fullscreen grid view", () => {
        ActionService.toggleGrid();
        expect(useAppState.getState().filmstripView).toBe("grid");
        expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);

        ActionService.toggleGrid();
        expect(useAppState.getState().filmstripView).toBe("strip");
    });

    it("copies and pastes adjustments", () => {
        useAppState.getState().updateImage("img-1", (img) => {
            img.adjustments.light.exposure = 45;
        });

        ActionService.copyAdjustments();
        expect(useAppState.getState().toastMessage).toBe("yanked");

        useAppState.setState({ activeIndex: 1 });
        ActionService.pasteAdjustments();
        expect(useAppState.getState().images[1]!.adjustments.light.exposure).toBe(45);
        expect(useAppState.getState().toastMessage).toBe("pasted");
    });

    it("deletes active image into undo history, allows undo/redo, and unloads on finalize", async () => {
        useAppState.setState({ focusPanel: Panel.Filmstrip });
        await ActionService.deleteSelected(mockProcessor);

        expect(useAppState.getState().images.length).toBe(1);
        expect(useAppState.getState().images[0]!.id).toBe("img-2");
        expect(mockProcessor.backend.unload).not.toHaveBeenCalled();

        // Undo restores img-1 at its original index 0
        ActionService.undo();
        expect(useAppState.getState().images.length).toBe(2);
        expect(useAppState.getState().images[0]!.id).toBe("img-1");
        expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
        expect(useAppState.getState().activeIndex).toBe(0);
        expect(useAppState.getState().toastMessage).toBe("restored photo1.jpg");

        // Redo removes img-1 again
        ActionService.redo();
        expect(useAppState.getState().images.length).toBe(1);
        expect(useAppState.getState().images[0]!.id).toBe("img-2");
        expect(useAppState.getState().toastMessage).toBe("removed photo1.jpg");

        // When cleared/finalized, unload is invoked with active session id
        await filmstripHistory.clear(true);
        expect(mockProcessor.backend.unload).toHaveBeenCalledWith(["img-1"], 101);
    });

    it("deletes multiple selected images, restores all on undo, and redos deletion", async () => {
        useAppState.setState({
            selectedIds: new Set(["img-1", "img-2"]),
            focusPanel: Panel.Filmstrip,
        });

        await ActionService.deleteSelected(mockProcessor);

        expect(useAppState.getState().images.length).toBe(0);
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);
        expect(mockProcessor.backend.unload).not.toHaveBeenCalled();

        // Undo restores both images and restores Filmstrip panel focus
        ActionService.undo();
        expect(useAppState.getState().images.length).toBe(2);
        expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
        expect(useAppState.getState().selectedIds.has("img-1")).toBe(true);
        expect(useAppState.getState().selectedIds.has("img-2")).toBe(true);
        expect(useAppState.getState().toastMessage).toBe("restored 2 images");

        // Redo removes both images again
        ActionService.redo();
        expect(useAppState.getState().images.length).toBe(0);
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);
        expect(useAppState.getState().toastMessage).toBe("removed 2 images");

        await filmstripHistory.clear(true);
        expect(mockProcessor.backend.unload).toHaveBeenCalledWith(["img-1", "img-2"], 101);
    });

    it("runs auto white balance and shows toast", async () => {
        await ActionService.autoWhiteBalance();
        expect(applyAutoWhiteBalance).toHaveBeenCalledWith("img-1");
        expect(useAppState.getState().toastMessage).toContain("Auto WB");
    });

    it("resets all adjustments on active image", () => {
        useAppState.getState().updateImage("img-1", (img) => {
            img.adjustments.light.exposure = 75;
        });
        ActionService.resetAdjustments();
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
        expect(useAppState.getState().toastMessage).toBe("reset all");
    });

    it("execute routes command IDs cleanly", async () => {
        const handledOpen = await ActionService.execute(CommandId.FileOpen, mockProcessor);
        expect(handledOpen).toBe(true);
        expect(loadImages).toHaveBeenCalledWith(null, expect.anything(), mockProcessor, false, false);

        const handledExport = await ActionService.execute(CommandId.FileExport, mockProcessor);
        expect(handledExport).toBe(true);
        expect(useAppState.getState().showExport).toBe(true);

        const handledSelectAll = await ActionService.execute(CommandId.EditSelectAll, mockProcessor);
        expect(handledSelectAll).toBe(true);

        // Supports raw string IDs (e.g. from Tauri IPC menu events)
        const handledString = await ActionService.execute("file_export", mockProcessor);
        expect(handledString).toBe(true);

        const handledUnknown = await ActionService.execute("non_existent_command", mockProcessor);
        expect(handledUnknown).toBe(false);
    });

    it("deduplicates rapid dual dispatches from DOM keydown and menu accelerator", async () => {
        expect(useAppState.getState().filmstripView).toBe("strip");

        // First dispatch (e.g. from DOM keydown)
        await ActionService.execute(CommandId.ViewGrid, mockProcessor);
        expect(useAppState.getState().filmstripView).toBe("grid");

        // Immediate second dispatch (e.g. from native menu-action accelerator 2ms later)
        await ActionService.execute(CommandId.ViewGrid, mockProcessor);
        // Should STILL be grid, not toggled back to strip!
        expect(useAppState.getState().filmstripView).toBe("grid");
    });
});
