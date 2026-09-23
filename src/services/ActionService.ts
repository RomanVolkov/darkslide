import { useAppState } from "../state/appState";
import { ImageProcessor } from "./ImageProcessor";
import { loadImages } from "./FileHandlers";
import { openPalette } from "./SessionService";
import { setActivePanel } from "./PanelManager";
import { Panel } from "../components/constants";
import { ImageEntry } from "../types";
import { applyAutoWhiteBalance } from "./autoWhiteBalance";
import { keyboardManager, RegistrationID } from "./KeyboardManager";
import { filmstripHistory, RemovedImageItem } from "./filmstripHistory";
import { thumbnailRegistry } from "./thumbnailRegistry";

export enum CommandId {
    FileOpen = "file_open",
    FileOpenReplace = "file_open_replace",
    SessionPalette = "session_palette",
    FileExport = "file_export",
    ImageRotate = "image_rotate",
    EditUndo = "edit_undo",
    EditRedo = "edit_redo",
    ViewOriginal = "view_original",
    HelpToggle = "help_toggle",
    ViewGrid = "view_grid",
    EditEraseDb = "edit_erase_db",
    AdjustmentsYank = "adjustments_yank",
    FilmstripYank = "filmstrip_yank",
    AdjustmentsPaste = "adjustments_paste",
    FilmstripDelete = "filmstrip_delete",
    AdjustmentsReset = "adjustments_reset",
    ImageAutoWb = "image_auto_wb",
    EditSelectAll = "edit_select_all",
    FilmstripSelectAll = "filmstrip_select_all",
}

export type ActionCommandId = CommandId;

export class ActionService {
    static async openImages(processor: ImageProcessor, replace = false): Promise<void> {
        const store = useAppState;
        const count = store.getState().images.length;
        await loadImages(null, store, processor, replace, replace || count === 0);
    }

    static openExport(): void {
        const { images } = useAppState.getState();
        if (images.length === 0) return;
        useAppState.getState().setShowSessions(false);
        useAppState.getState().setShowKeymap(false);
        useAppState.getState().setShowEraseConfirm(false);
        useAppState.getState().setShowExport(true);
    }

    static closeExport(): void {
        useAppState.getState().setShowExport(false);
    }

    static openSessions(): void {
        useAppState.getState().setShowExport(false);
        useAppState.getState().setShowKeymap(false);
        useAppState.getState().setShowEraseConfirm(false);
        openPalette();
    }

    static closeSessions(): void {
        useAppState.getState().setShowSessions(false);
    }

    static toggleHelp(): void {
        const { showKeymap, setShowKeymap } = useAppState.getState();
        setShowKeymap(!showKeymap);
    }

    static closeHelp(): void {
        useAppState.getState().setShowKeymap(false);
    }

    static openEraseConfirm(): void {
        useAppState.getState().setShowEraseConfirm(true);
    }

    static closeEraseConfirm(): void {
        useAppState.getState().setShowEraseConfirm(false);
    }

    static closeAllModals(): void {
        const store = useAppState.getState();
        if (store.showExport) store.setShowExport(false);
        if (store.showKeymap) store.setShowKeymap(false);
        if (store.showEraseConfirm) store.setShowEraseConfirm(false);
        if (store.showSessions) store.setShowSessions(false);
    }

    static toggleOriginal(show?: boolean): void {
        const { images, showOriginal, setShowOriginal } = useAppState.getState();
        if (images.length === 0) {
            if (showOriginal) setShowOriginal(false);
            return;
        }
        const next = show !== undefined ? show : !showOriginal;
        if (showOriginal !== next) {
            setShowOriginal(next);
        }
    }

    static rotateCW(): void {
        const { images, activeIndex, updateImage } = useAppState.getState();
        const image = images[activeIndex];
        if (!image) return;
        updateImage(image.id, (img: ImageEntry) => {
            img.adjustments = { ...img.adjustments, rotation: (img.adjustments.rotation + 90) % 360 };
        });
    }

