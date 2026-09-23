import { useState, useRef, useEffect, useMemo } from "react";
import m from "../modal.module.css";
import s from "./SessionModal.module.css";
import { ContextMenu, ContextMenuItem } from "../ContextMenu/ContextMenu.tsx";
import { Key } from "../constants/index.ts";
import {
    keyboardManager,
    NormalizedKeyEvent,
    KeyboardEventType,
    RegistrationID,
} from "../../services/KeyboardManager.ts";
import { useAppState } from "../../state/appState.ts";
import { ImageProcessor } from "../../services/ImageProcessor.ts";
import {
    openSession,
    renameSession,
    deleteSession,
    exportSession,
} from "../../services/SessionService.ts";
import { loadImages } from "../../services/FileHandlers.ts";
import { fuzzyMatch } from "../../utils/fuzzyMatch.ts";
import { useLatest } from "../../utils/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import type { SessionSummary } from "../../types";
import { debug } from "../../utils/debug.ts";

/** "5m ago" style label from an RFC3339 timestamp. */
export function relativeTime(iso: string, now = Date.now()): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const seconds = Math.round((now - then) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(then).toLocaleDateString();
}

interface SessionModalProps {
    processor: ImageProcessor;
    onClose: () => void;
}

/**
 * tmux-style session palette, with the same two interaction modes as LUTModal:
 *
 * **Search mode** (default, input focused):
 *   The search input receives all keystrokes natively (letters, digits, j/k,
 *   r/d/E/N). Only Tab (toggle to nav mode) and Esc (close) are intercepted.
 *   Enter opens the session when the query narrows the list to exactly one match.
 *
 * **Nav mode** (input blurred, vim-style row navigation):
 *   j/k/arrows  — move the highlight (honours digit count prefix, e.g. 5j)
 *   Enter       — open highlighted session
 *   Esc         — close (or cancel a pending rename/delete)
 *   r           — rename (inline input)
 *   d           — delete confirmation strip
 *   E           — export the session (open + select-all + Export modal)
 *   N           — new session (file picker → create + attach)
 *   x           — clear the query
 *   Tab         — back to search mode
 *
 * Registers with KeyboardManager as RegistrationID.session (override_global).
 */
