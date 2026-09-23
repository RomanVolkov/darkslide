import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, it, expect, vi } from "vitest";
import { Slider } from "./Slider.tsx";

function renderSlider(overrides: Partial<Parameters<typeof Slider>[0]> = {}) {
    const props = {
        label: "Exposure",
        value: 0,
        focused: false,
        onChange: vi.fn(),
        ...overrides,
    };
    return { ...render(<Slider {...props} />), onChange: props.onChange };
}

describe("Slider", () => {
    it("renders the label", () => {
        renderSlider({ label: "Contrast" });
        expect(screen.getByText("Contrast")).toBeInTheDocument();
    });

    it("renders the raw numeric value when no format is provided", () => {
        renderSlider({ value: 42 });
        expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("renders the formatted value when format is provided", () => {
        renderSlider({ value: 0.5, format: (v) => `${v * 100}%` });
        expect(screen.getByText("50%")).toBeInTheDocument();
    });

    it("applies focused markers when focused=true", () => {
        const { container } = renderSlider({ focused: true });
        expect(container.firstChild).toHaveAttribute("data-focused", "true");
    });

    it("does not apply focused markers when focused=false", () => {
        const { container } = renderSlider({ focused: false });
        expect(container.firstChild).toHaveAttribute("data-focused", "false");
    });

    it("calls onChange with a number when the input changes", () => {
        const { onChange } = renderSlider({ value: 0 });
        const input = screen.getByRole("slider");
        fireEvent.change(input, { target: { value: "50" } });
        expect(onChange).toHaveBeenCalledWith(50);
    });

    it("passes min, max, and step to the input", () => {
        renderSlider({ min: 0, max: 200, step: 5 });
        const input = screen.getByRole("slider");
        expect(input).toHaveAttribute("min", "0");
        expect(input).toHaveAttribute("max", "200");
        expect(input).toHaveAttribute("step", "5");
    });

    it("defaults min to -100 and max to 100", () => {
        renderSlider();
        const input = screen.getByRole("slider");
        expect(input).toHaveAttribute("min", "-100");
        expect(input).toHaveAttribute("max", "100");
    });

    it("applies trackGradient as inline background style", () => {
        renderSlider({ trackGradient: "linear-gradient(to right, black, white)" });
        const input = screen.getByRole("slider");
        expect(input).toHaveStyle({ background: "linear-gradient(to right, black, white)" });
    });

    it("does not set inline background style when trackGradient is absent", () => {
        renderSlider();
        const input = screen.getByRole("slider");
        expect(input).not.toHaveAttribute("style");
    });

    it("calls onInteract when the slider is focused (mouse click)", () => {
        const onInteract = vi.fn();
        renderSlider({ onInteract });
        fireEvent.focus(screen.getByRole("slider"));
        expect(onInteract).toHaveBeenCalled();
    });

    it("calls onInteract when the slider value changes", () => {
        const onInteract = vi.fn();
        renderSlider({ onInteract });
        fireEvent.change(screen.getByRole("slider"), { target: { value: "10" } });
        expect(onInteract).toHaveBeenCalled();
    });

    it("resets value to defaultValue (or 0) on double-click", () => {
        const onChange = vi.fn();
        renderSlider({ value: 50, defaultValue: 10, onChange });
        fireEvent.dblClick(screen.getByText("Exposure"));
        expect(onChange).toHaveBeenCalledWith(10);
    });

    it("calls onReset when provided on double-click", () => {
        const onReset = vi.fn();
        const onChange = vi.fn();
        renderSlider({ value: 50, onReset, onChange });
        fireEvent.dblClick(screen.getByText("Exposure"));
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
    });
});
