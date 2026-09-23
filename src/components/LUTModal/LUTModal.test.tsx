import { render, screen, fireEvent, act } from "@testing-library/preact";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LUTModal } from "./LUTModal.tsx";
import { keyboardManager, RegistrationID } from "../../services/KeyboardManager.ts";

vi.mock("../../services/LutImporter.ts", () => ({
    pickLutFile: vi.fn(),
}));

import { pickLutFile } from "../../services/LutImporter.ts";

const SAMPLE_LUTS = [
    { id: 1, name: "Kodak Portra 400" },
    { id: 2, name: "Fuji Velvia 50" },
    { id: 3, name: "Cinestill 800T" },
    { id: 4, name: "Kodak Cotton" },
];

function renderModal(overrides: Partial<Parameters<typeof LUTModal>[0]> = {}) {
    const props = {
        luts: SAMPLE_LUTS,
        selectedId: null,
        onSelectLut: vi.fn(),
        onDeleteLut: vi.fn(),
        onImportLut: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
    const result = render(<LUTModal {...props} />);
    return { ...result, ...props };
}

function makeKeydown(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    const body = document.createElement("div");
    const evt = new KeyboardEvent("keydown", { key, bubbles: true, ...overrides });
    Object.defineProperty(evt, "target", { value: body, writable: false });
    return evt;
}

describe("LUTModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        try { keyboardManager.unregister(RegistrationID.lut); } catch {}
    });

    it("renders all LUT names when query is empty", () => {
        renderModal();
        SAMPLE_LUTS.forEach((lut) => {
            expect(screen.getByText(lut.name)).toBeInTheDocument();
        });
    });

    it("renders the key hints footer", () => {
        renderModal();
        expect(screen.getByText("Tab=Search/Nav")).toBeInTheDocument();
        expect(screen.getByText("J/K=Select")).toBeInTheDocument();
        expect(screen.getByText("Enter=Apply")).toBeInTheDocument();
        expect(screen.getByText("Esc=Close")).toBeInTheDocument();
    });

    it("filters list when typing into the search input", () => {
        renderModal();
        const input = screen.getByPlaceholderText("Search LUTs...");
        fireEvent.change(input, { target: { value: "Kodak" } });
        expect(screen.getByText("Kodak Portra 400")).toBeInTheDocument();
        expect(screen.getByText("Kodak Cotton")).toBeInTheDocument();
        expect(screen.queryByText("Fuji Velvia 50")).not.toBeInTheDocument();
        expect(screen.queryByText("Cinestill 800T")).not.toBeInTheDocument();
    });

    it("shows no matches when filter matches nothing", () => {
        renderModal();
        const input = screen.getByPlaceholderText("Search LUTs...");
        fireEvent.change(input, { target: { value: "zzz" } });
        expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    it("calls onClose on overlay click", () => {
        const { onClose, container } = renderModal();
        const overlay = container.querySelector('[class*="overlay"]');
        if (overlay) fireEvent.click(overlay);
        expect(onClose).toHaveBeenCalled();
    });

    it("calls onSelectLut and onClose when clicking a row", () => {
        const { onSelectLut, onClose } = renderModal();
        fireEvent.click(screen.getByText("Fuji Velvia 50"));
        expect(onSelectLut).toHaveBeenCalledWith(2);
        expect(onClose).toHaveBeenCalled();
    });

    it("calls onImportLut when clicking Import button", async () => {
        vi.mocked(pickLutFile).mockResolvedValue("/test/path.cube");
        const { onImportLut } = renderModal();
        fireEvent.click(screen.getByText("Import"));
        await act(async () => {
            await Promise.resolve();
        });
        expect(pickLutFile).toHaveBeenCalled();
        expect(onImportLut).toHaveBeenCalledWith("/test/path.cube");
    });

    it("clears query when clicking the X clear button", () => {
        renderModal();
        const input = screen.getByPlaceholderText("Search LUTs...");
        fireEvent.change(input, { target: { value: "test" } });
        const clearBtn = screen.getByLabelText("Clear search");
        fireEvent.click(clearBtn);
        expect(input).toHaveValue("");
    });

    // --- keyboard interaction tests ---

    it("Esc in search mode closes the modal", () => {
        const { onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Escape")); });
        expect(onClose).toHaveBeenCalled();
    });

    it("Enter in nav mode selects highlighted LUT and closes", () => {
        const { onSelectLut, onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); }); // switch to nav mode
        act(() => { keyboardManager.dispatch(makeKeydown("j")); }); // move to second row
        act(() => { keyboardManager.dispatch(makeKeydown("Enter")); });
        expect(onSelectLut).toHaveBeenCalledWith(2);
        expect(onClose).toHaveBeenCalled();
    });

    it("Enter in search mode selects when only one match", () => {
        const { onSelectLut, onClose } = renderModal();
        const input = screen.getByPlaceholderText("Search LUTs...");
        act(() => { fireEvent.change(input, { target: { value: "Cinestill" } }); });
        act(() => { keyboardManager.dispatch(makeKeydown("Enter")); });
        expect(onSelectLut).toHaveBeenCalledWith(3);
        expect(onClose).toHaveBeenCalled();
    });

    it("Enter in search mode does nothing when multiple matches", () => {
        const { onSelectLut, onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Enter")); });
        expect(onSelectLut).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("Tab in nav mode switches back to search mode", () => {
        const { container } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); }); // → nav mode
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); }); // → search mode
        const wrapper = container.querySelector('[class*="inputWrapper"]');
        expect(wrapper?.className).toContain("inputFocused");
    });

    it("Esc in nav mode closes the modal", () => {
        const { onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); }); // switch to nav mode
        act(() => { keyboardManager.dispatch(makeKeydown("Escape")); });
        expect(onClose).toHaveBeenCalled();
    });

    it("j/k in nav mode moves selection", () => {
        const { onSelectLut, onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); }); // switch to nav mode
        act(() => { keyboardManager.dispatch(makeKeydown("j")); }); // index 1
        act(() => { keyboardManager.dispatch(makeKeydown("j")); }); // index 2
        act(() => { keyboardManager.dispatch(makeKeydown("k")); }); // index 1
        act(() => { keyboardManager.dispatch(makeKeydown("Enter")); });
        expect(onSelectLut).toHaveBeenCalledWith(2);
        expect(onClose).toHaveBeenCalled();
    });

    it("selection clamps at bounds in nav mode", () => {
        const { onSelectLut, onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        // go down past the end
        act(() => {
            for (let i = 0; i < 20; i++) keyboardManager.dispatch(makeKeydown("j"));
        });
        act(() => { keyboardManager.dispatch(makeKeydown("Enter")); });
        expect(onSelectLut).toHaveBeenCalledWith(4); // last item
        expect(onClose).toHaveBeenCalled();
    });

    it("i in nav mode opens file dialog and calls onImportLut", async () => {
        vi.mocked(pickLutFile).mockResolvedValue("/test/lut.cube");
        const { onImportLut } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        act(() => { keyboardManager.dispatch(makeKeydown("i")); });
        await act(async () => {
            await Promise.resolve();
        });
        expect(pickLutFile).toHaveBeenCalled();
        expect(onImportLut).toHaveBeenCalledWith("/test/lut.cube");
    });

    it("d in nav mode enters confirm mode, o confirms and calls onDeleteLut", () => {
        const { onDeleteLut } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        act(() => { keyboardManager.dispatch(makeKeydown("d")); });
        expect(screen.getByText("Delete Kodak Portra 400?")).toBeInTheDocument();
        act(() => { keyboardManager.dispatch(makeKeydown("o")); });
        expect(onDeleteLut).toHaveBeenCalledWith(1);
    });

    it("c cancels pending delete without calling onDeleteLut", () => {
        const { onDeleteLut } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        act(() => { keyboardManager.dispatch(makeKeydown("d")); });
        act(() => { keyboardManager.dispatch(makeKeydown("c")); });
        expect(onDeleteLut).not.toHaveBeenCalled();
    });

    it("Esc cancels pending delete in nav mode without closing modal", () => {
        const { onDeleteLut, onClose } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        act(() => { keyboardManager.dispatch(makeKeydown("d")); });
        act(() => { keyboardManager.dispatch(makeKeydown("Escape")); });
        expect(onDeleteLut).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("confirms and cancels delete using clickable buttons in delete strip", () => {
        const { onDeleteLut } = renderModal();
        act(() => { keyboardManager.dispatch(makeKeydown("Tab")); });
        act(() => { keyboardManager.dispatch(makeKeydown("d")); });
        expect(screen.getByText("Delete Kodak Portra 400?")).toBeInTheDocument();

        // Click Cancel button
        const cancelBtn = screen.getByTestId("lut-cancel-delete-btn");
        fireEvent.click(cancelBtn);
        expect(screen.queryByText("Delete Kodak Portra 400?")).not.toBeInTheDocument();
        expect(onDeleteLut).not.toHaveBeenCalled();

        // Trigger delete again and click Confirm button
        act(() => { keyboardManager.dispatch(makeKeydown("d")); });
        const confirmBtn = screen.getByTestId("lut-confirm-delete-btn");
        fireEvent.click(confirmBtn);
        expect(onDeleteLut).toHaveBeenCalledWith(1);
    });

    it("opens right-click context menu and triggers actions", () => {
        const { onSelectLut, onClose } = renderModal();
        const row = screen.getByText("Fuji Velvia 50");
        fireEvent.contextMenu(row, { clientX: 200, clientY: 200 });

        expect(screen.getByTestId("context-menu")).toBeTruthy();
        expect(screen.getByText("Apply")).toBeTruthy();
        expect(screen.getByText("Delete")).toBeTruthy();

        // Click Apply
        fireEvent.click(screen.getByText("Apply"));
        expect(onSelectLut).toHaveBeenCalledWith(2);
        expect(onClose).toHaveBeenCalled();
    });
});