    static async deleteSelected(
        processorOrTargetIds?: ImageProcessor | Set<string> | string[],
        maybeTargetIds?: Set<string> | string[] | ImageProcessor,
    ): Promise<void> {
        let processor: ImageProcessor | undefined;
        let targetIds: Set<string> | string[] | undefined;

        if (processorOrTargetIds && typeof processorOrTargetIds === "object" && "backend" in processorOrTargetIds) {
            processor = processorOrTargetIds as ImageProcessor;
            targetIds = maybeTargetIds as Set<string> | string[] | undefined;
        } else {
            targetIds = processorOrTargetIds as Set<string> | string[] | undefined;
            if (maybeTargetIds && typeof maybeTargetIds === "object" && "backend" in maybeTargetIds) {
                processor = maybeTargetIds as ImageProcessor;
            }
        }

        const store = useAppState.getState();
        const all = store.images;
        const active = all[store.activeIndex];
        const rawDeleteIds = targetIds instanceof Set
            ? targetIds
            : Array.isArray(targetIds)
                ? new Set(targetIds)
                : (store.selectedIds.size > 0 ? store.selectedIds : active ? new Set([active.id]) : new Set<string>());

        if (rawDeleteIds.size === 0) return;

        const sessionId = store.sessionId ?? null;
        const remaining = all.filter((img) => !rawDeleteIds.has(img.id));

        // Preserve items with original indices and thumbnails for instant undo restoration
        const removedItems: RemovedImageItem[] = [];
        all.forEach((entry, index) => {
            if (rawDeleteIds.has(entry.id)) {
                removedItems.push({
                    entry,
                    index,
                    thumbnail: thumbnailRegistry.get(entry.id),
                });
            }
        });

        // Record in filmstrip history stack (discards any redo and evicts overflow to backend)
        const pushPromise = filmstripHistory.pushRemoval(removedItems, sessionId, processor?.backend);

        store.deleteImages(rawDeleteIds);
        if (remaining.length === 0) {
            setActivePanel(Panel.Adjustments);
        } else {
            setActivePanel(Panel.Filmstrip);
        }

        await pushPromise;
    }

    static undoImageRemoval(): boolean {
        const entry = filmstripHistory.popUndo();
        if (!entry) return false;

        for (const item of entry.items) {
            if (item.thumbnail) {
                thumbnailRegistry.set(item.entry.id, item.thumbnail);
            }
        }

        useAppState.getState().restoreImages(entry.items, entry.sessionId);
        setActivePanel(Panel.Filmstrip);

        const count = entry.items.length;
        const msg = count === 1 ? `restored ${entry.items[0]!.entry.filename}` : `restored ${count} images`;
        useAppState.getState().showToast(msg);
        return true;
    }

    static redoImageRemoval(): boolean {
        const entry = filmstripHistory.popRedo();
        if (!entry) return false;

        const ids = new Set(entry.items.map((item) => item.entry.id));
        useAppState.getState().deleteImages(ids);

        const remaining = useAppState.getState().images;
        if (remaining.length === 0) {
            setActivePanel(Panel.Adjustments);
        } else {
            setActivePanel(Panel.Filmstrip);
        }

        const count = entry.items.length;
        const msg = count === 1 ? `removed ${entry.items[0]!.entry.filename}` : `removed ${count} images`;
        useAppState.getState().showToast(msg);
        return true;
    }

    static toggleGrid(): void {
        const { images, filmstripView, setFilmstripView, setShowOriginal } = useAppState.getState();
        if (images.length === 0) return;
        if (filmstripView === "grid") {
            setFilmstripView("strip");
        } else {
            setFilmstripView("grid");
            setActivePanel(Panel.Filmstrip);
            setShowOriginal(false);
        }
    }

    static copyAdjustments(): void {
        const { images, yankAdjustments, showToast } = useAppState.getState();
        if (images.length === 0) return;
        yankAdjustments();
        showToast("yanked");
    }

    static pasteAdjustments(customTargetIds?: Set<string>): void {
        const { selectedIds, pasteAdjustments, images, activeIndex, showToast } = useAppState.getState();
        if (images.length === 0) return;
        const targetIds = customTargetIds ?? (
            selectedIds.size > 0
                ? selectedIds
                : (images[activeIndex] ? new Set([images[activeIndex].id]) : new Set<string>())
        );
        if (targetIds.size > 0) {
            pasteAdjustments(targetIds);
            showToast(targetIds.size > 1 ? `pasted to ${targetIds.size} images` : "pasted");
        }
    }

