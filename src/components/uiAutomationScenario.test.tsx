import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    getMenuActionCallback,
    setMenuActionCallback,
    mockInvoke,
    mockUnload,
    mockExport,
    mockAutoWb,
    mockRenderThumbnails,
} = vi.hoisted(() => {
    let cb: ((event: { payload: string }) => void) | null = null;
    return {
        getMenuActionCallback: () => cb,
        setMenuActionCallback: (c: any) => { cb = c; },
        mockInvoke: vi.fn(),
        mockUnload: vi.fn(),
        mockExport: vi.fn(),
        mockAutoWb: vi.fn(),
        mockRenderThumbnails: vi.fn(),
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(async () => ["/photos/img-1.jpg", "/photos/img-2.jpg", "/photos/img-3.jpg"]),
    save: vi.fn(async () => "/photos/exported.jpg"),
}));

vi.mock("../backend/index.ts", () => ({
    getBackend: vi.fn(async () => ({
        renderPreview: vi.fn(async () => ({
            data: { kind: "raw", width: 10, height: 10, data: new Uint8ClampedArray(400) },
            histogram: { red: new Uint32Array(256), green: new Uint32Array(256), blue: new Uint32Array(256), luma: new Uint32Array(256) },
        })),
        renderThumbnail: vi.fn(),
        renderThumbnails: mockRenderThumbnails,
        autoWhiteBalance: mockAutoWb,
        import: vi.fn(async (paths: string[] | null) => {
            const list = paths ?? ["/photos/img-1.jpg", "/photos/img-2.jpg", "/photos/img-3.jpg"];
            return list.map((p) => {
                const id = p.split("/").pop()?.replace(".jpg", "") ?? "img";
                return {
                    id,
                    filename: `${id}.jpg`,
                    width: 1920,
                    height: 1080,
                    adjustments: structuredClone(DEFAULT_ADJUSTMENTS),
                };
            });
        }),
        export: mockExport,
        unload: mockUnload,
        clearAllAdjustments: vi.fn(async () => {}),
        pickImages: vi.fn(async () => ["/photos/img-1.jpg", "/photos/img-2.jpg", "/photos/img-3.jpg"]),
        createSession: vi.fn(async () => ({ id: 1, name: "Paris 2024", is_existing: false })),
    })),
}));

import { AppEffects } from "../effects/AppEffects.tsx";
import { AppLayout } from "./AppLayout.tsx";
import { getBackend } from "../backend/index.ts";
import { ImageProcessor } from "../services/ImageProcessor.ts";
import { useAppState } from "../state/appState.ts";
import { keyboardManager, RegistrationID } from "../services/KeyboardManager.ts";
import { Panel } from "./constants/index.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { ActionService } from "../services/ActionService.ts";
import { filmstripHistory } from "../services/filmstripHistory.ts";
import type { PixelData, Histogram } from "../backend/types.ts";

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

function histogram(): Histogram {
    const arr = () => new Uint32Array(256);
    return { red: arr(), green: arr(), blue: arr(), luma: arr() };
}

