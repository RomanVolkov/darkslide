import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Key } from "../constants/index.ts";
import m from "../modal.module.css";
import s from "./LUTModal.module.css";
import { Button } from "../Button/Button.tsx";
import { ContextMenu, ContextMenuItem } from "../ContextMenu/ContextMenu.tsx";
import { keyboardManager, NormalizedKeyEvent, KeyboardEventType, RegistrationID } from "../../services/KeyboardManager.ts";
import { pickLutFile } from "../../services/LutImporter.ts";
import { fuzzyMatch } from "../../utils/fuzzyMatch.ts";
import { useLatest } from "../../utils/utils.ts";
import { LutItem } from "../../state/lutState.ts";

interface LUTModalProps {
    luts: LutItem[];
    selectedId: number | null;
    onSelectLut: (id: number) => void;
    onDeleteLut: (id: number) => void;
    onImportLut: (path: string) => void;
    onClose: () => void;
}

/**
 * Keyboard-driven LUT selection modal with two interaction modes toggled by Tab.
 *
 * **Search mode** (default, input focused):
 *   Search input receives all keystrokes natively (letters, digits, j/k/i/d).
 *   Only Tab (toggle to nav mode) and Esc (close) are intercepted. Enter selects
 *   the item when the query narrows the list to exactly one match.
 *
 * **Nav mode** (input blurred, vim-style row navigation):
 *   j/k/arrows  — move highlight (honours digit count prefix, e.g. 5j)
 *   Enter       — select highlighted item and close
 *   Esc         — close (or cancel pending delete without closing)
 *   i           — open native .cube file dialog, emit onImportLut(path)
 *   d           — enter delete confirmation for highlighted row
 *   o           — confirm delete
 *   c           — cancel delete
 *   x  — clear search query
 *   Tab         — toggle back to search mode
 *
 * Mouse interactions (work in both modes):
 *   click row     — select and close
 *   click Import  — open file dialog
 *   click X       — clear query
 *   click overlay — close
 *   click input   — switch to search mode
 *
 * Registers with KeyboardManager as RegistrationID.lut (override_global=true).
 * Closing the modal restores the previous active registration (e.g. adjustments panel).
 *
 * Event callbacks (wired externally; just console.log for now):
 *   onSelectLut(id)   — user picked a LUT from the list
 *   onImportLut(path) — user selected a .cube file
 *   onDeleteLut(id)   — user confirmed delete of a LUT
 *   onClose()         — modal dismissed
 */