    static undo(): void {
        const store = useAppState.getState();
        const activeRegistration = keyboardManager.getActive();
        const isFilmstrip = activeRegistration === RegistrationID.filmstrip || store.focusPanel === Panel.Filmstrip;

        if (isFilmstrip && filmstripHistory.canUndo()) {
            this.undoImageRemoval();
            return;
        }

        if (store.images.length === 0 && filmstripHistory.canUndo()) {
            this.undoImageRemoval();
            return;
        }

        if (store.images.length > 0) {
            store.undoAdjustment();
        }
    }

    static redo(): void {
        const store = useAppState.getState();
        const activeRegistration = keyboardManager.getActive();
        const isFilmstrip = activeRegistration === RegistrationID.filmstrip || store.focusPanel === Panel.Filmstrip;

        if (isFilmstrip && filmstripHistory.canRedo()) {
            this.redoImageRemoval();
            return;
        }

        if (store.images.length > 0) {
            store.redoAdjustment();
        }
    }

    static async autoWhiteBalance(): Promise<void> {
        const { images, activeIndex, showToast } = useAppState.getState();
        const img = images[activeIndex];
        if (!img) return;
        try {
            const { temperature, tint } = await applyAutoWhiteBalance(img.id);
            const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
            showToast(`Auto WB  temp ${fmt(temperature)}  tint ${fmt(tint)}`);
        } catch {
            showToast("Auto WB failed");
        }
    }

    static resetAdjustments(): void {
        const { images, resetAdjustments, showToast } = useAppState.getState();
        if (images.length === 0) return;
        resetAdjustments();
        showToast("reset all");
    }

    static selectAll(): void {
        const store = useAppState.getState();
        if (store.showExport || store.showKeymap || store.showEraseConfirm || store.showSessions) return;
        if (keyboardManager.getActive() === RegistrationID.lut) return;
        if (store.images.length === 0) return;
        store.selectAll();
        setActivePanel(Panel.Filmstrip);
    }

    private static lastCommandId: CommandId | string | null = null;
    private static lastCommandTime = 0;

    static resetDeduplicationForTests(): void {
        this.lastCommandId = null;
        this.lastCommandTime = 0;
        filmstripHistory.resetForTests();
    }

    static async execute(commandId: CommandId | string, processor?: ImageProcessor): Promise<boolean> {
        const now = performance.now();
        // Deduplicate rapid dual dispatches when a keystroke simultaneously triggers
        // both DOM keydown and a native macOS menu accelerator
        if (this.lastCommandId === commandId && (now - this.lastCommandTime) < 100) {
            return true;
        }
        this.lastCommandId = commandId;
        this.lastCommandTime = now;

        switch (commandId) {
            case CommandId.FileOpen:
                if (processor) await this.openImages(processor, false);
                return true;
            case CommandId.FileOpenReplace:
                if (processor) await this.openImages(processor, true);
                return true;
            case CommandId.SessionPalette:
                this.openSessions();
                return true;
            case CommandId.FileExport:
                this.openExport();
                return true;
            case CommandId.ImageRotate:
                this.rotateCW();
                return true;
            case CommandId.EditUndo:
                this.undo();
                return true;
            case CommandId.EditRedo:
                this.redo();
                return true;
            case CommandId.ViewOriginal:
                this.toggleOriginal();
                return true;
            case CommandId.HelpToggle:
                this.toggleHelp();
                return true;
            case CommandId.ViewGrid:
                this.toggleGrid();
                return true;
            case CommandId.EditEraseDb:
                this.openEraseConfirm();
                return true;
            case CommandId.AdjustmentsYank:
            case CommandId.FilmstripYank:
                this.copyAdjustments();
                return true;
            case CommandId.AdjustmentsPaste:
                this.pasteAdjustments();
                return true;
            case CommandId.FilmstripDelete:
                if (processor) await this.deleteSelected(processor);
                return true;
            case CommandId.AdjustmentsReset:
                this.resetAdjustments();
                return true;
            case CommandId.ImageAutoWb:
                await this.autoWhiteBalance();
                return true;
            case CommandId.EditSelectAll:
            case CommandId.FilmstripSelectAll:
                this.selectAll();
                return true;
            default:
                return false;
        }
    }
}
