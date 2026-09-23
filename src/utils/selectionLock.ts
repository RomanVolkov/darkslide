import { ActionService, CommandId } from "../services/ActionService.ts";

export function isTextInputTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    if (target instanceof HTMLInputElement) {
        return target.type !== "range" && target.type !== "checkbox" && target.type !== "radio";
    }
    if (target instanceof HTMLTextAreaElement) {
        return true;
    }
    if (target instanceof HTMLElement && (target.isContentEditable || target.contentEditable === "true" || target.getAttribute("contenteditable") === "true")) {
        return true;
    }
    return false;
}

export function lockSelection(target: Window = window): () => void {
    const onSelectStart = (e: Event) => {
        if (!isTextInputTarget(e.target)) {
            e.preventDefault();
        }
    };

    const onSelectionChange = () => {
        const doc = target.document;
        const active = doc?.activeElement;
        if (!isTextInputTarget(active)) {
            const sel = target.getSelection();
            if (sel && !sel.isCollapsed) {
                sel.removeAllRanges();
                ActionService.execute(CommandId.EditSelectAll);
            }
        }
    };

    target.document.addEventListener("selectstart", onSelectStart);
    target.document.addEventListener("selectionchange", onSelectionChange);

    return () => {
        target.document.removeEventListener("selectstart", onSelectStart);
        target.document.removeEventListener("selectionchange", onSelectionChange);
    };
}
