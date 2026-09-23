import { render, screen, fireEvent } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";

describe("ContextMenu", () => {
    it("renders items with labels and shortcuts", () => {
        const items: ContextMenuItem[] = [
            { id: "copy", label: "Copy Adjustments", shortcut: "⌘C" },
            { id: "sep", label: "", separator: true },
            { id: "delete", label: "Delete", destructive: true, shortcut: "⌫" },
        ];
        render(<ContextMenu items={items} x={100} y={100} onClose={vi.fn()} />);

        expect(screen.getByText("Copy Adjustments")).toBeTruthy();
        expect(screen.getByText("⌘C")).toBeTruthy();
        expect(screen.getByText("Delete")).toBeTruthy();
        expect(screen.getByRole("separator")).toBeTruthy();
    });

    it("triggers item onClick and closes when clicked", () => {
        const onClick = vi.fn();
        const onClose = vi.fn();
        const items: ContextMenuItem[] = [
            { id: "test", label: "Test Action", onClick },
        ];
        render(<ContextMenu items={items} x={50} y={50} onClose={onClose} />);

        fireEvent.click(screen.getByText("Test Action"));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not trigger disabled items", () => {
        const onClick = vi.fn();
        const onClose = vi.fn();
        const items: ContextMenuItem[] = [
            { id: "test", label: "Disabled Action", disabled: true, onClick },
        ];
        render(<ContextMenu items={items} x={50} y={50} onClose={onClose} />);

        fireEvent.click(screen.getByText("Disabled Action"));
        expect(onClick).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("closes on Escape key", () => {
        const onClose = vi.fn();
        render(<ContextMenu items={[{ id: "1", label: "One" }]} x={50} y={50} onClose={onClose} />);

        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("navigates with ArrowDown and activates with Enter", () => {
        const onClickFirst = vi.fn();
        const onClickSecond = vi.fn();
        const onClose = vi.fn();
        const items: ContextMenuItem[] = [
            { id: "1", label: "Item 1", onClick: onClickFirst },
            { id: "sep", label: "", separator: true },
            { id: "2", label: "Item 2", onClick: onClickSecond },
        ];
        render(<ContextMenu items={items} x={50} y={50} onClose={onClose} />);

        // Arrow down to first item
        fireEvent.keyDown(window, { key: "ArrowDown" });
        // Arrow down to second item (skipping separator)
        fireEvent.keyDown(window, { key: "ArrowDown" });

        // Press Enter
        fireEvent.keyDown(window, { key: "Enter" });
        expect(onClickSecond).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on outside click", () => {
        const onClose = vi.fn();
        render(<ContextMenu items={[{ id: "1", label: "Item" }]} x={50} y={50} onClose={onClose} />);

        fireEvent.pointerDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
