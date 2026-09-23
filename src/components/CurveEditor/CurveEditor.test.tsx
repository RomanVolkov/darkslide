import { render, screen, act } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurveEditor } from "./CurveEditor.tsx";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { useAppState } from "../../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";

function setupImage() {
    useAppState.setState({
        images: [{ id: "a", filename: "a.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) }],
        activeIndex: 0,
    });
}

function press(key: string) {
    const evt = new KeyboardEvent("keydown", { key, bubbles: true });
    const target = document.createElement("div");
    Object.defineProperty(evt, "target", { value: target, writable: false });
    keyboardManager.dispatch(evt);
}

function curves() {
    return useAppState.getState().images[0]!.adjustments.curves;
}

function renderEditor(selectedPoint = 1) {
    const adj = useAppState.getState().images[0]!.adjustments;
    render(
        <CurveEditor
            curves={adj.curves}
            active
            focused
            selectedPoint={selectedPoint}
            setSelectedPoint={() => {}}
            setCurveActive={() => {}}
        />,
    );
    keyboardManager.setActive(RegistrationID.curve);
}

describe("CurveEditor channel selector", () => {
    beforeEach(setupImage);
    afterEach(() => {
        keyboardManager.unregister(RegistrationID.curve);
    });

    it("cycles the active channel with Tab (keyboard)", () => {
        renderEditor();
        expect(screen.getByRole("tab", { selected: true }).textContent).toBe("RGB");
        act(() => press("Tab"));
        expect(screen.getByRole("tab", { selected: true }).textContent).toBe("R");
        act(() => press("Tab"));
        expect(screen.getByRole("tab", { selected: true }).textContent).toBe("G");
    });

    it("switches the active channel on tab click (mouse)", () => {
        renderEditor();
        act(() => {
            screen.getByRole("tab", { name: "B" }).click();
        });
        expect(screen.getByRole("tab", { selected: true }).textContent).toBe("B");
    });

    it("edits only the active channel", () => {
        renderEditor();
        // Edit RGB first: selected point index 1 has y=255, j decreases it.
        act(() => press("j"));
        expect(curves().rgb[1]!.y).toBe(250);
        expect(curves().red[1]!.y).toBe(255);

        // Switch to red and edit; rgb must stay untouched.
        act(() => press("Tab"));
        act(() => press("j"));
        expect(curves().red[1]!.y).toBe(250);
        expect(curves().rgb[1]!.y).toBe(250);
    });

    it("inserts a point when clicking canvas and drags it within bounds", () => {
        renderEditor();
        const canvas = screen.getByTestId("curve-canvas");
        vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
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

        // Click at (100, 100) -> cx = 100, cy = 255 - 100 = 155
        act(() => {
            canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
        });

        const pts = curves().rgb;
        expect(pts.length).toBe(3);
        expect(pts[1]!.x).toBe(100);
        expect(pts[1]!.y).toBe(155);

        // Drag to (120, 50) -> rawX = 120, rawY = 255 - 50 = 205
        act(() => {
            canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 50, bubbles: true }));
            canvas.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 50, bubbles: true }));
        });

        const dragged = curves().rgb;
        expect(dragged[1]!.x).toBe(120);
        expect(dragged[1]!.y).toBe(205);
    });

    it("deletes a point on double-click or right-click", () => {
        renderEditor();
        const canvas = screen.getByTestId("curve-canvas");
        vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
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

        // Insert point at (100, 100)
        act(() => {
            canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
            canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        });
        expect(curves().rgb.length).toBe(3);

        // Double-click near the point to delete
        act(() => {
            canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 100, clientY: 100, bubbles: true }));
        });
        expect(curves().rgb.length).toBe(2);

        // Insert again and delete via contextmenu (right-click)
        act(() => {
            canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
            canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        });
        expect(curves().rgb.length).toBe(3);

        act(() => {
            canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: 100, clientY: 100, bubbles: true }));
        });
        expect(curves().rgb.length).toBe(2);
    });

    it("resets the curve when clicking the Reset button", () => {
        renderEditor();
        // Modify curve
        act(() => press("j"));
        expect(curves().rgb[1]!.y).toBe(250);

        const resetBtn = screen.getByTestId("curve-reset-btn");
        act(() => {
            resetBtn.click();
        });
        expect(curves().rgb[1]!.y).toBe(255);
    });
});
