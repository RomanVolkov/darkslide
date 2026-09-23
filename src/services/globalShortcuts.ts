import { ImageProcessor } from "./ImageProcessor";
import { NormalizedKeyEvent, KeyboardEventType, keyboardManager, RegistrationID } from "./KeyboardManager";
import { debug } from "../utils/debug";
import { useAppState } from "../state/appState";
import { Key, Panel } from "../components/constants";
import { setActivePanel } from "./PanelManager";
import { ActionService, CommandId } from "./ActionService";

export function registerGlobalShortcuts(processor: ImageProcessor): () => void {
    keyboardManager.register(RegistrationID.global, (e: NormalizedKeyEvent): boolean => {
        debug.log("global: " + e.key + " " + e.type + " ");
        const store = useAppState;
        const { images, focusPanel, showExport, showKeymap, showEraseConfirm, showSessions } = store.getState();
        const isTextTarget = (e.origin?.target instanceof HTMLInputElement && e.origin.target.type !== "range") || e.origin?.target instanceof HTMLTextAreaElement;
        if (isTextTarget) {
            if (e.type === KeyboardEventType.down && e.key === Key.Escape) {
                if (showExport) {
                    ActionService.closeExport();
                    return true;
                }
                if (showKeymap) {
                    ActionService.closeHelp();
                    return true;
                }
                if (showEraseConfirm) {
                    ActionService.closeEraseConfirm();
                    return true;
                }
                if (showSessions) {
                    ActionService.closeSessions();
                    return true;
                }
            }
            return false;
        }
        switch (e.type) {
            case KeyboardEventType.up:
                if (e.key === Key.Backslash) {
                    ActionService.toggleOriginal(false);
                    return true;
                }
                break;
            case KeyboardEventType.down:
                if (e.key === Key.Backslash) {
                    if (!e.origin.repeat && images.length > 0) {
                        ActionService.toggleOriginal(true);
                    }
                    return true;
                }
                if (e.key === Key.Escape && showExport) {
                    ActionService.closeExport();
                    return true;
                }
                if (e.key === Key.Escape && showKeymap) {
                    ActionService.closeHelp();
                    return true;
                }
                if (e.key === Key.Escape && showEraseConfirm) {
                    ActionService.closeEraseConfirm();
                    return true;
                }
                if (e.key === Key.Escape && showSessions) {
                    ActionService.closeSessions();
                    return true;
                }
                if (e.shift && e.meta && e.alt && (e.origin?.code === "KeyX" || e.key === Key.x || e.key === Key.X)) {
                    ActionService.execute(CommandId.EditEraseDb, processor);
                    return true;
                }
                if (e.key === Key.Question) {
                    ActionService.execute(CommandId.HelpToggle, processor);
                    return true;
                }
                if (e.key === Key.Tab) {
                    if (focusPanel === Panel.Adjustments) {
                        debug.log("images: ", images);
                        if (images.length === 0) return true;
                        setActivePanel(Panel.Filmstrip);
                    } else {
                        setActivePanel(Panel.Adjustments);
                    }
                    return true;
                }
                if (e.key === Key.o && !e.meta) {
                    ActionService.execute(CommandId.FileOpen, processor);
                    return true;
                }
                if (e.key === Key.O && !e.meta) {
                    ActionService.execute(CommandId.FileOpenReplace, processor);
                    return true;
                }
                if (e.key === Key.e && !e.meta) {
                    ActionService.execute(CommandId.FileExport, processor);
                    return true;
                }
                if (e.key === Key.s && !e.meta) {
                    ActionService.execute(CommandId.SessionPalette, processor);
                    return true;
                }
                if (e.key === Key.R && !e.meta) {
                    ActionService.execute(CommandId.ImageRotate, processor);
                    return true;
                }
                if (e.key === Key.d || e.key === Key.Backspace) {
                    ActionService.execute(CommandId.FilmstripDelete, processor);
                    return true;
                }
                if (e.key === Key.f && !e.meta) {
                    ActionService.execute(CommandId.ViewGrid, processor);
                    return true;
                }
                if ((e.key === Key.y && !e.meta) || (e.meta && (e.key === Key.c || e.key === Key.C))) {
                    ActionService.execute(CommandId.AdjustmentsYank, processor);
                    return true;
                }
                if ((e.key === Key.p && !e.meta) || (e.meta && (e.key === Key.v || e.key === Key.V))) {
                    ActionService.execute(CommandId.AdjustmentsPaste, processor);
                    return true;
                }
                if ((e.key === Key.u && !e.meta) || (e.meta && !e.shift && (e.key === Key.z || e.key === Key.Z))) {
                    ActionService.execute(CommandId.EditUndo, processor);
                    return true;
                }
                if ((e.key === Key.r && !e.meta) || (e.meta && e.shift && (e.key === Key.z || e.key === Key.Z))) {
                    ActionService.execute(CommandId.EditRedo, processor);
                    return true;
                }
                if (e.key === Key.w && !e.meta) {
                    ActionService.execute(CommandId.ImageAutoWb, processor);
                    return true;
                }
                if (e.key === Key.X && e.shift && !e.meta && !e.alt) {
                    ActionService.execute(CommandId.AdjustmentsReset, processor);
                    return true;
                }
                if (e.meta && (e.key === Key.a || e.key === Key.A)) {
                    ActionService.execute(CommandId.EditSelectAll, processor);
                    return true;
                }
                return false;
        }
        return false;
    }, false);

    return () => {
        keyboardManager.unregister(RegistrationID.global);
    };
}
