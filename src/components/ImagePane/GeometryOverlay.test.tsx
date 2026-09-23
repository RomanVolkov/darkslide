import { render, screen, act, fireEvent } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeometryOverlay } from "./GeometryOverlay.tsx";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { useAppState } from "../../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";

function setup() {
    useAppState.setState({
        images: [{ id: "a", filename: "a.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) }],
        activeIndex: 0,
        geometryEdit: true,
    });
}

function press(key: string, shift = false) {
    const evt = new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true });
    const target = document.createElement("div");
    Object.defineProperty(evt, "target", { value: target, writable: false });
    keyboardManager.dispatch(evt);
}

function geo() {
    return useAppState.getState().images[0]!.adjustments.geometry;
}

describe("GeometryOverlay", () => {
    beforeEach(() => {
        setup();
        render(<GeometryOverlay />);
        keyboardManager.setActive(RegistrationID.geometry);
    });

    afterEach(() => {
        keyboardManager.unregister(RegistrationID.geometry);
    });

    it("cycles sub-modes with Tab and Shift+Tab", () => {
        const rotateBtn = screen.getByRole("button", { name: "ROTATE/ZOOM" });
        const perspBtn = screen.getByRole("button", { name: "PERSPECTIVE" });
        const distBtn = screen.getByRole("button", { name: "DISTORTION" });
        const posBtn = screen.getByRole("button", { name: "POSITION" });

        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");

        act(() => press("Tab")); // -> perspective
        expect(perspBtn).toHaveAttribute("aria-pressed", "true");

        act(() => press("Tab")); // -> distortion
        expect(distBtn).toHaveAttribute("aria-pressed", "true");

        act(() => press("Tab")); // -> position
        expect(posBtn).toHaveAttribute("aria-pressed", "true");

        act(() => press("Tab")); // -> back to rotate
        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");

        act(() => press("Tab", true)); // shift+tab -> position
        expect(posBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("does not jump the image when switching modes after rotating", () => {
        for (let i = 0; i < 10; i++) act(() => press("l", true)); // straighten 10°
        const before = { ...geo() };
        act(() => press("Tab")); // -> perspective
        expect(geo().zoom).toBe(before.zoom);
        expect(geo().straighten).toBe(before.straighten);
    });

    it("adjusts angle with h/l (fine and coarse)", () => {
        act(() => press("l"));
        expect(geo().straighten).toBeCloseTo(0.1);
        act(() => press("l", true));
        expect(geo().straighten).toBeCloseTo(1.1);
        act(() => press("h"));
        expect(geo().straighten).toBeCloseTo(1.0);
    });

    it("adjusts zoom with j/k in rotate mode", () => {
        act(() => press("k"));
        expect(geo().zoom).toBeCloseTo(1.02);
        act(() => press("j"));
        expect(geo().zoom).toBeCloseTo(1.0);
    });

    it("adjusts perspective with h/l/j/k in perspective mode (fine and coarse)", () => {
        const perspBtn = screen.getByRole("button", { name: "PERSPECTIVE" });
        fireEvent.click(perspBtn);

        act(() => press("l")); // perspective_h +1
        expect(geo().perspective_h).toBeCloseTo(1.0);
        act(() => press("l", true)); // coarse +5
        expect(geo().perspective_h).toBeCloseTo(6.0);
        act(() => press("h")); // -1
        expect(geo().perspective_h).toBeCloseTo(5.0);

        act(() => press("k")); // perspective_v +1
        expect(geo().perspective_v).toBeCloseTo(1.0);
        act(() => press("k", true)); // coarse +5
        expect(geo().perspective_v).toBeCloseTo(6.0);
        act(() => press("j")); // -1
        expect(geo().perspective_v).toBeCloseTo(5.0);
    });

    it("adjusts distortion with h/l in distortion mode", () => {
        const distBtn = screen.getByRole("button", { name: "DISTORTION" });
        fireEvent.click(distBtn);

        act(() => press("l")); // distortion +1
        expect(geo().distortion).toBeCloseTo(1.0);
        act(() => press("l", true)); // coarse +5
        expect(geo().distortion).toBeCloseTo(6.0);
        act(() => press("h")); // -1
        expect(geo().distortion).toBeCloseTo(5.0);
    });

    it("pans with h/l/j/k in position mode once zoomed in", () => {
        act(() => press("k", true)); // zoom 1.1
        const posBtn = screen.getByRole("button", { name: "POSITION" });
        fireEvent.click(posBtn);

        act(() => press("l"));
        expect(geo().crop_x).toBeCloseTo(0.05);
        act(() => press("j"));
        expect(geo().crop_y).toBeCloseTo(0.05);
    });

    it("does not pan (or zoom) in position mode at zoom 1", () => {
        const posBtn = screen.getByRole("button", { name: "POSITION" });
        fireEvent.click(posBtn);

        act(() => press("l"));
        act(() => press("j"));
        expect(geo().crop_x).toBe(0);
        expect(geo().crop_y).toBe(0);
        expect(geo().zoom).toBe(1);
    });

    it("resets all geometry with x", () => {
        act(() => press("l"));
        act(() => press("k"));
        act(() => press("x"));
        expect(geo()).toEqual({
            straighten: 0,
            zoom: 1,
            crop_x: 0,
            crop_y: 0,
            distortion: 0,
            perspective_v: 0,
            perspective_h: 0,
        });
    });

    it("exits on Escape", () => {
        act(() => press("Escape"));
        expect(useAppState.getState().geometryEdit).toBe(false);
    });

    it("exits on Enter", () => {
        act(() => press("Enter"));
        expect(useAppState.getState().geometryEdit).toBe(false);
    });

    it("uses the coarse step with shift (uppercase key)", () => {
        // Shift+letter arrives as an uppercase `key`.
        act(() => press("L", true));
        expect(geo().straighten).toBeCloseTo(1.0);
    });

    it("clamps the straighten angle to ±45", () => {
        for (let i = 0; i < 100; i++) act(() => press("l", true));
        expect(geo().straighten).toBe(45);
    });

    it("clamps zoom to 1..4", () => {
        for (let i = 0; i < 100; i++) act(() => press("k", true));
        expect(geo().zoom).toBe(4);
        for (let i = 0; i < 100; i++) act(() => press("j", true));
        expect(geo().zoom).toBe(1);
    });

    it("rotates on mouse drag in rotate mode", () => {
        const overlay = screen.getByTestId("geometry-overlay");
        Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
        Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerMove(overlay, { clientX: 80, clientY: 100, pointerId: 1 });
        });
        // fx = (80 - 100) / 200 = -0.1  =>  straighten = -0.1 * 90 = -9
        expect(geo().straighten).toBeCloseTo(-9);
    });

    it("adjusts perspective on mouse drag in perspective mode", () => {
        const perspBtn = screen.getByRole("button", { name: "PERSPECTIVE" });
        fireEvent.click(perspBtn);

        const overlay = screen.getByTestId("geometry-overlay");
        Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
        Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerMove(overlay, { clientX: 120, clientY: 80, pointerId: 1 });
        });
        // fx = (120 - 100) / 200 = 0.1 => perspective_h = 10
        // fy = (80 - 100) / 200 = -0.1 => perspective_v = -(-0.1 * 100) = 10
        expect(geo().perspective_h).toBeCloseTo(10);
        expect(geo().perspective_v).toBeCloseTo(10);
    });

    it("adjusts distortion on mouse drag in distortion mode", () => {
        const distBtn = screen.getByRole("button", { name: "DISTORTION" });
        fireEvent.click(distBtn);

        const overlay = screen.getByTestId("geometry-overlay");
        Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
        Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerMove(overlay, { clientX: 120, clientY: 100, pointerId: 1 });
        });
        // fx = 0.1, fy = 0 => distortion = 0.1 * 50 = 5
        expect(geo().distortion).toBeCloseTo(5);
    });

    it("pans on mouse drag in position mode once zoomed in", () => {
        act(() => press("k", true)); // zoom 1.1
        const posBtn = screen.getByRole("button", { name: "POSITION" });
        fireEvent.click(posBtn);

        const overlay = screen.getByTestId("geometry-overlay");
        Object.defineProperty(overlay, "clientWidth", { value: 200, configurable: true });
        Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
        act(() => {
            fireEvent.pointerDown(overlay, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerMove(overlay, { clientX: 80, clientY: 100, pointerId: 1 });
        });
        // fx = -0.1  =>  crop_x = 0 - (-0.1 * 2) = 0.2
        expect(geo().crop_x).toBeCloseTo(0.2);
    });

    it("switches sub-modes when clicking HUD mode pills", () => {
        const rotateBtn = screen.getByRole("button", { name: "ROTATE/ZOOM" });
        const perspBtn = screen.getByRole("button", { name: "PERSPECTIVE" });
        const distBtn = screen.getByRole("button", { name: "DISTORTION" });
        const positionBtn = screen.getByRole("button", { name: "POSITION" });

        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(perspBtn);
        expect(perspBtn).toHaveAttribute("aria-pressed", "true");
        expect(rotateBtn).toHaveAttribute("aria-pressed", "false");

        fireEvent.click(distBtn);
        expect(distBtn).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(positionBtn);
        expect(positionBtn).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(rotateBtn);
        expect(rotateBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("resets geometry when clicking the Reset button", () => {
        act(() => press("l"));
        act(() => press("k"));
        expect(geo().straighten).not.toBe(0);

        const resetBtn = screen.getByRole("button", { name: "Reset" });
        fireEvent.click(resetBtn);
        expect(geo()).toEqual({
            straighten: 0,
            zoom: 1,
            crop_x: 0,
            crop_y: 0,
            distortion: 0,
            perspective_v: 0,
            perspective_h: 0,
        });
    });

    it("exits geometry edit mode when clicking the Done button", () => {
        const doneBtn = screen.getByRole("button", { name: "Done" });
        fireEvent.click(doneBtn);
        expect(useAppState.getState().geometryEdit).toBe(false);
    });
});
