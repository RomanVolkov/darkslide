import { render, screen, fireEvent, act } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../services/SessionService.ts", () => ({
    openSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    exportSession: vi.fn(async () => {}),
}));

vi.mock("../../services/FileHandlers.ts", () => ({
    loadImages: vi.fn(async () => 0),
}));

import { SessionModal } from "./SessionModal.tsx";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";
import {
    openSession,
    renameSession,
    deleteSession,
    exportSession,
} from "../../services/SessionService.ts";
import { loadImages } from "../../services/FileHandlers.ts";
import { useAppState } from "../../state/appState.ts";
import { ImageProcessor } from "../../services/ImageProcessor.ts";

const processor = {} as ImageProcessor;

const SESSIONS = [
    { id: 1, name: "iceland", image_count: 3, updated_at: new Date().toISOString() },
    { id: 2, name: "Fuji trip", image_count: 10, updated_at: new Date().toISOString() },
    { id: 3, name: "night shoot", image_count: 1, updated_at: new Date().toISOString() },
    { id: 4, name: "paris 2024", image_count: 5, updated_at: new Date().toISOString() },
];

function renderModal(overrides: Partial<Parameters<typeof SessionModal>[0]> = {}) {
    const props = { processor, onClose: vi.fn(), ...overrides };
    const result = render(<SessionModal {...props} />);
    return { ...result, ...props };
}

function makeKeydown(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    const body = document.createElement("div");
    const evt = new KeyboardEvent("keydown", { key, bubbles: true, ...overrides });
    Object.defineProperty(evt, "target", { value: body, writable: false });
    return evt;
}

function press(key: string) {
    act(() => { keyboardManager.dispatch(makeKeydown(key)); });
}

/** Type into the focused search input the way a user would. */
function type(value: string) {
    const input = screen.getByPlaceholderText("Search sessions...");
    act(() => { fireEvent.change(input, { target: { value } }); });
    return input;
}

function toNav() {
    press("Tab");
}

