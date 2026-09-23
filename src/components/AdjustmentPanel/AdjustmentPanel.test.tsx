import { render, screen, act, fireEvent } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import { AdjustmentPanel } from "./AdjustmentPanel.tsx";
import { useAppState } from "../../state/appState.ts";
import { lutState, LutItem } from "../../state/lutState.ts";
import { DEFAULT_ADJUSTMENTS } from "../../types/adjustments.ts";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { LUT_NAV_INDEX } from "../Slider/sliderConfig.ts";

function press(key: string, target: EventTarget = document.createElement("div")) {
    const evt = new KeyboardEvent("keydown", { key, bubbles: true });
    Object.defineProperty(evt, "target", { value: target, writable: false });
    keyboardManager.dispatch(evt);
}

describe("AdjustmentPanel", () => {
    beforeEach(() => {
        useAppState.setState({
            images: [{ id: "a", filename: "a.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) }],
            activeIndex: 0,
        });
    });

    it("renders the section headers and rows", () => {
        render(<AdjustmentPanel focused={true} />);
        expect(screen.getByText("Light")).toBeTruthy();
        expect(screen.getByText("Color")).toBeTruthy();
        expect(screen.getByText("Geometry")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Denoise" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Grain" })).toBeTruthy();
        expect(screen.getByText("Crop & Straighten…")).toBeTruthy();
        expect(screen.getByText("Auto WB")).toBeTruthy();
    });

    it("survives adjustments missing nested fields (legacy data)", () => {
        const partial = structuredClone(DEFAULT_ADJUSTMENTS) as Record<string, unknown>;
        delete partial.curves;
        delete partial.geometry;
        delete (partial.detail as Record<string, unknown>).denoise;
        useAppState.setState({
            images: [{ id: "a", filename: "a.jpg", adjustments: partial as never }],
            activeIndex: 0,
        });
        render(<AdjustmentPanel focused={false} />);
        expect(screen.getByText("Light")).toBeTruthy();
        expect(screen.getByText("Crop & Straighten…")).toBeTruthy();
    });

    it("stays visible when activeIndex is out of range", () => {
        useAppState.setState({
            images: [
                { id: "a", filename: "a.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) },
                { id: "b", filename: "b.jpg", adjustments: structuredClone(DEFAULT_ADJUSTMENTS) },
            ],
            activeIndex: 99,
        });
        render(<AdjustmentPanel focused={false} />);
        expect(screen.getByTestId("adjustments-panel")).toBeTruthy();
        expect(screen.getByText("Light")).toBeTruthy();
    });

    it("resets geometry with x while the geometry row is focused", () => {
        useAppState.setState({
            images: [{
                id: "a",
                filename: "a.jpg",
                adjustments: {
                    ...structuredClone(DEFAULT_ADJUSTMENTS),
                    geometry: { straighten: 10, zoom: 1.5, crop_x: 0.2, crop_y: 0.1, distortion: 12, perspective_v: 8, perspective_h: -4 },
                },
            }],
            activeIndex: 0,
        });
        render(<AdjustmentPanel focused={true} />);
        keyboardManager.setActive(RegistrationID.adjustments);

        act(() => press("x"));

        expect(useAppState.getState().images[0]!.adjustments.geometry).toEqual({
            straighten: 0,
            zoom: 1,
            crop_x: 0,
            crop_y: 0,
            distortion: 0,
            perspective_v: 0,
            perspective_h: 0,
        });
        keyboardManager.unregister(RegistrationID.adjustments);
    });

    it("keeps keyboard focus on the LUT modal after clicking inside it", () => {
        lutState.setState({
            items: [new LutItem(7, "Only LUT")],
            isLoading: false,
            isMutating: false,
            error: null,
        });
        render(<AdjustmentPanel focused={true} />);
        keyboardManager.setActive(RegistrationID.adjustments);

        // Navigate to the LUT row and open the modal with Enter. One key per
        // act() so the panel's `useLatest` ref updates between presses.
        for (let i = 0; i < LUT_NAV_INDEX; i++) {
            act(() => press("j"));
        }
        act(() => press("Enter"));

        const input = screen.getByPlaceholderText("Search LUTs...");
        expect(keyboardManager.getActive()).toBe(RegistrationID.lut);

        // Clicking inside the modal must not hand the keyboard back to the panel.
        act(() => { fireEvent.pointerDown(input, { bubbles: true }); });
        expect(keyboardManager.getActive()).toBe(RegistrationID.lut);

        // Enter then selects the only match.
        act(() => press("Enter", input));
        expect(useAppState.getState().images[0]!.adjustments.lut_id).toBe(7);

        keyboardManager.unregister(RegistrationID.lut);
        keyboardManager.unregister(RegistrationID.adjustments);
        lutState.setState({ items: [] });
    });
});