export function LUTModal({ luts, selectedId: _selectedId, onSelectLut, onDeleteLut, onImportLut, onClose }: LUTModalProps) {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
    const [mode, setMode] = useState<"search" | "nav">("search");
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: LutItem } | null>(null);

    const contextMenuItems: ContextMenuItem[] = useMemo(() => {
        if (!contextMenu) return [];
        const item = contextMenu.item;
        return [
            {
                id: "apply",
                label: "Apply",
                shortcut: "Enter",
                onClick: () => {
                    onSelectLut(item.id);
                    onClose();
                },
            },
            {
                id: "sep",
                label: "",
                separator: true,
            },
            {
                id: "delete",
                label: "Delete",
                shortcut: "D",
                destructive: true,
                onClick: () => {
                    setPendingDeleteId(item.id);
                },
            },
        ];
    }, [contextMenu, onSelectLut, onClose]);

    const inputRef = useRef<HTMLInputElement>(null);
    const selectedRowRef = useRef<HTMLDivElement>(null);
    const pendingJkRef = useRef(0);
    const rAFIdRef = useRef<number | null>(null);

    const filtered = luts.filter((l) => fuzzyMatch(query, l.name));

    const localStateRef = useLatest({
        query, selectedIndex, pendingDeleteId, mode, filtered, luts,
        onSelectLut, onDeleteLut, onImportLut, onClose,
    });

    // const isLoading = lutState(s => s.isLoading);

    useEffect(() => {
        const max = filtered.length - 1;
        if (selectedIndex > max) setSelectedIndex(Math.max(0, max));
    }, [filtered.length, selectedIndex]);

    useEffect(() => {
        if (mode === "search") {
            inputRef.current?.focus();
        } else {
            inputRef.current?.blur();
        }
    }, [mode]);

    // Keep the highlighted row visible when navigating with j/k
    useEffect(() => {
        selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [selectedIndex]);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        const handler = (e: NormalizedKeyEvent): boolean => {
            if (e.type !== KeyboardEventType.down) return false;

            const state = localStateRef.current;

            switch (state.mode) {

                // --- search mode: input focused, native typing ------
                case "search":
                    switch (e.key) {
                        case Key.Tab:
                            e.origin.preventDefault();
                            setMode("nav");
                            return true;
                        case Key.Escape:
                            state.onClose();
                            return true;
                        case Key.Enter:
                            // Select immediately when query narrows to a single match
                            if (state.filtered.length === 1) {
                                state.onSelectLut(state.filtered[0]!.id);
                                state.onClose();
                                return true;
                            }
                            return false;
                        default:
                            // All other keys pass through to the <input> natively
                            return false;
                    }

                // --- nav mode: input blurred, vim-style row nav ------
                case "nav":
                    // Delete confirmation sub-mode
                    if (state.pendingDeleteId) {
                        switch (e.key) {
                            case Key.o:
                                state.onDeleteLut(state.pendingDeleteId);
                                setPendingDeleteId(null);
                                return true;
                            case Key.c:
                            case Key.Escape:
                                setPendingDeleteId(null);
                                return true;
                            default:
                                return false;
                        }
                    }

                    switch (e.key) {
                        case Key.Tab:
                            e.origin.preventDefault();
                            setMode("search");
                            return true;
                        // rAF throttle on repeat: OS key-repeat fires faster than
                        // React can commit, causing visible selection lag. Single
                        // taps apply immediately; holds coalesce per animation frame.
                        case Key.j:
                        case Key.k: {
                            const dir = e.key === Key.j ? 1 : -1;
                            const offset = dir * e.count;
                            if (e.origin.repeat) {
                                pendingJkRef.current += offset;
                                if (rAFIdRef.current === null) {
                                    rAFIdRef.current = requestAnimationFrame(() => {
                                        rAFIdRef.current = null;
                                        const total = pendingJkRef.current;
                                        pendingJkRef.current = 0;
                                        if (total !== 0) {
                                            setSelectedIndex((i) => {
                                                const next = i + total;
                                                return Math.max(0, Math.min(next, state.filtered.length - 1));
                                            });
                                        }
                                    });
                                }
                                return true;
                            }
                            setSelectedIndex((i) => {
                                const next = i + offset;
                                return Math.max(0, Math.min(next, state.filtered.length - 1));
                            });
                            return true;
                        }
                        case Key.Enter: {
                            const item = state.filtered[state.selectedIndex];
                            if (item) {
                                state.onSelectLut(item.id);
                                state.onClose();
                            }
                            return true;
                        }
                        case Key.Escape:
                            state.onClose();
                            return true;
                        case Key.i: {
                            pickLutFile().then((path) => {
                                if (path) state.onImportLut(path);
                            });
                            return true;
                        }
                        case Key.d: {
                            const item = state.filtered[state.selectedIndex];
                            if (item) setPendingDeleteId(item.id);
                            return true;
                        }
                        case Key.x:
                            setQuery("");
                            return true;
                        default:
                            return false;
                    }
            }
        };

        keyboardManager.register(RegistrationID.lut, handler, true);
        keyboardManager.setActive(RegistrationID.lut);
        return () => {
            if (rAFIdRef.current !== null) cancelAnimationFrame(rAFIdRef.current);
            keyboardManager.unregister(RegistrationID.lut);
        };
    }, []);

    const handleRowClick = useCallback((id: number) => {
        onSelectLut(id);
        onClose();
    }, [onSelectLut, onClose]);

    const handleImportClick = useCallback(() => {
        pickLutFile().then((path) => {
            if (path) onImportLut(path);
        });
    }, [onImportLut]);

    const showConfirm = pendingDeleteId !== null;
    const deleteItem = luts.find((l) => l.id === pendingDeleteId);

    return (
        <div
            className={m.overlay}
            onClick={onClose}
            // The modal is rendered inside the adjustments panel, whose
            // onPointerDown re-routes the keyboard to the panel. Stop pointer
            // events here so interacting with the modal (clicking the search
            // input, a row, Import) can never steal keyboard focus from it.
            onPointerDown={(e) => e.stopPropagation()}
        >
            <div className={m.modal} onClick={(e) => e.stopPropagation()}>
                <h1 className={m.title}>Select LUT</h1>

                {showConfirm ? (
                    <div className={s.confirmStrip}>
                        <span className={s.confirmPrompt}>
                            Delete {deleteItem?.name ?? "LUT"}?
                        </span>
                        <div className={s.confirmActions}>
                            <button
                                type="button"
                                className={s.confirmBtn}
                                onClick={() => {
                                    onDeleteLut(pendingDeleteId!);
                                    setPendingDeleteId(null);
                                }}
                                data-testid="lut-confirm-delete-btn"
                            >
                                Confirm (O)
                            </button>
                            <button
                                type="button"
                                className={s.cancelBtn}
                                onClick={() => setPendingDeleteId(null)}
                                data-testid="lut-cancel-delete-btn"
                            >
                                Cancel (C)
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className={s.searchRow}>
                        {query && (
                            <button
                                className={s.clearBtn}
                                onClick={() => setQuery("")}
                                aria-label="Clear search"
                            >
                                X
                            </button>
                        )}
                        <div className={`${s.inputWrapper} ${mode === "search" ? s.inputFocused : s.inputNeutral}`}>
                            <input
                                ref={inputRef}
                                className={s.searchInput}
                                type="text"
                                placeholder="Search LUTs..."
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setSelectedIndex(0);
                                }}
                                onFocus={() => setMode("search")}
                            />
                        </div>
                        <Button onClick={handleImportClick}>Import</Button>
                    </div>
                )}

                <div className={s.list}>
                    {filtered.map((item, i) => (
                        <div key={item.id}>
                            <div
                                ref={i === selectedIndex ? selectedRowRef : undefined}
                                className={`${s.row} ${i === selectedIndex ? s.rowSelected : ""}`}
                                onClick={() => handleRowClick(item.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setSelectedIndex(i);
                                    setContextMenu({ x: e.clientX, y: e.clientY, item });
                                }}
                                onMouseEnter={() => setSelectedIndex(i)}
                            >
                                {item.name}
                            </div>
                            {i < filtered.length - 1 && <div className={s.rowSeparator} />}
                        </div>
                    ))}
                    {filtered.length === 0 && (
                        <div className={s.row}>No matches</div>
                    )}
                </div>

                <div className={s.footer}>
                    <span>Tab=Search/Nav</span>
                    <span>J/K=Select</span>
                    <span>Enter=Apply</span>
                    <span>I=Import</span>
                    <span>D=Delete</span>
                    <span>X=Clear</span>
                    <span>Esc=Close</span>
                </div>
            </div>
            {contextMenu && (
                <ContextMenu
                    items={contextMenuItems}
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