describe("SessionModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useAppState.setState({
            sessions: SESSIONS.map((s) => ({ ...s })),
            sessionId: 2,
        });
    });

    afterEach(() => {
        try { keyboardManager.unregister(RegistrationID.session); } catch {}
    });

    it("renders sessions with image counts", () => {
        renderModal();
        expect(screen.getByText("iceland")).toBeInTheDocument();
        expect(screen.getByText("Fuji trip")).toBeInTheDocument();
        expect(screen.getByText(/3 images/)).toBeInTheDocument();
        expect(screen.getByText(/1 image/)).toBeInTheDocument();
    });

    it("renders an empty state when there are no sessions", () => {
        useAppState.setState({ sessions: [] });
        renderModal();
        expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    });

    it("filters rows by fuzzy subsequence as you type", () => {
        renderModal();
        type("fuji");
        expect(screen.getByText("Fuji trip")).toBeInTheDocument();
        expect(screen.queryByText("iceland")).not.toBeInTheDocument();
    });

    it("matches numeric session names", () => {
        renderModal();
        type("2024");
        expect(screen.getByText("paris 2024")).toBeInTheDocument();
        expect(screen.queryByText("iceland")).not.toBeInTheDocument();
    });

    it("shows no matches when the filter matches nothing", () => {
        renderModal();
        type("zzz");
        expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    it("clears the query when clicking the X button", () => {
        renderModal();
        const input = type("fuji");
        fireEvent.click(screen.getByLabelText("Clear search"));
        expect(input).toHaveValue("");
    });

    // --- search mode ---

    it("Esc in search mode closes the modal", () => {
        const { onClose } = renderModal();
        press("Escape");
        expect(onClose).toHaveBeenCalled();
    });

    it("Enter in search mode opens when only one match", async () => {
        const { onClose } = renderModal();
        type("2024");
        press("Enter");
        await act(async () => { await Promise.resolve(); });
        expect(openSession).toHaveBeenCalledWith(4, processor);
        expect(onClose).toHaveBeenCalled();
    });

    it("Enter in search mode does nothing when multiple matches", () => {
        const { onClose } = renderModal();
        press("Enter");
        expect(openSession).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("letter verbs type in search mode instead of firing (E does not export)", () => {
        renderModal();
        press("E");
        press("N");
        expect(exportSession).not.toHaveBeenCalled();
        expect(loadImages).not.toHaveBeenCalled();
    });

    // --- nav mode ---

    it("Tab toggles to nav mode and back (focus follows)", () => {
        renderModal();
        const input = screen.getByPlaceholderText("Search sessions...");
        expect(document.activeElement).toBe(input);

        toNav();
        expect(document.activeElement).not.toBe(input);

        toNav();
        expect(document.activeElement).toBe(input);
    });

    it("j/k moves the selection and Enter opens the session", async () => {
        const { onClose } = renderModal();
        toNav();
        press("j"); // index 1 → Fuji trip
        press("k"); // back to index 0
        press("j"); // index 1
        press("Enter");
        await act(async () => { await Promise.resolve(); });
        expect(openSession).toHaveBeenCalledWith(2, processor);
        expect(onClose).toHaveBeenCalled();
    });

    it("E in nav mode exports the highlighted session and closes", () => {
        const { onClose } = renderModal();
        toNav();
        press("E");
        expect(exportSession).toHaveBeenCalledWith(1, processor);
        expect(onClose).toHaveBeenCalled();
    });

    it("e in nav mode exports the highlighted session and closes", () => {
        const { onClose } = renderModal();
        toNav();
        press("e");
        expect(exportSession).toHaveBeenCalledWith(1, processor);
        expect(onClose).toHaveBeenCalled();
    });

    it("Cmd+E in search mode exports the highlighted session and closes", () => {
        const { onClose } = renderModal();
        act(() => {
            keyboardManager.dispatch(makeKeydown("e", { metaKey: true }));
        });
        expect(exportSession).toHaveBeenCalledWith(1, processor);
        expect(onClose).toHaveBeenCalled();
    });

    it("N in nav mode opens the picker and creates a new session", () => {
        const { onClose } = renderModal();
        toNav();
        press("N");
        expect(loadImages).toHaveBeenCalledWith(null, useAppState, processor, true, true);
        expect(onClose).toHaveBeenCalled();
    });

    it("x in nav mode clears the query", () => {
        renderModal();
        const input = type("fuji");
        toNav();
        press("x");
        expect(input).toHaveValue("");
    });

    it("Esc in nav mode closes the modal", () => {
        const { onClose } = renderModal();
        toNav();
        press("Escape");
        expect(onClose).toHaveBeenCalled();
    });

    it("r in nav mode enters rename, Enter commits", () => {
        renderModal();
        toNav();
        press("r");
        const input = screen.getByDisplayValue("iceland");
        fireEvent.change(input, { target: { value: "new name" } });
        press("Enter");
        expect(renameSession).toHaveBeenCalledWith(1, "new name");
    });

    it("Esc cancels rename without calling the backend", () => {
        const { onClose } = renderModal();
        toNav();
        press("r");
        press("Escape");
        expect(renameSession).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByDisplayValue("iceland")).not.toBeInTheDocument();
    });

    it("rejects a blank rename with an inline hint", () => {
        renderModal();
        toNav();
        press("r");
        const input = screen.getByDisplayValue("iceland");
        fireEvent.change(input, { target: { value: "   " } });
        press("Enter");
        expect(renameSession).not.toHaveBeenCalled();
        expect(screen.getByText("Name cannot be empty")).toBeInTheDocument();
    });

    it("d in nav mode opens the confirm strip and d confirms the delete", () => {
        renderModal();
        toNav();
        press("d");
        expect(screen.getByText(/Delete iceland\?/)).toBeInTheDocument();
        press("d");
        expect(deleteSession).toHaveBeenCalledWith(1);
    });

    it("c cancels a pending delete", () => {
        renderModal();
        toNav();
        press("d");
        press("c");
        expect(deleteSession).not.toHaveBeenCalled();
    });

    it("clicks + New Session button to trigger new session creation", () => {
        const { onClose } = renderModal();
        const newBtn = screen.getByTestId("new-session-btn");
        fireEvent.click(newBtn);
        expect(loadImages).toHaveBeenCalledWith(null, useAppState, processor, true, true);
        expect(onClose).toHaveBeenCalled();
    });

    it("confirms and cancels delete using clickable buttons in delete strip", () => {
        renderModal();
        toNav();
        press("d");
        expect(screen.getByText(/Delete iceland\?/)).toBeInTheDocument();

        // Click Cancel button
        const cancelBtn = screen.getByTestId("session-cancel-delete-btn");
        fireEvent.click(cancelBtn);
        expect(screen.queryByText(/Delete iceland\?/)).not.toBeInTheDocument();
        expect(deleteSession).not.toHaveBeenCalled();

        // Open delete strip again and click Confirm button
        press("d");
        const confirmBtn = screen.getByTestId("session-confirm-delete-btn");
        fireEvent.click(confirmBtn);
        expect(deleteSession).toHaveBeenCalledWith(1);
    });

    it("opens right-click context menu and triggers actions", () => {
        renderModal();
        const row = screen.getByText("Fuji trip");
        fireEvent.contextMenu(row, { clientX: 200, clientY: 200 });

        expect(screen.getByTestId("context-menu")).toBeTruthy();
        expect(screen.getByText("Open")).toBeTruthy();
        expect(screen.getByText("Rename")).toBeTruthy();
        expect(screen.getByText("Export All")).toBeTruthy();
        expect(screen.getByText("Delete")).toBeTruthy();

        // Click Rename
        fireEvent.click(screen.getByText("Rename"));
        expect(screen.getByDisplayValue("Fuji trip")).toBeInTheDocument();
    });
});
