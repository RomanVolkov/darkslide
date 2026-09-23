import { render, screen, act, fireEvent } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColorWheel } from "./ColorWheel.tsx";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import { DEFAULT_COLOR_BALANCE } from "../../types/adjustments.ts";
import type { ColorBalance } from "../../backend/types.ts";
import { Key } from "../constants/index.ts";

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
    const evt = new KeyboardEvent("keydown", { key, bubbles: true, ...opts });
    const target = document.createElement("div");
    Object.defineProperty(evt, "target", { value: target, writable: false });
    keyboardManager.dispatch(evt);
}

describe("ColorWheel Component", () => {
    let balance: ColorBalance;
    let onChange: (next: ColorBalance) => void;
    let onExit: () => void;
    let onActivate: () => void;

    beforeEach(() => {
        balance = structuredClone(DEFAULT_COLOR_BALANCE);
        onChange = vi.fn((next) => {
            balance = next;
        });
        onExit = vi.fn();
        onActivate = vi.fn();
    });

    afterEach(() => {
        keyboardManager.unregister(RegistrationID.colorBalance);
    });

    it("renders tabs, wheel disc, puck, and luminance slider", () => {
        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={false}
                focused={false}
                onActivate={onActivate}
                onExit={onExit}
            />
        );

        expect(screen.getByRole("tab", { name: /Shadows/ })).toBeDefined();
        expect(screen.getByRole("tab", { name: /Midtones/ })).toBeDefined();
        expect(screen.getByRole("tab", { name: /Highlights/ })).toBeDefined();
        expect(screen.getByTestId("color-wheel-disc")).toBeDefined();
        expect(screen.getByTestId("color-wheel-puck")).toBeDefined();
        expect(screen.getByTestId("color-wheel-readout").textContent).toMatch(/H:\s*0°\s+S:\s*0%\s+L:\s*0/);
    });

    it("shows edit dot indicators when tones are modified", () => {
        balance.shadows.saturation = 35;
        balance.highlights.luminance = -20;

        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={false}
                focused={false}
            />
        );

        expect(screen.getByTestId("dot-shadows")).toBeDefined();
        expect(screen.queryByTestId("dot-midtones")).toBeNull();
        expect(screen.getByTestId("dot-highlights")).toBeDefined();
    });

    it("switches active tone when tab is clicked", () => {
        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={false}
                focused={false}
                onActivate={onActivate}
            />
        );

        const shadowsTab = screen.getByRole("tab", { name: /Shadows/ });
        act(() => {
            shadowsTab.click();
        });

        expect(shadowsTab.getAttribute("aria-selected")).toBe("true");
        expect(onActivate).toHaveBeenCalled();
    });

    it("updates luminance value on slider input", () => {
        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={false}
                focused={false}
            />
        );

        const slider = screen.getByTestId("color-wheel-luminance");
        act(() => {
            fireEvent.change(slider, { target: { value: "45" } });
        });

        expect(onChange).toHaveBeenCalled();
        expect(balance.midtones.luminance).toBe(45);
    });

    it("handles keyboard navigation and adjustments when active", () => {
        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={true}
                focused={true}
                onExit={onExit}
            />
        );

        // 1 switches to shadows
        act(() => press(Key.One));
        expect(screen.getByRole("tab", { name: /Shadows/ }).getAttribute("aria-selected")).toBe("true");

        // 3 switches to highlights
        act(() => press(Key.Three));
        expect(screen.getByRole("tab", { name: /Highlights/ }).getAttribute("aria-selected")).toBe("true");

        // Tab cycles to shadows
        act(() => press(Key.Tab));
        expect(screen.getByRole("tab", { name: /Shadows/ }).getAttribute("aria-selected")).toBe("true");

        // Enter dives into wheel editing (Layer 2)
        act(() => press(Key.Enter));
        expect(screen.getByTestId("color-wheel-disc").getAttribute("data-editing")).toBe("true");

        // l increases hue by 2
        act(() => press(Key.l));
        expect(onChange).toHaveBeenCalled();
        expect(balance.shadows.hue).toBe(2);

        // k increases saturation by 1 on wheel
        act(() => press(Key.k));
        expect(balance.shadows.saturation).toBe(1);

        // Escape exits wheel editing back to section (Layer 1)
        act(() => press(Key.Escape));
        expect(screen.getByTestId("color-wheel-disc").getAttribute("data-editing")).toBe("false");

        // j moves focus down to luminance slider
        act(() => press(Key.j));

        // l increases luminance by 1
        act(() => press(Key.l));
        expect(balance.shadows.luminance).toBe(1);

        // x resets luminance
        act(() => press(Key.x));
        expect(balance.shadows.luminance).toBe(0);

        // k moves focus back up to wheel
        act(() => press(Key.k));

        // x resets wheel
        act(() => press(Key.x));
        expect(balance.shadows.hue).toBe(0);
        expect(balance.shadows.saturation).toBe(0);

        // Escape calls onExit from Layer 1
        act(() => press(Key.Escape));
        expect(onExit).toHaveBeenCalled();
    });

    it("handles Shift stepping and 2-layer focus navigation", () => {
        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={true}
                focused={true}
                onExit={onExit}
            />
        );

        // Enter dives into wheel editing
        act(() => press(Key.Enter));

        // Shift+l increases hue by 15
        act(() => press(Key.l, { shiftKey: true }));
        expect(balance.midtones.hue).toBe(15);

        // Shift+k increases saturation by 10
        act(() => press(Key.k, { shiftKey: true }));
        expect(balance.midtones.saturation).toBe(10);

        // Escape exits wheel editing back to Layer 1
        act(() => press(Key.Escape));

        // j moves focus to luminance slider
        act(() => press(Key.j));

        // Shift+l increases luminance by 10 on slider
        act(() => press(Key.l, { shiftKey: true }));
        expect(balance.midtones.luminance).toBe(10);

        // Escape calls onExit
        act(() => press(Key.Escape));
        expect(onExit).toHaveBeenCalled();
    });

    it("resets values on double-click", () => {
        balance.midtones.hue = 120;
        balance.midtones.saturation = 60;
        balance.midtones.luminance = -30;

        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={false}
                focused={false}
            />
        );

        // Double click wheel resets saturation to 0
        const disc = screen.getByTestId("color-wheel-disc");
        act(() => {
            fireEvent.dblClick(disc);
        });
        expect(balance.midtones.saturation).toBe(0);

        // Double click slider resets luminance to 0
        const slider = screen.getByTestId("color-wheel-luminance");
        act(() => {
            fireEvent.dblClick(slider);
        });
        expect(balance.midtones.luminance).toBe(0);
    });

    it("resets all tones on Shift+X", () => {
        balance.shadows.saturation = 50;
        balance.midtones.luminance = 20;
        balance.highlights.hue = 200;

        render(
            <ColorWheel
                value={balance}
                onChange={onChange}
                active={true}
                focused={true}
            />
        );

        act(() => press(Key.X, { shiftKey: true }));
        expect(balance.shadows.saturation).toBe(0);
        expect(balance.midtones.luminance).toBe(0);
        expect(balance.highlights.hue).toBe(0);
    });
});
