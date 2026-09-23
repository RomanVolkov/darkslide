import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/preact";
import { SelectiveColorPanel, CHANNELS } from "./SelectiveColorPanel.tsx";
import { DEFAULT_SELECTIVE_COLOR } from "../../types/adjustments.ts";
import type { SelectiveColor } from "../../backend/types.ts";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { Key } from "../constants/index.ts";

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
    const evt = new KeyboardEvent("keydown", { key, bubbles: true, ...opts });
    const target = document.createElement("div");
    Object.defineProperty(evt, "target", { value: target, writable: false });
    keyboardManager.dispatch(evt);
}

describe("SelectiveColorPanel Component", () => {
    let selective: SelectiveColor;
    let mockOnChange: Mock<(next: SelectiveColor) => void>;
    let mockOnActivate: Mock<() => void>;
    let mockOnExit: Mock<() => void>;

    beforeEach(() => {
        selective = structuredClone(DEFAULT_SELECTIVE_COLOR);
        mockOnChange = vi.fn((next: SelectiveColor) => {
            selective = next;
        });
        mockOnActivate = vi.fn();
        mockOnExit = vi.fn();
        keyboardManager.unregister(RegistrationID.selectiveColor);
    });

    afterEach(() => {
        keyboardManager.unregister(RegistrationID.selectiveColor);
    });

    it("renders all 8 color swatches and 3 sliders", () => {
        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={false}
                focused={false}
            />
        );

        // Check 8 chips exist
        CHANNELS.forEach((ch) => {
            const swatch = screen.getByTestId(`swatch-${ch.key}`);
            expect(swatch).toBeDefined();
        });

        // Check active channel header starts at Red
        const header = screen.getByTestId("active-channel-label");
        expect(header.textContent).toBe("Red");

        // Check 3 sliders
        expect(screen.getByText("Hue")).toBeDefined();
        expect(screen.getByText("Saturation")).toBeDefined();
        expect(screen.getByText("Luminance")).toBeDefined();
    });

    it("shows edit dot indicator when channel has non-zero edits", () => {
        selective.blue = { hue: 15, saturation: -20, luminance: 0 };

        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={false}
                focused={false}
            />
        );

        const blueDot = screen.queryByTestId("edit-dot-blue");
        expect(blueDot).not.toBeNull();

        const redDot = screen.queryByTestId("edit-dot-red");
        expect(redDot).toBeNull();
    });

    it("switches active channel on swatch click and calls onActivate", () => {
        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={false}
                focused={false}
                onActivate={mockOnActivate}
            />
        );

        const greenChip = screen.getByTestId("swatch-green");
        fireEvent.click(greenChip);

        expect(mockOnActivate).toHaveBeenCalled();
        const header = screen.getByTestId("active-channel-label");
        expect(header.textContent).toBe("Green");
    });

    it("updates channel slider values on slider change", () => {
        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={false}
                focused={false}
            />
        );

        const sliders = screen.getAllByRole("slider");
        expect(sliders.length).toBe(3);

        // Change Hue slider (first slider)
        act(() => {
            fireEvent.change(sliders[0]!, { target: { value: "35" } });
        });
        expect(mockOnChange).toHaveBeenCalled();
        expect(selective.red.hue).toBe(35);
    });

    it("handles keyboard channel switching and slider adjustments when active", () => {
        const { rerender } = render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
                onExit={mockOnExit}
            />
        );

        // Press '4' to select Green (index 3)
        act(() => press(Key.Four));
        const header = screen.getByTestId("active-channel-label");
        expect(header.textContent).toBe("Green");

        // Press 'l' to increment Hue by 1
        act(() => press(Key.l));
        expect(mockOnChange).toHaveBeenCalled();
        expect(selective.green.hue).toBe(1);

        // Re-render with updated selective state
        rerender(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
                onExit={mockOnExit}
            />
        );

        // Press 'h' twice to decrement Hue
        act(() => press(Key.h));
        rerender(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
                onExit={mockOnExit}
            />
        );
        act(() => press(Key.h));
        expect(selective.green.hue).toBe(-1);
    });

    it("supports Tab to cycle color and j/k to cycle slider focus, and Shift step", () => {
        const { rerender } = render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
                onExit={mockOnExit}
            />
        );

        // Tab moves to Orange channel
        act(() => press(Key.Tab));
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Orange");

        // j moves slider focus from Hue to Saturation
        act(() => press(Key.j));

        // Shift+l increments Saturation by 10
        act(() => press(Key.l, { shiftKey: true }));
        expect(mockOnChange).toHaveBeenCalled();
        expect(selective.orange.saturation).toBe(10);

        rerender(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
                onExit={mockOnExit}
            />
        );

        // j moves slider focus to Luminance
        act(() => press(Key.j));

        // Shift+h decrements Luminance by 10
        act(() => press(Key.h, { shiftKey: true }));
        expect(selective.orange.luminance).toBe(-10);

        // Escape triggers exit
        act(() => press(Key.Escape));
        expect(mockOnExit).toHaveBeenCalled();
    });

    it("resets active channel on x and double-click", () => {
        selective.red = { hue: 25, saturation: 50, luminance: -10 };

        const { rerender } = render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
            />
        );

        // Press 'x' to reset active channel (red)
        act(() => press(Key.x));
        expect(mockOnChange).toHaveBeenCalled();
        expect(selective.red.hue).toBe(0);
        expect(selective.red.saturation).toBe(0);
        expect(selective.red.luminance).toBe(0);

        // Set blue edits and double click blue chip
        selective.blue = { hue: 30, saturation: 40, luminance: 50 };
        rerender(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
            />
        );

        const blueChip = screen.getByTestId("swatch-blue");
        act(() => {
            fireEvent.dblClick(blueChip);
        });
        expect(selective.blue.hue).toBe(0);
        expect(selective.blue.saturation).toBe(0);
        expect(selective.blue.luminance).toBe(0);
    });

    it("resets all channels on Shift+X", () => {
        selective.red = { hue: 25, saturation: 50, luminance: -10 };
        selective.blue = { hue: -10, saturation: 20, luminance: 30 };

        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
            />
        );

        act(() => press(Key.X, { shiftKey: true }));
        expect(mockOnChange).toHaveBeenCalled();
        expect(selective.red.hue).toBe(0);
        expect(selective.blue.hue).toBe(0);
        expect(selective.orange.hue).toBe(0);
        expect(selective.green.hue).toBe(0);
    });

    it("cycles swatches using [ and ] keys", () => {
        render(
            <SelectiveColorPanel
                value={selective}
                onChange={mockOnChange}
                active={true}
                focused={true}
            />
        );

        // Initial channel is Red (index 0)
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Red");

        // Press ']' moves to Orange (index 1)
        act(() => press(Key.BracketRight));
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Orange");

        // Press '[' moves back to Red
        act(() => press(Key.BracketLeft));
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Red");

        // Press '[' wraps around to Magenta (index 7)
        act(() => press(Key.BracketLeft));
        expect(screen.getByTestId("active-channel-label").textContent).toBe("Magenta");
    });
});
