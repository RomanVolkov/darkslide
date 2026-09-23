import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EraseConfirmModal } from "./EraseConfirmModal.tsx";
import { keyboardManager } from "../../services/KeyboardManager.ts";

function makeKeydown(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    const body = document.createElement("div");
    const evt = new KeyboardEvent("keydown", { key, bubbles: true, ...overrides });
    Object.defineProperty(evt, "target", { value: body, writable: false });
    return evt;
}

describe("EraseConfirmModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders confirmation prompt and buttons", () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        render(<EraseConfirmModal onConfirm={onConfirm} onClose={onClose} />);

        expect(screen.getByText("Erase All Adjustments")).toBeInTheDocument();
        expect(screen.getByText("Erase all adjustments from database?")).toBeInTheDocument();
        expect(screen.getByText("O=OK C=Cancel")).toBeInTheDocument();
        expect(screen.getByText("Cancel (C)")).toBeInTheDocument();
        expect(screen.getByText("Erase (O)")).toBeInTheDocument();
    });

    it("calls onConfirm when Erase button is clicked", () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        render(<EraseConfirmModal onConfirm={onConfirm} onClose={onClose} />);

        fireEvent.click(screen.getByText("Erase (O)"));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose when Cancel button is clicked", () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        render(<EraseConfirmModal onConfirm={onConfirm} onClose={onClose} />);

        fireEvent.click(screen.getByText("Cancel (C)"));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it("calls onConfirm when pressing o or Enter key", () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        render(<EraseConfirmModal onConfirm={onConfirm} onClose={onClose} />);

        keyboardManager.dispatch(makeKeydown("o"));
        expect(onConfirm).toHaveBeenCalledTimes(1);

        keyboardManager.dispatch(makeKeydown("Enter"));
        expect(onConfirm).toHaveBeenCalledTimes(2);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose when pressing c or Escape key", () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        render(<EraseConfirmModal onConfirm={onConfirm} onClose={onClose} />);

        keyboardManager.dispatch(makeKeydown("c"));
        expect(onClose).toHaveBeenCalledTimes(1);

        keyboardManager.dispatch(makeKeydown("Escape"));
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(onConfirm).not.toHaveBeenCalled();
    });
});