describe("Comprehensive UI Automation Scenario (Mixed Mouse & Keyboard Parity)", () => {
    let processor: ImageProcessor;

    beforeEach(async () => {
        vi.clearAllMocks();
        ActionService.resetDeduplicationForTests();
        filmstripHistory.resetForTests();
        mockInvoke.mockImplementation(async (cmd: string) => {
            if (cmd === "list_sessions") {
                return [
                    { id: 1, name: "Paris 2024", image_count: 2, updated_at: "2026-09-16T00:00:00Z" },
                    { id: 2, name: "Tokyo trip", image_count: 5, updated_at: "2026-09-15T00:00:00Z" },
                ];
            }
            return [];
        });

        useAppState.setState({
            images: [],
            activeIndex: 0,
            selectedIds: new Set<string>(),
            renderedData: pixelData(),
            renderedImageId: null,
            renderedHistogram: histogram(),
            filmstripView: "strip",
            focusPanel: Panel.Adjustments,
            geometryEdit: false,
            showOriginal: false,
            showExport: false,
            showSessions: false,
            showKeymap: false,
            sessions: [
                { id: 1, name: "Paris 2024", image_count: 2, updated_at: "2026-09-16T00:00:00Z" },
                { id: 2, name: "Tokyo trip", image_count: 5, updated_at: "2026-09-15T00:00:00Z" },
            ],
            sessionId: 1,
        });

        processor = new ImageProcessor(await getBackend());
        render(
            <>
                <AppEffects processor={processor} />
                <AppLayout processor={processor} />
            </>,
        );
    });

    it("executes complete mixed mouse and keyboard journey with state parity and IPC calls", async () => {
        // -------------------------------------------------------------
        // 1. Initial State & Open Images via Empty State Button (Mouse)
        // -------------------------------------------------------------
        const openBtn = screen.getByTestId("empty-open-images-btn");
        expect(openBtn).toBeInTheDocument();
        expect(screen.getByTestId("empty-open-sessions-btn")).toBeInTheDocument();
        expect(screen.getByTestId("help-toggle-btn")).toBeInTheDocument();

        act(() => {
            fireEvent.click(openBtn);
        });

        await waitFor(() => {
            expect(useAppState.getState().images.length).toBe(3);
        });

        // Verify images were loaded into store and state updated
        const store = useAppState.getState();
        expect(store.images.map((i) => i.id)).toEqual(["img-1", "img-2", "img-3"]);
        expect(store.activeIndex).toBe(0);
        expect(store.selectedIds.size).toBe(0);

        // -------------------------------------------------------------
        // 2. Filmstrip Selection Parity: Single, Shift+Click, ⌘+Click
        // -------------------------------------------------------------
        const item1 = screen.getByTestId("filmstrip-item-img-1");
        const item2 = screen.getByTestId("filmstrip-item-img-2");
        const item3 = screen.getByTestId("filmstrip-item-img-3");

        // Single click item 2 -> switches active and single selection
        act(() => {
            fireEvent.click(item2);
        });
        expect(useAppState.getState().activeIndex).toBe(1);
        expect(Array.from(useAppState.getState().selectedIds)).toEqual(["img-2"]);

        // Shift + Click item 3 -> expands range from 1 to 2 -> selected: [img-2, img-3]
        act(() => {
            fireEvent.click(item3, { shiftKey: true });
        });
        expect(useAppState.getState().activeIndex).toBe(2);
        expect(Array.from(useAppState.getState().selectedIds).sort()).toEqual(["img-2", "img-3"]);

        // ⌘ / Ctrl + Click item 1 -> toggles item 1 into selection -> selected: [img-1, img-2, img-3]
        act(() => {
            fireEvent.click(item1, { metaKey: true });
        });
        expect(useAppState.getState().activeIndex).toBe(0);
        expect(Array.from(useAppState.getState().selectedIds).sort()).toEqual(["img-1", "img-2", "img-3"]);

        // Click item 1 without modifiers -> resets selection to single item 1
        act(() => {
            fireEvent.click(item1);
        });
        expect(useAppState.getState().activeIndex).toBe(0);
        expect(Array.from(useAppState.getState().selectedIds)).toEqual(["img-1"]);

        // -------------------------------------------------------------
        // 3. Slider Drag & Double-Click Reset (Mouse)
        // -------------------------------------------------------------
        const exposureRow = screen.getByText("Exposure").closest('[data-row-type="slider"]')!;
        const exposureSlider = exposureRow.querySelector("input")!;
        expect(exposureSlider).toBeDefined();

        // Drag/change slider value to 1.5
        act(() => {
            fireEvent.change(exposureSlider, { target: { value: "1.5" } });
        });
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(1.5);

        // Double-click slider container row to reset to 0
        const sliderRow = exposureSlider.closest('[data-row-type="slider"]');
        expect(sliderRow).not.toBeNull();
        act(() => {
            fireEvent.dblClick(sliderRow!);
        });
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);

        // -------------------------------------------------------------
        // 4. Multiple Adjustments & Reset All Adjustments via Menu Action
        // -------------------------------------------------------------
        act(() => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 2.0;
                img.adjustments.light.contrast = 25;
            });
        });
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(2.0);

        const menuActionCb = getMenuActionCallback();
        act(() => {
            menuActionCb!({ payload: "adjustments_reset" });
        });
        expect(useAppState.getState().images[0]!.adjustments.light.exposure).toBe(0);
        expect(useAppState.getState().images[0]!.adjustments.light.contrast).toBe(0);

        // -------------------------------------------------------------
        // 5. Curve Editor Canvas Pointer Insert, Drag, and Reset
        // -------------------------------------------------------------
        const curveCanvas = screen.getByTestId("curve-canvas");
        vi.spyOn(curveCanvas, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            right: 255,
            bottom: 255,
            width: 255,
            height: 255,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        // Click canvas at (100, 100) -> insert point (cx: 100, cy: 155)
        act(() => {
            curveCanvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
            curveCanvas.dispatchEvent(new MouseEvent("pointerup", { clientX: 100, clientY: 100, bubbles: true }));
        });
        let curvePoints = useAppState.getState().images[0]!.adjustments.curves.rgb;
        expect(curvePoints.length).toBe(3);
        expect(curvePoints[1]!.x).toBe(100);
        expect(curvePoints[1]!.y).toBe(155);

        // Drag the point to (130, 80) -> (rawX: 130, rawY: 175)
        act(() => {
            curveCanvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
            curveCanvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 130, clientY: 80, bubbles: true }));
            curveCanvas.dispatchEvent(new MouseEvent("pointerup", { clientX: 130, clientY: 80, bubbles: true }));
        });
        curvePoints = useAppState.getState().images[0]!.adjustments.curves.rgb;
        expect(curvePoints[1]!.x).toBe(130);
        expect(curvePoints[1]!.y).toBe(175);

        // Reset the curve with Reset button
        const curveResetBtn = screen.getByTestId("curve-reset-btn");
        act(() => {
            fireEvent.click(curveResetBtn);
        });
        expect(useAppState.getState().images[0]!.adjustments.curves.rgb.length).toBe(2);

        // -------------------------------------------------------------
        // 6. Compare with Original: Keyboard (\) Hold
        // -------------------------------------------------------------
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", bubbles: true }));
        });
        expect(useAppState.getState().showOriginal).toBe(true);
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keyup", { key: "\\", bubbles: true }));
        });
        expect(useAppState.getState().showOriginal).toBe(false);

        // -------------------------------------------------------------
        // 7. Context Menu Copy / Paste Adjustments Across Filmstrip
        // -------------------------------------------------------------
        // Set exposure on img-1
        act(() => {
            useAppState.getState().updateImage("img-1", (img) => {
                img.adjustments.light.exposure = 1.75;
            });
        });

        // Right-click on item 1
        act(() => {
            fireEvent.contextMenu(item1, { clientX: 100, clientY: 100 });
        });
        expect(screen.getByTestId("context-menu")).toBeInTheDocument();

        // Click "Copy Adjustments"
        act(() => {
            fireEvent.click(screen.getByText("Copy Adjustments"));
        });
        expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();

        // Right-click on item 2 and paste adjustments
        act(() => {
            fireEvent.click(item2);
        });
        act(() => {
            fireEvent.contextMenu(item2, { clientX: 150, clientY: 100 });
        });
        act(() => {
            fireEvent.click(screen.getByText("Paste Adjustments"));
        });
        expect(useAppState.getState().images[1]!.adjustments.light.exposure).toBe(1.75);

        // -------------------------------------------------------------
        // 8. Filmstrip Hover Quick-Delete Button (Mouse) with Undo/Redo
        // -------------------------------------------------------------
        const deleteBtn3 = screen.getByTestId("filmstrip-delete-btn-img-3");
        await act(async () => {
            fireEvent.click(deleteBtn3);
        });
        expect(useAppState.getState().images.length).toBe(2);
        expect(useAppState.getState().images.map((i) => i.id)).toEqual(["img-1", "img-2"]);

        // Undo restores img-3
        await act(async () => {
            menuActionCb!({ payload: "edit_undo" });
        });
        expect(useAppState.getState().images.length).toBe(3);
        expect(useAppState.getState().images.map((i) => i.id)).toEqual(["img-1", "img-2", "img-3"]);

        // Redo removes img-3 again
        await act(async () => {
            menuActionCb!({ payload: "edit_redo" });
        });
        expect(useAppState.getState().images.length).toBe(2);
        expect(useAppState.getState().images.map((i) => i.id)).toEqual(["img-1", "img-2"]);

        await filmstripHistory.clear(true);
        expect(mockUnload).toHaveBeenCalledWith(["img-3"], 1);

        // -------------------------------------------------------------
        // 9. Export Modal Flow (Menu & Keyboard)
        // -------------------------------------------------------------
        act(() => {
            menuActionCb!({ payload: "file_export" });
        });
        expect(useAppState.getState().showExport).toBe(true);
        expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();

        // Dismiss modal via Escape key
        act(() => {
            keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(useAppState.getState().showExport).toBe(false);

        // -------------------------------------------------------------
        // 10. Session Modal: Open via Menu, Right-Click Rename & Delete
        // -------------------------------------------------------------
        await act(async () => {
            menuActionCb!({ payload: "session_palette" });
        });
        expect(useAppState.getState().showSessions).toBe(true);
        expect(screen.getByText("Sessions")).toBeInTheDocument();

        // Right-click session row "Paris 2024" to Rename
        const parisRow = screen.getAllByText("Paris 2024").find((el) => el.closest('[class*="row"]'))!;
        act(() => {
            fireEvent.contextMenu(parisRow, { clientX: 200, clientY: 200 });
        });
        expect(screen.getByTestId("context-menu")).toBeInTheDocument();
        act(() => {
            fireEvent.click(screen.getByText("Rename"));
        });

        // Change rename input and submit with Enter
        const renameInput = screen.getByDisplayValue("Paris 2024");
        act(() => {
            fireEvent.change(renameInput, { target: { value: "Paris Holiday" } });
        });
        await act(async () => {
            keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(mockInvoke).toHaveBeenCalledWith("rename_session", { id: 1, name: "Paris Holiday" });

        // Right-click session row "Tokyo trip" to Delete
        const tokyoRow = screen.getByText("Tokyo trip");
        act(() => {
            fireEvent.contextMenu(tokyoRow, { clientX: 200, clientY: 250 });
        });
        act(() => {
            fireEvent.click(screen.getByText("Delete"));
        });
        expect(screen.getByText(/Delete Tokyo trip\?/)).toBeInTheDocument();

        // Click Confirm delete button in delete strip
        const confirmDeleteBtn = screen.getByTestId("session-confirm-delete-btn");
        await act(async () => {
            fireEvent.click(confirmDeleteBtn);
        });
        expect(mockInvoke).toHaveBeenCalledWith("delete_session", { id: 2 });

        // Close Session modal with Escape
        act(() => {
            keyboardManager.dispatch(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(useAppState.getState().showSessions).toBe(false);

        // -------------------------------------------------------------
        // 11. macOS Native Menu Event Bridge
        // -------------------------------------------------------------
        const menuBridgeCb = getMenuActionCallback();
        expect(menuBridgeCb).not.toBeNull();
        const rotBefore = useAppState.getState().images[useAppState.getState().activeIndex]!.adjustments.rotation;

        act(() => {
            menuBridgeCb!({ payload: "image_rotate" });
        });
        const rotAfter = useAppState.getState().images[useAppState.getState().activeIndex]!.adjustments.rotation;
        expect(rotAfter).toBe((rotBefore + 90) % 360);
    });

    it("exercises geometry overlay 4-mode keyboard/mouse workflow, slider synchronization, and undo/redo", async () => {
        // 1. Initial image load
        const openBtn = screen.getByTestId("empty-open-images-btn");
        act(() => {
            fireEvent.click(openBtn);
        });
        await waitFor(() => {
            expect(useAppState.getState().images.length).toBe(3);
        });
        expect(useAppState.getState().images[0]!.adjustments.geometry).toEqual(DEFAULT_ADJUSTMENTS.geometry);

        // Focus adjustments panel
        act(() => {
            fireEvent.pointerDown(screen.getByTestId("adjustments-panel"));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // 2. Press 'g' to enter geometry overlay
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
        });
        expect(useAppState.getState().geometryEdit).toBe(true);
        expect(keyboardManager.getActive()).toBe(RegistrationID.geometry);
        const overlay = screen.getByTestId("geometry-overlay");
        expect(overlay).toBeInTheDocument();

        // Check initial mode is ROTATE/ZOOM
        const rotateBtn = screen.getByRole("button", { name: "ROTATE/ZOOM" });
        const perspBtn = screen.getByRole("button", { name: "PERSPECTIVE" });
        const distBtn = screen.getByRole("button", { name: "DISTORTION" });
        const posBtn = screen.getByRole("button", { name: "POSITION" });
        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");

        // 3. Tab cycles to PERSPECTIVE
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });
        expect(perspBtn).toHaveAttribute("aria-pressed", "true");

        // Key adjustments in perspective mode: h/l for horizontal, j/k for vertical
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
        });
        expect(useAppState.getState().images[0]!.adjustments.geometry.perspective_h).toBe(1);
        expect(useAppState.getState().images[0]!.adjustments.geometry.perspective_v).toBe(1);

        // Pointer drag in perspective mode
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });
            fireEvent.pointerMove(overlay, { clientX: 120, clientY: 80 });
            fireEvent.pointerUp(overlay);
        });
        expect(useAppState.getState().images[0]!.adjustments.geometry.perspective_h).not.toBe(1);
        expect(useAppState.getState().images[0]!.adjustments.geometry.perspective_v).not.toBe(1);

        // 4. Tab cycles to DISTORTION
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });
        expect(distBtn).toHaveAttribute("aria-pressed", "true");

        // Key adjustments in distortion mode: l
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
        });
        expect(useAppState.getState().images[0]!.adjustments.geometry.distortion).toBe(1);

        // Pointer drag in distortion mode
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100 });
            fireEvent.pointerMove(overlay, { clientX: 120, clientY: 80 });
            fireEvent.pointerUp(overlay);
        });
        expect(useAppState.getState().images[0]!.adjustments.geometry.distortion).not.toBe(1);

        // 5. Tab cycles to POSITION
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });
        expect(posBtn).toHaveAttribute("aria-pressed", "true");

        // Tab cycles back to ROTATE/ZOOM
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });
        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");

        // 6. Press Enter to exit overlay
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(useAppState.getState().geometryEdit).toBe(false);
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // 7. Verify sidebar reflects edited geometry via GeometryRow summary (no dedicated sliders)
        const curGeo = useAppState.getState().images[0]!.adjustments.geometry;
        expect(curGeo.distortion).not.toBe(0);
        expect(curGeo.perspective_v).not.toBe(0);
        expect(curGeo.perspective_h).not.toBe(0);

        // Sidebar does not have dedicated sliders for distortion or perspective
        expect(screen.queryByText("Vertical Perspective")).not.toBeInTheDocument();
        expect(screen.queryByText("Horizontal Perspective")).not.toBeInTheDocument();

        // GeometryRow displays summary text of non-zero distortion & perspective
        const geoRow = screen.getByTestId("adjustments-panel").querySelector('[data-row-type="geometry"]')!;
        expect(geoRow).toBeInTheDocument();
        expect(geoRow.textContent).toContain("Dist:");
        expect(geoRow.textContent).toContain("V:");
        expect(geoRow.textContent).toContain("H:");

        // 8. Verify undo (⌘Z) restores geometry back to defaults
        const menuActionCb = getMenuActionCallback();
        expect(menuActionCb).not.toBeNull();

        while (
            useAppState.getState().images[0]!.adjustments.geometry.distortion !== 0 ||
            useAppState.getState().images[0]!.adjustments.geometry.perspective_v !== 0 ||
            useAppState.getState().images[0]!.adjustments.geometry.perspective_h !== 0
        ) {
            act(() => {
                menuActionCb!({ payload: "edit_undo" });
            });
        }

        const finalGeo = useAppState.getState().images[0]!.adjustments.geometry;
        expect(finalGeo.distortion).toBe(0);
        expect(finalGeo.perspective_v).toBe(0);
        expect(finalGeo.perspective_h).toBe(0);
    });

    it("exercises color balance and selective color keyboard/mouse grading journey with undo", async () => {
        // 1. Initial image load
        const openBtn = screen.getByTestId("empty-open-images-btn");
        act(() => {
            fireEvent.click(openBtn);
        });
        await waitFor(() => {
            expect(useAppState.getState().images.length).toBe(3);
        });

        // 2. Focus Adjustments Panel
        act(() => {
            fireEvent.pointerDown(screen.getByTestId("adjustments-panel"));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // 3. Navigate down to Color Balance (slot 14)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });

        // 4. Activate Color Balance via Enter
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.colorBalance);

        // Switch to Shadows (1)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
        });
        // Dive into Shadows wheel (Enter), adjust hue & sat, exit back to section (Escape), move to luminance (j), adjust luminance
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
        });

        // Tab cycles to Midtones
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        });

        // Pointer drag on color disc
        const wheelDisc = screen.getByTestId("color-wheel-disc");
        act(() => {
            fireEvent.pointerDown(wheelDisc, { clientX: 100, clientY: 80 });
            fireEvent.pointerMove(window, { clientX: 120, clientY: 70 });
            fireEvent.pointerUp(window);
        });

        // Adjust luminance slider via change event
        const lumSlider = screen.getByTestId("color-wheel-luminance");
        act(() => {
            fireEvent.change(lumSlider, { target: { value: "25" } });
        });

        const cbAfter = useAppState.getState().images[0]!.adjustments.color_balance;
        expect(cbAfter.shadows.hue).toBe(2);
        expect(cbAfter.shadows.saturation).toBe(1);
        expect(cbAfter.shadows.luminance).toBe(1);
        expect(cbAfter.midtones.luminance).toBe(25);

        // Exit Color Balance via Escape
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // 5. Navigate 1 step down to Selective Color (slot 15)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });

        // Activate Selective Color via Enter
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.selectiveColor);

        // Select Green channel via digit 4
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
        });
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Green");

        // Adjust Green Hue (+1)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
        });

        // Move slider focus to Saturation (j) and adjust (+10)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, shiftKey: true }));
        });

        // Move slider focus to Luminance (j) and adjust (-10)
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        });
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true, shiftKey: true }));
        });

        // Click Blue swatch chip
        act(() => {
            fireEvent.click(screen.getByTestId("swatch-blue"));
        });
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Blue");

        // Change Blue Hue slider
        const scPanel = screen.getByTestId("selective-color-panel");
        const scSliders = within(scPanel).getAllByRole("slider");
        act(() => {
            fireEvent.change(scSliders[0]!, { target: { value: "18" } });
        });

        const scAfter = useAppState.getState().images[0]!.adjustments.selective_color;
        expect(scAfter.green.hue).toBe(1);
        expect(scAfter.green.saturation).toBe(10);
        expect(scAfter.green.luminance).toBe(-10);
        expect(scAfter.blue.hue).toBe(18);

        // Exit Selective Color via Escape
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(keyboardManager.getActive()).toBe(RegistrationID.adjustments);

        // 6. Undo (⌘Z / edit_undo) sequentially until all color grading edits are restored to default
        const menuActionCb = getMenuActionCallback();
        expect(menuActionCb).not.toBeNull();

        const isColorGradingDefault = () => {
            const adj = useAppState.getState().images[0]!.adjustments;
            const cb = adj.color_balance;
            const sc = adj.selective_color;
            const cbZero =
                cb.shadows.hue === 0 && cb.shadows.saturation === 0 && cb.shadows.luminance === 0 &&
                cb.midtones.hue === 0 && cb.midtones.saturation === 0 && cb.midtones.luminance === 0 &&
                cb.highlights.hue === 0 && cb.highlights.saturation === 0 && cb.highlights.luminance === 0;
            const scZero = Object.values(sc).every(
                (ch) => ch.hue === 0 && ch.saturation === 0 && ch.luminance === 0
            );
            return cbZero && scZero;
        };

        while (!isColorGradingDefault()) {
            act(() => {
                menuActionCb!({ payload: "edit_undo" });
            });
        }

        const finalAdj = useAppState.getState().images[0]!.adjustments;
        expect(finalAdj.color_balance).toEqual(DEFAULT_ADJUSTMENTS.color_balance);
        expect(finalAdj.selective_color).toEqual(DEFAULT_ADJUSTMENTS.selective_color);
    });
});
