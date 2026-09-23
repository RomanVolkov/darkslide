import { Key } from "../components/constants";
import type { NormalizedKeyEvent } from "./KeyboardManager";
import { CommandId } from "./ActionService";

export type HelpSection = "Global" | "Sidebar" | "Filmstrip" | "Curve" | "LUT" | "Sessions";

export interface AppCommand {
    id: CommandId | string;
    label: string;
    helpLabel: string;
    helpSection: HelpSection;
    keys: string[];
    accelerator?: string;
    menuSection?: "app" | "file" | "edit" | "image" | "view" | "integrations" | "help";
    matches?: (e: NormalizedKeyEvent) => boolean;
}

export const COMMAND_DEFINITIONS: AppCommand[] = [
    // --- Global ---
    {
        id: CommandId.FileOpen,
        label: "Open Images...",
        helpLabel: "add images",
        helpSection: "Global",
        keys: [Key.o],
        accelerator: "o",
        menuSection: "file",
        matches: (e) => e.key === Key.o && !e.meta,
    },
    {
        id: CommandId.FileOpenReplace,
        label: "Open & Replace Images...",
        helpLabel: "replace images",
        helpSection: "Global",
        keys: [Key.o.toUpperCase()],
        accelerator: "Shift+O",
        menuSection: "file",
        matches: (e) => e.key === Key.o.toUpperCase() && !e.meta,
    },
    {
        id: CommandId.SessionPalette,
        label: "Sessions...",
        helpLabel: "sessions",
        helpSection: "Global",
        keys: [Key.s],
        accelerator: "s",
        menuSection: "file",
        matches: (e) => e.key === Key.s && !e.meta,
    },
    {
        id: CommandId.FileExport,
        label: "Export...",
        helpLabel: "export",
        helpSection: "Global",
        keys: [Key.e],
        accelerator: "e",
        menuSection: "file",
        matches: (e) => e.key === Key.e && !e.meta,
    },
    {
        id: CommandId.ImageRotate,
        label: "Rotate 90° CW",
        helpLabel: "rotate",
        helpSection: "Global",
        keys: [Key.r.toUpperCase()],
        accelerator: "Shift+R",
        menuSection: "image",
        matches: (e) => e.key === Key.r.toUpperCase() && !e.meta,
    },
    {
        id: CommandId.EditUndo,
        label: "Undo",
        helpLabel: "undo",
        helpSection: "Global",
        keys: [Key.u, "⌘Z"],
        accelerator: "u",
        menuSection: "edit",
        matches: (e) => (e.key === Key.u && !e.meta) || (e.meta && !e.shift && (e.key === Key.z || e.key === Key.Z)),
    },
    {
        id: CommandId.EditRedo,
        label: "Redo",
        helpLabel: "redo",
        helpSection: "Global",
        keys: [Key.r, "⇧⌘Z"],
        accelerator: "r",
        menuSection: "edit",
        matches: (e) => (e.key === Key.r && !e.meta) || (e.meta && e.shift && (e.key === Key.z || e.key === Key.Z)),
    },
    {
        id: CommandId.ViewOriginal,
        label: "Compare with Original (Hold \\)",
        helpLabel: "hold for original",
        helpSection: "Global",
        keys: [Key.Backslash],
        menuSection: "view",
        matches: (e) => e.key === Key.Backslash,
    },
    {
        id: CommandId.HelpToggle,
        label: "Keyboard Shortcuts",
        helpLabel: "toggle help",
        helpSection: "Global",
        keys: [Key.Question],
        accelerator: "Shift+Slash",
        menuSection: "help",
        matches: (e) => e.key === Key.Question,
    },
    {
        id: CommandId.ViewGrid,
        label: "Fullscreen Filmstrip",
        helpLabel: "fullscreen filmstrip",
        helpSection: "Global",
        keys: [Key.f],
        accelerator: "f",
        menuSection: "view",
        matches: (e) => e.key === Key.f && !e.meta,
    },
    {
        id: CommandId.EditEraseDb,
        label: "Erase Database Adjustments...",
        helpLabel: "erase database adjustments",
        helpSection: "Global",
        keys: ["⇧", "⌘", "⌥", "X"],
        accelerator: "CmdOrCtrl+Alt+Shift+X",
        menuSection: "edit",
        matches: (e) => e.shift && e.meta && e.alt && (e.origin?.code === "KeyX" || e.key.toLowerCase() === "x"),
    },

    // --- Sidebar ---
    {
        id: "slider_select",
        label: "Select Slider",
        helpLabel: "select slider",
        helpSection: "Sidebar",
        keys: [Key.j, Key.k],
    },
    {
        id: "slider_step",
        label: "Adjust Value",
        helpLabel: "±step",
        helpSection: "Sidebar",
        keys: [Key.h, Key.l],
    },
    {
        id: "slider_big_step",
        label: "Adjust Value (Coarse)",
        helpLabel: "±big step",
        helpSection: "Sidebar",
        keys: [Key.h.toUpperCase(), Key.l.toUpperCase()],
    },
    {
        id: "slider_clear",
        label: "Clear Value",
        helpLabel: "clear value",
        helpSection: "Sidebar",
        keys: [Key.x],
    },
    {
        id: CommandId.AdjustmentsReset,
        label: "Reset All Adjustments",
        helpLabel: "reset all",
        helpSection: "Sidebar",
        keys: [Key.x.toUpperCase()],
        accelerator: "Shift+X",
        menuSection: "edit",
    },
    {
        id: CommandId.AdjustmentsYank,
        label: "Copy Adjustments",
        helpLabel: "yank",
        helpSection: "Sidebar",
        keys: [Key.y],
        accelerator: "y",
        menuSection: "edit",
    },
    {
        id: CommandId.ImageAutoWb,
        label: "Auto White Balance",
        helpLabel: "auto wb",
        helpSection: "Sidebar",
        keys: [Key.w],
        accelerator: "w",
        menuSection: "image",
    },
    {
        id: "focus_filmstrip",
        label: "Focus Filmstrip",
        helpLabel: "focus filmstrip",
        helpSection: "Sidebar",
        keys: [Key.Tab],
    },

    // --- Filmstrip ---
    {
        id: "filmstrip_nav",
        label: "Previous / Next Image",
        helpLabel: "prev / next",
        helpSection: "Filmstrip",
        keys: [Key.h, Key.l],
    },
    {
        id: "filmstrip_range",
        label: "Select Range",
        helpLabel: "select range",
        helpSection: "Filmstrip",
        keys: [Key.h.toUpperCase(), Key.l.toUpperCase()],
    },
    {
        id: CommandId.FilmstripSelectAll,
        label: "Select All",
        helpLabel: "select all",
        helpSection: "Filmstrip",
        keys: ["⌘A"],
        accelerator: "CmdOrCtrl+A",
        menuSection: "edit",
        matches: (e) => e.meta && (e.key === Key.a || e.key === Key.A),
    },
    {
        id: "filmstrip_deselect",
        label: "Deselect",
        helpLabel: "deselect",
        helpSection: "Filmstrip",
        keys: ["Esc"],
    },
    {
        id: CommandId.FilmstripYank,
        label: "Copy Adjustments",
        helpLabel: "yank",
        helpSection: "Filmstrip",
        keys: [Key.y],
    },
    {
        id: CommandId.AdjustmentsPaste,
        label: "Paste Adjustments",
        helpLabel: "paste",
        helpSection: "Filmstrip",
        keys: [Key.p],
        accelerator: "p",
        menuSection: "edit",
    },
    {
        id: CommandId.FilmstripDelete,
        label: "Remove from Session",
        helpLabel: "delete",
        helpSection: "Filmstrip",
        keys: [Key.d],
        accelerator: "Backspace",
        menuSection: "edit",
    },
    {
        id: "focus_sidebar",
        label: "Focus Sidebar",
        helpLabel: "focus sidebar",
        helpSection: "Filmstrip",
        keys: [Key.Enter],
    },
    {
        id: "filmstrip_row_nav",
        label: "Previous / Next Row",
        helpLabel: "prev / next row (fullscreen)",
        helpSection: "Filmstrip",
        keys: [Key.j, Key.k],
    },

    // --- Curve ---
    {
        id: "curve_move",
        label: "Move Point",
        helpLabel: "move point",
        helpSection: "Curve",
        keys: [Key.j, Key.k],
    },
    {
        id: "curve_adjust",
        label: "Adjust Handle",
        helpLabel: "adjust handle",
        helpSection: "Curve",
        keys: [Key.h.toUpperCase(), Key.l.toUpperCase()],
    },
    {
        id: "curve_add",
        label: "Add Point",
        helpLabel: "add point",
        helpSection: "Curve",
        keys: [Key.a],
    },
    {
        id: "curve_delete",
        label: "Delete Point",
        helpLabel: "delete point",
        helpSection: "Curve",
        keys: [Key.d],
    },
    {
        id: "curve_reset",
        label: "Reset Curve",
        helpLabel: "reset",
        helpSection: "Curve",
        keys: ["0"],
    },
    {
        id: "curve_exit",
        label: "Exit Curve Editor",
        helpLabel: "exit curve",
        helpSection: "Curve",
        keys: ["Esc"],
    },

    // --- LUT ---
    {
        id: "lut_toggle_mode",
        label: "Toggle Search / Nav",
        helpLabel: "toggle search/nav",
        helpSection: "LUT",
        keys: [Key.Tab],
    },
    {
        id: "lut_select",
        label: "Select LUT",
        helpLabel: "select LUT",
        helpSection: "LUT",
        keys: [Key.j, Key.k],
    },
    {
        id: "lut_apply",
        label: "Apply LUT",
        helpLabel: "apply",
        helpSection: "LUT",
        keys: [Key.Enter],
    },
    {
        id: "lut_close",
        label: "Close LUT Palette",
        helpLabel: "close",
        helpSection: "LUT",
        keys: [Key.Escape],
    },
    {
        id: "lut_import",
        label: "Import .cube File",
        helpLabel: "import .cube",
        helpSection: "LUT",
        keys: [Key.i],
    },
    {
        id: "lut_delete",
        label: "Delete LUT",
        helpLabel: "delete",
        helpSection: "LUT",
        keys: [Key.d],
    },
    {
        id: "lut_confirm_cancel",
        label: "Confirm / Cancel Delete",
        helpLabel: "confirm / cancel",
        helpSection: "LUT",
        keys: [Key.o, Key.c],
    },
    {
        id: "lut_clear_search",
        label: "Clear Search Query",
        helpLabel: "clear search",
        helpSection: "LUT",
        keys: [Key.x],
    },

    // --- Sessions ---
    {
        id: "session_open_palette",
        label: "Open Session Palette",
        helpLabel: "open palette",
        helpSection: "Sessions",
        keys: [Key.s],
    },
    {
        id: "session_toggle_mode",
        label: "Toggle Search / Nav",
        helpLabel: "toggle search/nav",
        helpSection: "Sessions",
        keys: [Key.Tab],
    },
    {
        id: "session_new",
        label: "New Session",
        helpLabel: "new session",
        helpSection: "Sessions",
        keys: [Key.n.toUpperCase()],
    },
    {
        id: "session_select",
        label: "Select Session",
        helpLabel: "select session",
        helpSection: "Sessions",
        keys: [Key.j, Key.k],
    },
    {
        id: "session_open",
        label: "Open Session",
        helpLabel: "open",
        helpSection: "Sessions",
        keys: [Key.Enter],
    },
    {
        id: "session_rename",
        label: "Rename Session",
        helpLabel: "rename",
        helpSection: "Sessions",
        keys: [Key.r],
    },
    {
        id: "session_delete",
        label: "Delete Session",
        helpLabel: "delete",
        helpSection: "Sessions",
        keys: [Key.d],
    },
    {
        id: "session_export_all",
        label: "Export Session Images",
        helpLabel: "export all",
        helpSection: "Sessions",
        keys: [Key.e.toUpperCase()],
    },
    {
        id: "session_clear_search",
        label: "Clear Search Query",
        helpLabel: "clear search",
        helpSection: "Sessions",
        keys: [Key.x],
    },
    {
        id: "session_close",
        label: "Close Sessions Palette",
        helpLabel: "close",
        helpSection: "Sessions",
        keys: [Key.Escape],
    },
];

export const SECTION_ORDER: HelpSection[] = [
    "Global",
    "Sidebar",
    "Filmstrip",
    "Curve",
    "LUT",
    "Sessions",
];

export interface HelpSectionData {
    title: HelpSection;
    entries: { keys: string[]; label: string }[];
}

export function getHelpSections(): HelpSectionData[] {
    const grouped = new Map<HelpSection, { keys: string[]; label: string }[]>();
    for (const section of SECTION_ORDER) {
        grouped.set(section, []);
    }
    for (const cmd of COMMAND_DEFINITIONS) {
        const list = grouped.get(cmd.helpSection);
        if (list) {
            list.push({ keys: cmd.keys, label: cmd.helpLabel });
        }
    }
    return SECTION_ORDER.map((section) => ({
        title: section,
        entries: grouped.get(section) ?? [],
    }));
}