export function SessionModal({ processor, onClose }: SessionModalProps) {
    const sessions = useAppState((state) => state.sessions);
    const activeSessionId = useAppState((state) => state.sessionId);

    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [mode, setMode] = useState<"search" | "nav">("search");
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [renameError, setRenameError] = useState("");
    const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

    const renameInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const selectedRowRef = useRef<HTMLDivElement>(null);
    const pendingJkRef = useRef(0);
    const rAFIdRef = useRef<number | null>(null);

    const filtered = sessions.filter((item) => fuzzyMatch(query, item.name));

    useEffect(() => {
        invoke<SessionSummary[]>("list_sessions")
            .then((list) => {
                useAppState.getState().setSessions(list);
            })
            .catch((err) => {
                debug.error("list_sessions in SessionModal failed", err);
            });
    }, []);

    useEffect(() => {
        const max = filtered.length - 1;
        if (selectedIndex > max) setSelectedIndex(Math.max(0, max));
    }, [filtered.length, selectedIndex]);

    useEffect(() => {
        selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [selectedIndex]);

    useEffect(() => {
        if (mode === "search") {
            searchInputRef.current?.focus();
        } else {
            searchInputRef.current?.blur();
        }
    }, [mode]);

    useEffect(() => {
        if (renamingId !== null) renameInputRef.current?.focus();
    }, [renamingId]);

    const clearQuery = () => {
        setQuery("");
        setSelectedIndex(0);
    };
    const startRename = () => {
        const item = filtered[selectedIndex];
        if (!item) return;
        setRenamingId(item.id);
        setRenameValue(item.name);
        setRenameError("");
    };
    const cancelRename = () => {
        setRenamingId(null);
        setRenameError("");
    };
    const commitRename = () => {
        const id = renamingId;
        if (id === null) return;
        const trimmed = renameValue.trim();
        if (trimmed.length === 0) {
            setRenameError("Name cannot be empty");
            return;
        }
        setRenamingId(null);
        setRenameError("");
        renameSession(id, trimmed).catch((err) => debug.error("rename failed", err));
    };
    const startDelete = () => {
        const item = filtered[selectedIndex];
        if (item) setPendingDeleteId(item.id);
    };
    const cancelDelete = () => setPendingDeleteId(null);
    const confirmDelete = () => {
        const id = pendingDeleteId;
        if (id === null) return;
        setPendingDeleteId(null);
        deleteSession(id).catch((err) => debug.error("delete failed", err));
    };
    const openSelected = () => {
        const item = filtered[selectedIndex];
        if (!item) return;
        openSession(item.id, processor).then(onClose);
    };
    const exportSelected = () => {
        const item = filtered[selectedIndex];
        if (!item) return;
        onClose();
        exportSession(item.id, processor).catch((err) => debug.error("export failed", err));
    };
    // New session: same as the global open-replace flow — pick files, then
    // create and attach a session for them. Cancelling the picker is a no-op.
    const startNewSession = () => {
        onClose();
        loadImages(null, useAppState, processor, true, true);
    };

    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: typeof sessions[0] } | null>(null);

    const contextMenuItems: ContextMenuItem[] = useMemo(() => {
        if (!contextMenu) return [];
        const item = contextMenu.item;
        return [
            {
                id: "open",
                label: "Open",
                shortcut: "Enter",
                onClick: () => {
                    onClose();
                    openSession(item.id, processor).catch((err) =>
                        debug.error("openSession failed", err),
                    );
                },
            },
            {
                id: "rename",
                label: "Rename",
                shortcut: "R",
                onClick: () => {
                    setRenamingId(item.id);
                    setRenameValue(item.name);
                    setRenameError("");
                },
            },
            {
                id: "export",
                label: "Export All",
                shortcut: "E",
                onClick: () => {
                    onClose();
                    exportSession(item.id, processor).catch((err) =>
                        debug.error("export failed", err),
                    );
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
    }, [contextMenu, processor, onClose]);

    const localStateRef = useLatest({
        mode,
        setMode,
        filtered,
        renamingId,
        pendingDeleteId,
        commitRename,
        cancelRename,
        confirmDelete,
        cancelDelete,
        openSelected,
        exportSelected,
        startNewSession,
        startRename,
        startDelete,
        clearQuery,
        onClose,
    });

    useEffect(() => {
        const handler = (e: NormalizedKeyEvent): boolean => {
            if (e.type !== KeyboardEventType.down) return false;
            const st = localStateRef.current;

            // Rename sub-mode: the inline input owns native typing; Enter/Esc commit.
            if (st.renamingId !== null) {
                if (e.key === Key.Enter) {
                    st.commitRename();
                    return true;
                }
                if (e.key === Key.Escape) {
                    st.cancelRename();
                    return true;
                }
                return false;
            }

            // --- Search mode: input focused, native typing ---
            if (st.mode === "search") {
                if (e.meta && (e.key === Key.e || e.key === Key.e.toUpperCase())) {
                    st.exportSelected();
                    return true;
                }
                switch (e.key) {
                    case Key.Tab:
                        e.origin.preventDefault();
                        st.setMode("nav");
                        return true;
                    case Key.Escape:
                        st.onClose();
                        return true;
                    case Key.Enter:
                        if (st.filtered.length === 1) {
                            st.openSelected();
                            return true;
                        }
                        return false;
                    default:
                        // All other keys pass through to the <input> natively
                        return false;
                }
            }

            // --- Nav mode: input blurred, vim-style row nav ---
            if (st.pendingDeleteId !== null) {
                if (e.key === Key.d || e.key === Key.d.toUpperCase()) {
                    st.confirmDelete();
                    return true;
                }
                if (
                    e.key === Key.c ||
                    e.key === Key.c.toUpperCase() ||
                    e.key === Key.Escape
                ) {
                    st.cancelDelete();
                    return true;
                }
                return false;
            }

            switch (e.key) {
                case Key.Tab:
                    e.origin.preventDefault();
                    st.setMode("search");
                    return true;
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
                                    const len = localStateRef.current.filtered.length;
                                    setSelectedIndex((i) =>
                                        Math.max(0, Math.min(i + total, len - 1)),
                                    );
                                }
                            });
                        }
                        return true;
                    }
                    setSelectedIndex((i) => {
                        const next = i + offset;
                        return Math.max(0, Math.min(next, st.filtered.length - 1));
                    });
                    return true;
                }
                case Key.Enter:
                    st.openSelected();
                    return true;
                case Key.Escape:
                    st.onClose();
                    return true;
                case Key.r:
                    st.startRename();
                    return true;
                case Key.d:
                    st.startDelete();
                    return true;
                case Key.x:
                    st.clearQuery();
                    return true;
            }

            if (e.key === Key.e || e.key === Key.e.toUpperCase()) {
                st.exportSelected();
                return true;
            }
            if (e.key === Key.n.toUpperCase()) {
                st.startNewSession();
                return true;
            }
            return false;
        };

        keyboardManager.register(RegistrationID.session, handler, true);
        keyboardManager.setActive(RegistrationID.session);
        return () => {
            if (rAFIdRef.current !== null) cancelAnimationFrame(rAFIdRef.current);
            keyboardManager.unregister(RegistrationID.session);
        };
    }, []);

    const showConfirm = pendingDeleteId !== null;
    const deleteItem = sessions.find((item) => item.id === pendingDeleteId);

    return (
        <div
            className={m.overlay}
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <div
                className={m.modal}
                style={{ minWidth: "680px", maxWidth: "820px" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={s.headerRow}>
                    <h1 className={m.title}>Sessions</h1>
                    <button
                        type="button"
                        className={s.newBtn}
                        onClick={startNewSession}
                        title="New Session (N)"
                        data-testid="new-session-btn"
                    >
                        + New Session
                    </button>
                </div>

                {showConfirm ? (
                    <div className={s.confirmStrip}>
                        <span className={s.confirmPrompt}>
                            Delete {deleteItem?.name ?? "session"}?
                        </span>
                        <div className={s.confirmActions}>
                            <button
                                type="button"
                                className={s.confirmBtn}
                                onClick={confirmDelete}
                                data-testid="session-confirm-delete-btn"
                            >
                                Confirm (D)
                            </button>
                            <button
                                type="button"
                                className={s.cancelBtn}
                                onClick={cancelDelete}
                                data-testid="session-cancel-delete-btn"
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
                                onClick={clearQuery}
                                aria-label="Clear search"
                            >
                                X
                            </button>
                        )}
                        <div className={`${s.inputWrapper} ${mode === "search" ? s.inputFocused : s.inputNeutral}`}>
                            <input
                                ref={searchInputRef}
                                className={s.searchInput}
                                data-testid="session-search"
                                type="text"
                                value={query}
                                placeholder="Search sessions..."
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setSelectedIndex(0);
                                }}
                                onFocus={() => setMode("search")}
                            />
                        </div>
                    </div>
                )}

                <div className={s.list}>
                    {filtered.map((item, i) => (
                        <div key={item.id}>
                            <div
                                ref={i === selectedIndex ? selectedRowRef : undefined}
                                className={`${s.row} ${i === selectedIndex ? s.rowSelected : ""} ${item.id === activeSessionId ? s.rowActive : ""}`}
                                onClick={() => {
                                    if (renamingId !== null) return;
                                    onClose();
                                    openSession(item.id, processor).catch((err) =>
                                        debug.error("openSession failed", err),
                                    );
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setSelectedIndex(i);
                                    setContextMenu({ x: e.clientX, y: e.clientY, item });
                                }}
                                onMouseEnter={() => setSelectedIndex(i)}
                            >
                                {renamingId === item.id ? (
                                    <input
                                        ref={renameInputRef}
                                        className={s.renameInput}
                                        value={renameValue}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => {
                                            setRenameValue(e.target.value);
                                            setRenameError("");
                                        }}
                                    />
                                ) : (
                                    <>
                                        <span className={s.rowName}>{item.name}</span>
                                        <span className={s.rowMeta}>
                                            {item.image_count}{" "}
                                            {item.image_count === 1 ? "image" : "images"} ·{" "}
                                            {relativeTime(item.updated_at)}
                                        </span>
                                    </>
                                )}
                            </div>
                            {i < filtered.length - 1 && <div className={s.rowSeparator} />}
                        </div>
                    ))}
                    {filtered.length === 0 && (
                        <div className={s.emptyRow}>
                            {sessions.length === 0 ? "No sessions yet" : "No matches"}
                        </div>
                    )}
                </div>

                {renameError && <div className={s.renameError}>{renameError}</div>}

                <div className={s.footer}>
                    <span>Tab=Search/Nav</span>
                    <span>N=New</span>
                    <span>R=Rename</span>
                    <span>D=Delete</span>
                    <span>E=Export</span>
                    <span>Enter=Open</span>
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
