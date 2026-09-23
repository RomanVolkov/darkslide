import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HelpModal } from "./HelpModal.tsx";
import { keyboardManager } from "../../services/KeyboardManager.ts";
import { SECTION_ORDER } from "../../services/commandDefinitions.ts";

function makeKeydown(key: string): KeyboardEvent {
    const body = document.createElement("div");
    const evt = new KeyboardEvent("keydown", { key, bubbles: true });
    Object.defineProperty(evt, "target", { value: body, writable: false });
    return evt;
}

describe("HelpModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders all sections from command definitions", () => {
        const onClose = vi.fn();
        render(<HelpModal onClose={onClose} />);

        expect(screen.getByText("Help")).toBeInTheDocument();
        for (const section of SECTION_ORDER) {
            expect(screen.getByText(section)).toBeInTheDocument();
        }

        expect(screen.getByText("add images")).toBeInTheDocument();
        expect(screen.getByText("export")).toBeInTheDocument();
        expect(screen.getByText("sessions")).toBeInTheDocument();
    });

    it("closes when clicking overlay", () => {
        const onClose = vi.fn();
        const { container } = render(<HelpModal onClose={onClose} />);

        const overlay = container.firstElementChild as HTMLElement;
        fireEvent.click(overlay);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes when pressing Escape or Question", () => {
        const onClose = vi.fn();
        render(<HelpModal onClose={onClose} />);

        keyboardManager.dispatch(makeKeydown("Escape"));
        expect(onClose).toHaveBeenCalledTimes(1);

        keyboardManager.dispatch(makeKeydown("?"));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
