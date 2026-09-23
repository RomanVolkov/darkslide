import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lockSelection, isTextInputTarget } from "./selectionLock";
import { ActionService, CommandId } from "../services/ActionService";

describe("selectionLock", () => {
    describe("isTextInputTarget", () => {
        it("identifies text inputs as text targets", () => {
            const input = document.createElement("input");
            input.type = "text";
            expect(isTextInputTarget(input)).toBe(true);

            input.type = "search";
            expect(isTextInputTarget(input)).toBe(true);

            const textarea = document.createElement("textarea");
            expect(isTextInputTarget(textarea)).toBe(true);

            const editable = document.createElement("div");
            editable.contentEditable = "true";
            expect(isTextInputTarget(editable)).toBe(true);
        });

        it("does not treat range/checkbox/radio/buttons as text targets", () => {
            const range = document.createElement("input");
            range.type = "range";
            expect(isTextInputTarget(range)).toBe(false);

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            expect(isTextInputTarget(checkbox)).toBe(false);

            const btn = document.createElement("button");
            expect(isTextInputTarget(btn)).toBe(false);

            const div = document.createElement("div");
            expect(isTextInputTarget(div)).toBe(false);

            expect(isTextInputTarget(null)).toBe(false);
        });
    });

    describe("event listeners", () => {
        let cleanup: () => void;
        let executeSpy: any;

        beforeEach(() => {
            executeSpy = vi.spyOn(ActionService, "execute").mockResolvedValue(true);
            cleanup = lockSelection(window);
        });

        afterEach(() => {
            cleanup();
            executeSpy.mockRestore();
        });

        it("prevents selectstart on non-text elements", () => {
            const div = document.createElement("div");
            document.body.appendChild(div);

            const evt = new Event("selectstart", { cancelable: true, bubbles: true });
            div.dispatchEvent(evt);

            expect(evt.defaultPrevented).toBe(true);
            document.body.removeChild(div);
        });

        it("allows selectstart on text inputs", () => {
            const input = document.createElement("input");
            input.type = "text";
            document.body.appendChild(input);

            const evt = new Event("selectstart", { cancelable: true, bubbles: true });
            input.dispatchEvent(evt);

            expect(evt.defaultPrevented).toBe(false);
            document.body.removeChild(input);
        });

        it("clears non-text selections on selectionchange and routes to ActionService.execute", () => {
            const div = document.createElement("div");
            div.textContent = "sample text";
            document.body.appendChild(div);

            // Mock window.getSelection
            const removeAllRangesSpy = vi.fn();
            const mockSelection = {
                isCollapsed: false,
                removeAllRanges: removeAllRangesSpy,
            };
            vi.spyOn(window, "getSelection").mockReturnValue(mockSelection as any);

            // Dispatch selectionchange
            document.dispatchEvent(new Event("selectionchange"));

            expect(removeAllRangesSpy).toHaveBeenCalledTimes(1);
            expect(executeSpy).toHaveBeenCalledWith(CommandId.EditSelectAll);

            document.body.removeChild(div);
        });

        it("does not clear selection or execute select_all when activeElement is a text input", () => {
            const input = document.createElement("input");
            input.type = "text";
            document.body.appendChild(input);
            input.focus();

            const removeAllRangesSpy = vi.fn();
            const mockSelection = {
                isCollapsed: false,
                removeAllRanges: removeAllRangesSpy,
            };
            vi.spyOn(window, "getSelection").mockReturnValue(mockSelection as any);

            document.dispatchEvent(new Event("selectionchange"));

            expect(removeAllRangesSpy).not.toHaveBeenCalled();
            expect(executeSpy).not.toHaveBeenCalled();

            document.body.removeChild(input);
        });
    });
});
