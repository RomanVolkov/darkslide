import { render, screen, act, fireEvent } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

let menuActionCallback: ((event: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (eventName: string, cb: any) => {
        if (eventName === "menu-action") {
            menuActionCallback = cb;
        }
        return vi.fn();
    }),
}));

vi.mock("../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({
        renderPreview: vi.fn(),
        renderThumbnail: vi.fn(),
        renderThumbnails: vi.fn(async () => []),
        autoWhiteBalance: vi.fn(async () => ({ temperature: 0, tint: 0 })),
        import: vi.fn(async () => null),
        export: vi.fn(async () => {}),
        unload: vi.fn(async () => {}),
        clearAllAdjustments: vi.fn(async () => {}),
    })),
}));

import { AppEffects } from "./AppEffects.tsx";
import { AppLayout } from "../components/AppLayout.tsx";
import { getBackend } from "../backend/index.ts";
import { ImageProcessor } from "../services/ImageProcessor.ts";
import { useAppState } from "../state/appState.ts";
import { keyboardManager, RegistrationID } from "../services/KeyboardManager.ts";
import { Panel } from "../components/constants/index.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
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

async function renderShell() {
    const processor = new ImageProcessor(await getBackend());
    render(
        <>
            <AppEffects processor={processor} />
            <AppLayout processor={processor} />
        </>,
    );
    return processor;
}

describe("AppEffects + AppLayout focus routing (app level)", () => {
    beforeEach(() => {
        useAppState.setState({
            images: [
                { id: "a", filename: "a.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) },
                { id: "b", filename: "b.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) },
            ],
            activeIndex: 0,
            renderedData: pixelData(),
            renderedImageId: "a",
            renderedHistogram: histogram(),
            filmstripView: "strip",
            focusPanel: Panel.Adjustments,
            geometryEdit: false,
        });
    });

    it("routes the keyboard to the focused panel across the whole shell", async () => {
        await renderShell();

        act(() => { fireEvent.pointerDown(screen.getByTestId("adjustments-panel")); });
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        act(() => { fireEvent.pointerDown(screen.getByTestId("filmstrip")); });
        expect(useAppState.getState().focusPanel).toBe(Panel.Filmstrip);
        expect(keyboardManager.getActive()).toBe(RegistrationID.filmstrip);
    });

    it("gives geometry mode the keyboard while active, and restores focus on exit", async () => {
        await renderShell();

        act(() => { fireEvent.click(screen.getByText("Crop & Straighten…")); });
        expect(useAppState.getState().geometryEdit).toBe(true);
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);
        expect(keyboardManager.getActive()).toBe(RegistrationID.geometry);

        // Clicking outside the overlay leaves geometry and restores routing.
        act(() => { fireEvent.pointerDown(screen.getByTestId("filmstrip")); });
        expect(useAppState.getState().geometryEdit).toBe(false);
        expect(keyboardManager.getActive()).toBe(RegistrationID.filmstrip);

        // Re-entering and exiting via the panel keeps everything consistent.
        act(() => { fireEvent.click(screen.getByText("Crop & Straighten…")); });
        expect(keyboardManager.getActive()).toBe(RegistrationID.geometry);
        act(() => { fireEvent.pointerDown(screen.getByTestId("adjustments-panel")); });
        expect(useAppState.getState().geometryEdit).toBe(false);
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);
    });

    it("routes the same key (l) to the filmstrip or the panel based on focus", async () => {
        await renderShell();

        const exposure0 = () => useAppState.getState().images[0]!.adjustments.light.exposure;

        // --- Filmstrip focused: "l" advances the filmstrip, edits no slider. ---
        act(() => { fireEvent.pointerDown(screen.getByTestId("filmstrip")); });
        const indexBefore = useAppState.getState().activeIndex;
        const expBefore = exposure0();

        vi.useFakeTimers();
        try {
            act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true })); });
            act(() => { vi.advanceTimersByTime(80); }); // filmstrip nav debounce is 35ms
        } finally {
            vi.useRealTimers();
        }

        expect(useAppState.getState().activeIndex).toBe(indexBefore + 1);
        expect(exposure0()).toBe(expBefore);

        // --- Panel focused: "j" moves to Exposure, "l" edits that slider only. ---
        act(() => { fireEvent.pointerDown(screen.getByTestId("adjustments-panel")); });
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); }); // Geometry -> Exposure
        const idxBefore = useAppState.getState().activeIndex;
        const activeExpBefore = useAppState.getState().images[useAppState.getState().activeIndex]!.adjustments.light.exposure;
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true })); });

        expect(useAppState.getState().images[useAppState.getState().activeIndex]!.adjustments.light.exposure).not.toBe(activeExpBefore);
        expect(useAppState.getState().activeIndex).toBe(idxBefore);
    });

    it("moves focus from the bottom filmstrip into the adjustments panel with j/k", async () => {
        await renderShell();

        act(() => { fireEvent.pointerDown(screen.getByTestId("filmstrip")); });
        expect(keyboardManager.getActive()).toBe(RegistrationID.filmstrip);

        // "j" (or "k") in strip mode hands focus to the adjustments panel.
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true })); });
        expect(useAppState.getState().focusPanel).toBe(Panel.Adjustments);
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // ...and now j/k navigate the adjustments rows.
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); }); // Geometry -> Exposure
        const image = useAppState.getState().images[useAppState.getState().activeIndex]!;
        const before = image.adjustments.light.exposure;
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true })); });
        expect(useAppState.getState().images[useAppState.getState().activeIndex]!.adjustments.light.exposure)
            .not.toBe(before);
    });

    it("dispatches menu actions from Tauri menu-action events", async () => {
        const { ActionService } = await import("../services/ActionService.ts");
        const executeSpy = vi.spyOn(ActionService, "execute");
        const processor = await renderShell();

        expect(menuActionCallback).not.toBeNull();
        act(() => {
            menuActionCallback!({ payload: "file_export" });
        });
        expect(executeSpy).toHaveBeenCalledWith("file_export", processor);
    });

    it("synchronizes window and document title with active session name", async () => {
        await renderShell();
        expect(document.title).toBe("Darkslide");

        act(() => {
            useAppState.setState({
                sessions: [
                    { id: 1, name: "Summer Trip 2026", image_count: 5, updated_at: "" },
                ],
                sessionId: 1,
            });
        });
        expect(document.title).toBe("Darkslide - Summer Trip 2026");

        act(() => {
            useAppState.setState({ sessionId: null });
        });
        expect(document.title).toBe("Darkslide");
    });

    it("activates Color Balance and Selective Color on Enter and restores adjustments on Escape", async () => {
        await renderShell();

        act(() => { fireEvent.pointerDown(screen.getByTestId("adjustments-panel")); });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // Color Balance is at slot 14. Navigate directly there using count + j
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });

        // Press Enter to activate Color Balance
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.colorBalance);

        // Press Escape to return to adjustments
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // Navigate 1 step down to Selective Color (slot 15)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });

        // Press Enter to activate Selective Color
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.selectiveColor);

        // Press Escape to return to adjustments
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);
    });
});
