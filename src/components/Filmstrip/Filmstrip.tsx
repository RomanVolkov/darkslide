import { memo, useRef, useCallback, useEffect, useState, useMemo } from "react";
import type { ImageEntry } from "../../types/index.ts";
import { Adjustments } from "../../backend/types";
import type { PixelData } from "../../backend/types.ts";
import s from "./Filmstrip.module.css";
import { useAppState } from "../../state/appState.ts";
import { setActivePanel } from "../../services/PanelManager.ts";
import { Panel } from "../constants/index.ts";
import { NormalizedKeyEvent, KeyboardEventType, RegistrationID, keyboardManager } from "../../services/KeyboardManager.ts";
import { FilmstripDirection } from "../../state/appState.ts";
import { Key } from "../constants/index.ts";
import { getBackend } from "../../backend/index.ts";
import { ActionService, CommandId } from "../../services/ActionService.ts";
import { ContextMenu, ContextMenuItem } from "../ContextMenu/ContextMenu.tsx";

const THUMB_W = { strip: 80, grid: 176 } as const;
const THUMB_H = { strip: 60, grid: 132 } as const;
/** Fast drafts are cheap and only need to kill spinners, so they batch deeper. */
export const FAST_THUMBNAILS_PER_BATCH = 12;
/** HQ renders are the expensive path; keep the batch small so results trickle in. */
export const HQ_THUMBNAILS_PER_BATCH = 4;
/** Cap on simultaneous in-flight IPC batches so failed/slow batches can't pile up. */
export const MAX_CONCURRENT_THUMB_BATCHES = 3;

/**
 * Per-request HQ render size, matched to how large the tile is actually drawn
 * (Retina headroom, no more). The registry is keyed by image id, so toggling
 * strip↔grid re-requests at the new size rather than memoizing both.
 */
export const HQ_THUMB_MAX_DIM = { strip: 200, grid: 400 } as const;
/** Fast drafts are intentionally tiny — they only need to kill the spinner. */
export const FAST_THUMB_MAX_DIM = 160;

export { thumbnailRegistry, getThumbnailData } from "../../services/thumbnailRegistry";
import { thumbnailRegistry } from "../../services/thumbnailRegistry";
import { hashAdjustments } from "../../utils/adjustmentsHash.ts";

export const FilmstripItem = memo(({
    img,
    active,
    selected,
    index,
    onSelect,
    onOpen,
    onContextMenu,
    grid,
    pixelData,
    onVisible,
    style,
    left,
    top,
}: {
    img: ImageEntry;
    active: boolean;
    selected: boolean;
    index: number;
    onSelect: (i: number, e?: React.MouseEvent) => void;
    onOpen?: (i: number) => void;
    onContextMenu?: (e: React.MouseEvent, i: number) => void;
    grid: boolean;
    pixelData: PixelData | undefined;
    onVisible?: (id: string, visible: boolean) => void;
    style?: Record<string, string | number>;
    left?: number;
    top?: number;
}) => {
    const edited = Adjustments.hasEdits(img.adjustments);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [loaded, setLoaded] = useState(false);

    const w = grid ? THUMB_W.grid : THUMB_W.strip;
    const h = grid ? THUMB_H.grid : THUMB_H.strip;

    useEffect(() => {
        if (!onVisible) return;
        onVisible(img.id, true);
        return () => {
            onVisible(img.id, false);
        };
    }, [img.id, onVisible]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!pixelData) {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
            setLoaded(false);
            return;
        }
        if (!canvas) return;

        canvas.width = pixelData.width;
        canvas.height = pixelData.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const imageData = new ImageData(pixelData.data, pixelData.width, pixelData.height);
        ctx.putImageData(imageData, 0, 0);
        setLoaded(true);
    }, [pixelData]);

    useEffect(() => {
        return () => {
            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
        };
    }, []);

    const itemStyle = useMemo(() => {
        if (style) return style;
        if (left !== undefined && top !== undefined) {
            return {
                position: "absolute" as const,
                left: `${left}px`,
                top: `${top}px`,
            };
        }
        return undefined;
    }, [style, left, top]);

    return (
        <div
            ref={containerRef}
            className={`${s.item}${grid ? ` ${s.itemGrid}` : ""}${selected ? ` ${s.itemSelected}` : ""}${active ? ` ${s.itemActive}` : ""}`}
            style={itemStyle}
            onClick={(e) => onSelect(index, e)}
            onDoubleClick={() => onOpen?.(index)}
            onContextMenu={(e) => onContextMenu?.(e, index)}
            data-testid={`filmstrip-item-${img.id}`}
        >
            <div className={s.thumbWrapper} style={{ width: w, height: h }}>
                <canvas
                    ref={canvasRef}
                    className={s.canvas}
                    style={{ opacity: loaded ? 1 : 0 }}
                />
                {!loaded && (
                    <div className={s.loadingOverlay} aria-hidden>
                        <div className={s.spinner} />
                    </div>
                )}
                <button
                    type="button"
                    className={s.deleteBtn}
                    onClick={(e) => {
                        e.stopPropagation();
                        ActionService.deleteSelected([img.id]);
                    }}
                    title="Remove image (⌫)"
                    aria-label="Remove image"
                    data-testid={`filmstrip-delete-btn-${img.id}`}
                >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M1.5 1.5L6.5 6.5M6.5 1.5L1.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                </button>
                {edited && (
                    <div className={s.editDot} aria-hidden>
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M6 1L8 3L2.5 8.5H0.5V6.5L6 1Z" fill="white" />
                        </svg>
                    </div>
                )}
            </div>
            {!grid && <span className={s.label}>{img.filename}</span>}
        </div>
    );
});

const LINE_ITEM_W = 80;
const LINE_GAP = 8;
const LINE_STEP = LINE_ITEM_W + LINE_GAP;
const LINE_PAD_X = 12;
const LINE_OVERSCAN = 3;

const GRID_ITEM_W = 176;
const GRID_ITEM_H = 132;
const GRID_GAP_PX = 12;
const GRID_COL_STEP = GRID_ITEM_W + GRID_GAP_PX;
const GRID_ROW_STEP = GRID_ITEM_H + GRID_GAP_PX;
const GRID_PAD_X = 16;
const GRID_OVERSCAN_ROWS = 2;
const GRID_TOP_OFFSET = 0;
const GRID_BOTTOM_PAD = 48;

/** Cache key for an entry rendered at exactly `maxDim`. Matches `thumbRev` logic. */
function thumbKey(id: string, adjOrHash: Adjustments | number, quality: "fast" | "hq", maxDim: number): string {
    const h = typeof adjOrHash === "number" ? adjOrHash : hashAdjustments(adjOrHash);
    return `${id}:${quality}:${maxDim}:${h}`;
}

/** True when an entry satisfies an `hq` request at `maxDim`. */
function isHqEntryUsable(
    entry: { quality: "fast" | "hq"; adjHash?: number; adjJson?: string; maxDim?: number } | undefined,
    adjHash: number,
    adjustmentsJson: string,
    maxDim: number,
): boolean {
    if (entry === undefined || entry.quality !== "hq") return false;
    const sameAdj = entry.adjHash === adjHash
        || (entry.adjHash === undefined && entry.adjJson === adjustmentsJson);
    return sameAdj && entry.maxDim === maxDim;
}

/** One queued thumbnail request. Carries everything the dispatcher needs to
 *  re-validate the item at *dispatch* time (it may have gone stale while queued). */
interface ThumbQueueItem {
    id: string;
    adjHash: number;
    adjustments: Adjustments;
    quality: "fast" | "hq";
    maxDim: number;
}

interface ThumbQueue {
    fast: ThumbQueueItem[];
    hq: ThumbQueueItem[];
    inFlight: number;
}


function computeNextIndex(
    current: number,
    total: number,
    direction: FilmstripDirection,
    count: number,
    clamp?: boolean
): number {
    if (total === 0) return 0;
    const raw = current + direction * count;
    return clamp
        ? Math.max(0, Math.min(total - 1, raw))
        : ((raw % total) + total) % total;
}

export const Filmstrip = memo(({ focused }: {
    focused: boolean;
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const images = useAppState(s => s.images);
    const activeIndex = useAppState(s => s.activeIndex);
    const selectedIds = useAppState(s => s.selectedIds);
    const filmstripView = useAppState(s => s.filmstripView);
    const grid = filmstripView === "grid";

    const [scrollPos, setScrollPos] = useState({ left: 0, top: 0 });
    const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 });
    const rafScrollUpdateRef = useRef<number | null>(null);

    const [visualIndex, setVisualIndex] = useState(activeIndex);
    const visualIndexRef = useRef(activeIndex);
    visualIndexRef.current = visualIndex;

    const [visualSelectedIds, setVisualSelectedIds] = useState(selectedIds);
    const visualSelectedIdsRef = useRef(selectedIds);
    visualSelectedIdsRef.current = visualSelectedIds;

    const anchorIndexRef = useRef(activeIndex);
    const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafCursorRef = useRef<number | null>(null);
    const gridColsRef = useRef(1);

    const [thumbRev, setThumbRev] = useState(0);
    const loadingKeysRef = useRef<Set<string>>(new Set());
    const isMountedRef = useRef(true);

    const viewW = viewportSize.width;
    const viewH = viewportSize.height;

    const totalLineWidth = images.length === 0 ? 0 : LINE_PAD_X * 2 + images.length * LINE_STEP - LINE_GAP;
    const firstVisCol = Math.max(0, Math.floor((scrollPos.left - LINE_PAD_X) / LINE_STEP));
    const lastVisCol = Math.min(
        images.length - 1,
        Math.ceil((scrollPos.left + viewW - LINE_PAD_X) / LINE_STEP)
    );
    const lineStart = Math.max(0, firstVisCol - LINE_OVERSCAN);
    const lineEnd = Math.min(images.length - 1, lastVisCol + LINE_OVERSCAN);

    const gridCols = Math.max(1, Math.floor((viewW - GRID_PAD_X * 2 + GRID_GAP_PX) / GRID_COL_STEP));
    gridColsRef.current = gridCols;
    const totalGridColsW = gridCols * GRID_COL_STEP - GRID_GAP_PX;
    const totalGridRows = Math.ceil(images.length / gridCols);
    const totalGridHeight = totalGridRows === 0 ? 0 : totalGridRows * GRID_ROW_STEP - GRID_GAP_PX;

    const trackScrollTop = Math.max(0, scrollPos.top - GRID_TOP_OFFSET);
    const firstVisRow = Math.max(0, Math.floor(trackScrollTop / GRID_ROW_STEP));
    const lastVisRow = Math.min(totalGridRows - 1, Math.ceil((trackScrollTop + viewH) / GRID_ROW_STEP));
    const gridStartRow = Math.max(0, firstVisRow - GRID_OVERSCAN_ROWS);
    const gridEndRow = Math.min(totalGridRows - 1, lastVisRow + GRID_OVERSCAN_ROWS);
    const gridStart = gridStartRow * gridCols;
    const gridEnd = Math.min(images.length - 1, (gridEndRow + 1) * gridCols - 1);

    const startIndex = grid ? gridStart : lineStart;
    const endIndex = grid ? gridEnd : lineEnd;

    const visibleIds = useMemo(() => {
        const ids = new Set<string>();
        for (let i = startIndex; i <= endIndex; i++) {
            const img = images[i];
            if (img) ids.add(img.id);
        }
        return ids;
    }, [images, startIndex, endIndex]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        if (grid) {
            el.scrollLeft = 0;
        } else {
            el.scrollTop = 0;
        }
        setScrollPos({ left: el.scrollLeft, top: el.scrollTop });
    }, [grid]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const updateSize = () => {
            const w = el.clientWidth > 0 ? el.clientWidth : (typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1200);
            const h = el.clientHeight > 0 ? el.clientHeight : (typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 800);
            setViewportSize({ width: w, height: h });
        };
        updateSize();
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(updateSize);
        ro.observe(el);
        return () => ro.disconnect();
    }, [grid]);

    const handleScroll = useCallback(() => {
        if (rafScrollUpdateRef.current !== null) return;
        rafScrollUpdateRef.current = requestAnimationFrame(() => {
            rafScrollUpdateRef.current = null;
            const el = containerRef.current;
            if (!el) return;
            setScrollPos({ left: el.scrollLeft, top: el.scrollTop });
        });
    }, []);

    useEffect(() => {
        if (navTimerRef.current === null) {
            setVisualIndex(activeIndex);
            visualIndexRef.current = activeIndex;
            anchorIndexRef.current = activeIndex;
        }
    }, [activeIndex]);

    useEffect(() => {
        setVisualSelectedIds(selectedIds);
        visualSelectedIdsRef.current = selectedIds;
    }, [selectedIds]);

    useEffect(() => {
        if (images.length === 0) {
            setVisualIndex(0);
            visualIndexRef.current = 0;
            return;
        }
        if (visualIndexRef.current >= images.length) {
            const clamped = images.length - 1;
            setVisualIndex(clamped);
            visualIndexRef.current = clamped;
        }
        // Repair a stale activeIndex (e.g. after images were removed) so the
        // adjustments panel and preview never lose their target image.
        if (useAppState.getState().activeIndex >= images.length) {
            useAppState.getState().setActiveImage(images.length - 1);
        }
    }, [images.length]);

    const flushNavSync = useCallback(() => {
        if (navTimerRef.current !== null) {
            clearTimeout(navTimerRef.current);
            navTimerRef.current = null;
            const total = useAppState.getState().images.length;
            if (total === 0) return;
            const targetIdx = Math.max(0, Math.min(total - 1, visualIndexRef.current));
            const targetSelected = visualSelectedIdsRef.current;
            useAppState.setState({ activeIndex: targetIdx, selectedIds: targetSelected });
        }
    }, []);

    const flushNavSyncRef = useRef(flushNavSync);
    flushNavSyncRef.current = flushNavSync;

    const scheduleNavMove = useCallback((direction: FilmstripDirection, count: number, extend: boolean, clamp?: boolean) => {
        const state = useAppState.getState();
        const total = state.images.length;
        if (total === 0) return;

        const current = visualIndexRef.current;
        const nextIdx = computeNextIndex(current, total, direction, count, clamp);

        let nextSelected: Set<string>;
        if (extend) {
            const anchor = anchorIndexRef.current;
            const [lo, hi] = anchor <= nextIdx ? [anchor, nextIdx] : [nextIdx, anchor];
            nextSelected = new Set(visualSelectedIdsRef.current);
            for (let i = lo; i <= hi; i++) {
                const img = state.images[i];
                if (img) nextSelected.add(img.id);
            }
        } else {
            anchorIndexRef.current = nextIdx;
            const target = state.images[nextIdx];
            nextSelected = target ? new Set([target.id]) : new Set();
        }

        visualIndexRef.current = nextIdx;
        visualSelectedIdsRef.current = nextSelected;

        if (rafCursorRef.current !== null) {
            cancelAnimationFrame(rafCursorRef.current);
        }
        rafCursorRef.current = requestAnimationFrame(() => {
            rafCursorRef.current = null;
            setVisualIndex(nextIdx);
            setVisualSelectedIds(nextSelected);
            const container = containerRef.current;
            if (container) {
                const w = container.clientWidth > 0 ? container.clientWidth : viewportSize.width;
                const h = container.clientHeight > 0 ? container.clientHeight : viewportSize.height;
                if (grid) {
                    const cols = gridColsRef.current;
                    const targetRow = Math.floor(nextIdx / cols);
                    const itemTop = GRID_TOP_OFFSET + targetRow * GRID_ROW_STEP;
                    const itemBottom = itemTop + GRID_ITEM_H;
                    const curTop = container.scrollTop;
                    const visibleH = h - GRID_BOTTOM_PAD;
                    if (itemTop < curTop + GRID_TOP_OFFSET) {
                        const targetScroll = targetRow === 0 ? 0 : itemTop - GRID_TOP_OFFSET;
                        container.scrollTop = targetScroll;
                    } else if (itemBottom > curTop + visibleH) {
                        container.scrollTop = itemBottom - visibleH;
                    }
                } else {
                    const itemLeft = LINE_PAD_X + nextIdx * LINE_STEP;
                    const targetScroll = Math.max(0, itemLeft - Math.floor((w - LINE_ITEM_W) / 2));
                    container.scrollLeft = targetScroll;
                }
                setScrollPos({ left: container.scrollLeft, top: container.scrollTop });
            }
        });

        if (navTimerRef.current !== null) {
            clearTimeout(navTimerRef.current);
        }
        navTimerRef.current = setTimeout(() => {
            navTimerRef.current = null;
            const total = useAppState.getState().images.length;
            if (total === 0) return;
            const target = Math.max(0, Math.min(total - 1, visualIndexRef.current));
            if (extend) {
                useAppState.setState({ activeIndex: target, selectedIds: visualSelectedIdsRef.current });
            } else {
                useAppState.getState().setActiveImage(target);
            }
        }, 35);
    }, [grid]);

    const scheduleNavMoveRef = useRef(scheduleNavMove);
    scheduleNavMoveRef.current = scheduleNavMove;

    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null);

    const handleSelect = useCallback((i: number, e?: React.MouseEvent) => {
        if (navTimerRef.current !== null) {
            clearTimeout(navTimerRef.current);
            navTimerRef.current = null;
        }

        const state = useAppState.getState();
        const total = state.images.length;
        if (total === 0 || i < 0 || i >= total) return;

        const targetImg = state.images[i];
        if (!targetImg) return;

        let nextSelected: Set<string>;

        if (e && e.shiftKey) {
            const anchor = anchorIndexRef.current;
            const [lo, hi] = anchor <= i ? [anchor, i] : [i, anchor];
            nextSelected = new Set(visualSelectedIdsRef.current);
            for (let idx = lo; idx <= hi; idx++) {
                const img = state.images[idx];
                if (img) nextSelected.add(img.id);
            }
            setVisualIndex(i);
            visualIndexRef.current = i;
            setVisualSelectedIds(nextSelected);
            visualSelectedIdsRef.current = nextSelected;
            useAppState.setState({ activeIndex: i, selectedIds: nextSelected });
            return;
        } else if (e && (e.metaKey || e.ctrlKey)) {
            nextSelected = new Set(visualSelectedIdsRef.current);
            if (nextSelected.has(targetImg.id)) {
                nextSelected.delete(targetImg.id);
            } else {
                nextSelected.add(targetImg.id);
            }
            anchorIndexRef.current = i;
            setVisualIndex(i);
            visualIndexRef.current = i;
            setVisualSelectedIds(nextSelected);
            visualSelectedIdsRef.current = nextSelected;
            useAppState.setState({ activeIndex: i, selectedIds: nextSelected });
            return;
        } else {
            setVisualIndex(i);
            visualIndexRef.current = i;
            anchorIndexRef.current = i;
            nextSelected = new Set([targetImg.id]);
            setVisualSelectedIds(nextSelected);
            visualSelectedIdsRef.current = nextSelected;
            state.setActiveImage(i);
        }
    }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent, i: number) => {
        e.preventDefault();
        e.stopPropagation();

        const state = useAppState.getState();
        const clickedImg = state.images[i];
        if (!clickedImg) return;

        if (!visualSelectedIdsRef.current.has(clickedImg.id)) {
            setVisualIndex(i);
            visualIndexRef.current = i;
            anchorIndexRef.current = i;
            const nextSelected = new Set([clickedImg.id]);
            setVisualSelectedIds(nextSelected);
            visualSelectedIdsRef.current = nextSelected;
            state.setActiveImage(i);
        }

        setContextMenu({ x: e.clientX, y: e.clientY, index: i });
    }, []);

    const contextMenuItems: ContextMenuItem[] = useMemo(() => {
        if (!contextMenu) return [];
        const state = useAppState.getState();
        const targets = state.selectedIds.size > 0
            ? Array.from(state.selectedIds)
            : (state.images[contextMenu.index] ? [state.images[contextMenu.index]!.id] : []);

        return [
            {
                id: "copy",
                label: "Copy Adjustments",
                shortcut: "⌘C",
                onClick: () => {
                    ActionService.copyAdjustments();
                },
            },
            {
                id: "paste",
                label: "Paste Adjustments",
                shortcut: "⌘V",
                onClick: () => {
                    ActionService.pasteAdjustments(new Set(targets));
                },
            },
            {
                id: "rotate",
                label: "Rotate 90° Clockwise",
                shortcut: "r",
                onClick: () => {
                    ActionService.rotateCW();
                },
            },
            {
                id: "sep-1",
                label: "",
                separator: true,
            },
            {
                id: "export",
                label: targets.length > 1 ? `Export ${targets.length} Selected...` : "Export Selected...",
                shortcut: "e",
                onClick: () => {
                    ActionService.openExport();
                },
            },
            {
                id: "sep-2",
                label: "",
                separator: true,
            },
            {
                id: "delete",
                label: targets.length > 1 ? `Remove ${targets.length} from Session` : "Remove from Session",
                shortcut: "⌫",
                destructive: true,
                onClick: () => {
                    ActionService.deleteSelected(targets);
                },
            },
        ];
    }, [contextMenu]);

    const handleOpen = useCallback((i: number) => {
        handleSelect(i);
        if (grid) {
            useAppState.getState().setFilmstripView("strip");
        }
        setActivePanel(Panel.Adjustments);
    }, [grid, handleSelect]);

    const batchRafRef = useRef<number | null>(null);
    const queueRef = useRef<ThumbQueue>({ fast: [], hq: [], inFlight: 0 });
    const visibleIdsRef = useRef(visibleIds);
    visibleIdsRef.current = visibleIds;

    // Validate a queued unit at dispatch time: drop it if it scrolled out of view
    // or if its adjustments changed while it sat in the queue.
    const isQueueItemStale = useCallback((unit: ThumbQueueItem): boolean => {
        if (!visibleIdsRef.current.has(unit.id)) return true;
        const img = useAppState.getState().images.find(i => i.id === unit.id);
        if (!img) return true;
        return hashAdjustments(img.adjustments) !== unit.adjHash;
    }, []);

    const dispatchBatch = useCallback((units: ThumbQueueItem[]) => {
        const queue = queueRef.current;
        queue.inFlight++;
        getBackend()
            .then(backend => backend.renderThumbnails(units.map(unit => ({
                id: unit.id,
                adj: unit.adjustments,
                quality: unit.quality,
                maxDim: unit.maxDim,
            }))))
            .then(results => {
                for (let i = 0; i < units.length; i++) {
                    const unit = units[i];
                    const data = results[i];
                    if (unit && data) {
                        thumbnailRegistry.set(unit.id, {
                            data,
                            quality: unit.quality,
                            adjHash: unit.adjHash,
                            maxDim: unit.maxDim,
                        });
                    }
                }
            })
            .catch(err => {
                console.error("Failed to render thumbnails:", err);
            })
            .finally(() => {
                for (const unit of units) {
                    loadingKeysRef.current.delete(thumbKey(unit.id, unit.adjHash, unit.quality, unit.maxDim));
                }
                queue.inFlight--;
                if (isMountedRef.current) {
                    setThumbRev(r => r + 1);
                }
                pumpQueueRef.current();
            });
    }, []);

    // Dispatcher: drains the fast queue strictly before the HQ queue, running at
    // most `MAX_CONCURRENT_THUMB_BATCHES` batches at a time. Each finished batch
    // re-validates what is left and pumps again. Slots are freed in `finally`,
    // so a rejected batch can never stall the pipeline.
    const pumpQueue = useCallback(() => {
        const queue = queueRef.current;
        while (queue.inFlight < MAX_CONCURRENT_THUMB_BATCHES) {
            const fastTier = queue.fast.length > 0;
            const source = fastTier ? queue.fast : queue.hq;
            const limit = fastTier ? FAST_THUMBNAILS_PER_BATCH : HQ_THUMBNAILS_PER_BATCH;

            const units: ThumbQueueItem[] = [];
            while (units.length < limit && source.length > 0) {
                const unit = source.shift()!;
                if (isQueueItemStale(unit)) {
                    loadingKeysRef.current.delete(thumbKey(unit.id, unit.adjHash, unit.quality, unit.maxDim));
                    continue;
                }
                units.push(unit);
            }

            if (units.length === 0) {
                // This tier yielded nothing valid. If the fast tier was the one we
                // just drained, fall through and try the HQ tier; otherwise stop.
                if (fastTier && queue.hq.length > 0) continue;
                return;
            }
            dispatchBatch(units);
        }
    }, [dispatchBatch, isQueueItemStale]);

    const pumpQueueRef = useRef(pumpQueue);
    pumpQueueRef.current = pumpQueue;

    // The RAF effect only enqueues; it never performs IPC work itself.
    useEffect(() => {
        if (batchRafRef.current !== null) {
            cancelAnimationFrame(batchRafRef.current);
            batchRafRef.current = null;
        }

        batchRafRef.current = requestAnimationFrame(() => {
            batchRafRef.current = null;

            const hqMaxDim = grid ? HQ_THUMB_MAX_DIM.grid : HQ_THUMB_MAX_DIM.strip;
            const visible = images.filter(img => visibleIds.has(img.id));
            const imgIndexMap = new Map(images.map((img, idx) => [img.id, idx]));
            const currentActive = visualIndexRef.current;
            const distanceOf = (id: string) => Math.abs((imgIndexMap.get(id) ?? 0) - currentActive);

            const enqueue = (quality: "fast" | "hq", maxDim: number, items: { img: ImageEntry; adjHash: number }[]) => {
                const queue = queueRef.current[quality];
                const queuedIds = new Set(queue.map(q => q.id));
                const sorted = items
                    .slice()
                    .sort((a, b) => distanceOf(a.img.id) - distanceOf(b.img.id));
                for (const { img, adjHash } of sorted) {
                    if (queuedIds.has(img.id)) continue;
                    queue.push({
                        id: img.id,
                        adjHash,
                        adjustments: img.adjustments,
                        quality,
                        maxDim,
                    });
                    queuedIds.add(img.id);
                    loadingKeysRef.current.add(thumbKey(img.id, adjHash, quality, maxDim));
                }
            };

            const neededFast: { img: ImageEntry; adjHash: number }[] = [];
            const neededHq: { img: ImageEntry; adjHash: number }[] = [];
            for (const img of visible) {
                const adjHash = hashAdjustments(img.adjustments);
                const current = thumbnailRegistry.get(img.id);
                const adjustmentsJson = JSON.stringify(img.adjustments);
                const isCurrentAdj = current !== undefined && (current.adjHash === adjHash || (current.adjHash === undefined && current.adjJson === adjustmentsJson));
                const fastKey = thumbKey(img.id, adjHash, "fast", FAST_THUMB_MAX_DIM);
                if (!isCurrentAdj && !loadingKeysRef.current.has(fastKey)) {
                    neededFast.push({ img, adjHash });
                } else if (isCurrentAdj && !isHqEntryUsable(current, adjHash, adjustmentsJson, hqMaxDim)) {
                    const hqKey = thumbKey(img.id, adjHash, "hq", hqMaxDim);
                    if (!loadingKeysRef.current.has(hqKey)) {
                        neededHq.push({ img, adjHash });
                    }
                }
            }

            enqueue("fast", FAST_THUMB_MAX_DIM, neededFast);
            enqueue("hq", hqMaxDim, neededHq);
            pumpQueueRef.current();
        });

        return () => {
            if (batchRafRef.current !== null) {
                cancelAnimationFrame(batchRafRef.current);
                batchRafRef.current = null;
            }
        };
    }, [images, visibleIds, thumbRev, grid]);

    useEffect(() => {
        isMountedRef.current = true;
        const handleFocus = () => {
            if (isMountedRef.current) {
                setThumbRev(r => r + 1);
            }
        };
        window.addEventListener("focus", handleFocus);
        return () => {
            isMountedRef.current = false;
            window.removeEventListener("focus", handleFocus);
            if (navTimerRef.current !== null) {
                clearTimeout(navTimerRef.current);
                navTimerRef.current = null;
            }
            if (rafCursorRef.current !== null) {
                cancelAnimationFrame(rafCursorRef.current);
                rafCursorRef.current = null;
            }
            if (rafScrollUpdateRef.current !== null) {
                cancelAnimationFrame(rafScrollUpdateRef.current);
                rafScrollUpdateRef.current = null;
            }
            if (batchRafRef.current !== null) {
                cancelAnimationFrame(batchRafRef.current);
                batchRafRef.current = null;
            }
        };
    }, []);

    // Single keyboard handler for the whole filmstrip — registered once on the
    // parent so deleting/mounting items can never leave the handler missing.
    useEffect(() => {
        keyboardManager.register(RegistrationID.filmstrip, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;

            const grid = useAppState.getState().filmstripView === "grid";
            const count = e.count;
            switch (e.key) {
                case Key.h:
                    scheduleNavMoveRef.current(FilmstripDirection.Backward, count, false); return true;
                case Key.l:
                    scheduleNavMoveRef.current(FilmstripDirection.Forward, count, false); return true;
                case Key.h.toUpperCase():
                    scheduleNavMoveRef.current(FilmstripDirection.Backward, count, true); return true;
                case Key.l.toUpperCase():
                    scheduleNavMoveRef.current(FilmstripDirection.Forward, count, true); return true;
                case Key.j:
                    if (!grid) {
                        // Vertical navigation from the bottom strip moves focus
                        // up into the adjustments panel.
                        if (useAppState.getState().images.length > 0) setActivePanel(Panel.Adjustments);
                        return true;
                    }
                    scheduleNavMoveRef.current(FilmstripDirection.Forward, count * gridColsRef.current, false, true); return true;
                case Key.k:
                    if (!grid) {
                        if (useAppState.getState().images.length > 0) setActivePanel(Panel.Adjustments);
                        return true;
                    }
                    scheduleNavMoveRef.current(FilmstripDirection.Backward, count * gridColsRef.current, false, true); return true;
                case Key.j.toUpperCase():
                    if (!grid) return false;
                    scheduleNavMoveRef.current(FilmstripDirection.Forward, count * gridColsRef.current, true); return true;
                case Key.k.toUpperCase():
                    if (!grid) return false;
                    scheduleNavMoveRef.current(FilmstripDirection.Backward, count * gridColsRef.current, true); return true;
                case Key.Escape: {
                    flushNavSyncRef.current();
                    if (grid) {
                        useAppState.getState().setFilmstripView("strip");
                        return true;
                    }
                    const { images, activeIndex, selectOne, selectClear } = useAppState.getState();
                    const image = images[activeIndex];
                    if (image) {
                        selectOne(image.id);
                    } else {
                        selectClear();
                    }
                    return true;
                }

                case Key.y:
                case Key.c:
                case Key.C: {
                    if ((e.key === Key.c || e.key === Key.C) && !e.meta) return false;
                    flushNavSyncRef.current();
                    useAppState.getState().yankAdjustments();
                    useAppState.getState().showToast("yanked");
                    return true;
                }
                case Key.p:
                case Key.v:
                case Key.V: {
                    if ((e.key === Key.v || e.key === Key.V) && !e.meta) return false;
                    flushNavSyncRef.current();
                    const { selectedIds, pasteAdjustments, images, activeIndex } = useAppState.getState();
                    const targetIds = selectedIds.size > 0
                        ? selectedIds
                        : (images[activeIndex] ? new Set([images[activeIndex].id]) : new Set<string>());
                    if (targetIds.size > 0) {
                        pasteAdjustments(targetIds);
                        useAppState.getState().showToast(targetIds.size > 1 ? `pasted to ${targetIds.size} images` : "pasted");
                    }
                    return true;
                }
                case Key.a:
                case Key.A: {
                    if (!e.meta) return false;
                    flushNavSyncRef.current();
                    ActionService.execute(CommandId.EditSelectAll);
                    return true;
                }
                case Key.u:
                case Key.z:
                case Key.Z: {
                    if (e.key === Key.z || e.key === Key.Z) {
                        if (!e.meta) return false;
                        if (e.shift) {
                            flushNavSyncRef.current();
                            ActionService.execute(CommandId.EditRedo);
                            return true;
                        }
                    }
                    flushNavSyncRef.current();
                    ActionService.execute(CommandId.EditUndo);
                    return true;
                }
                case Key.r: {
                    if (e.meta) return false;
                    flushNavSyncRef.current();
                    ActionService.execute(CommandId.EditRedo);
                    return true;
                }
                case Key.Enter:
                    e.origin.preventDefault();
                    flushNavSyncRef.current();
                    if (grid) useAppState.getState().setFilmstripView("strip");
                    setActivePanel(Panel.Adjustments);
                    return true;
                case Key.Tab:
                    return grid;
                default:
                    return false;
            }
        }, false);
        return () => { keyboardManager.unregister(RegistrationID.filmstrip); };
    }, []);

    useEffect(() => {
        if (navTimerRef.current !== null) return;
        const container = containerRef.current;
        if (!container) return;
        const w = container.clientWidth > 0 ? container.clientWidth : viewportSize.width;
        const h = container.clientHeight > 0 ? container.clientHeight : viewportSize.height;
        if (grid) {
            const cols = gridColsRef.current;
            const targetRow = Math.floor(activeIndex / cols);
            const itemTop = GRID_TOP_OFFSET + targetRow * GRID_ROW_STEP;
            const itemBottom = itemTop + GRID_ITEM_H;
            const curTop = container.scrollTop;
            const visibleH = h - GRID_BOTTOM_PAD;
            if (itemTop < curTop + GRID_TOP_OFFSET) {
                const targetScroll = targetRow === 0 ? 0 : itemTop - GRID_TOP_OFFSET;
                if (typeof container.scrollTo === "function") {
                    container.scrollTo({ top: targetScroll, behavior: "smooth" });
                } else {
                    container.scrollTop = targetScroll;
                }
            } else if (itemBottom > curTop + visibleH) {
                const targetScroll = itemBottom - visibleH;
                if (typeof container.scrollTo === "function") {
                    container.scrollTo({ top: targetScroll, behavior: "smooth" });
                } else {
                    container.scrollTop = targetScroll;
                }
            }
        } else {
            const itemLeft = LINE_PAD_X + activeIndex * LINE_STEP;
            const targetScroll = Math.max(0, itemLeft - Math.floor((w - LINE_ITEM_W) / 2));
            if (typeof container.scrollTo === "function") {
                container.scrollTo({ left: targetScroll, behavior: "smooth" });
            } else {
                container.scrollLeft = targetScroll;
            }
        }
    }, [activeIndex, grid, viewportSize.width, viewportSize.height]);

    const visibleSlice: { img: ImageEntry; index: number; left: number; top: number }[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const img = images[i];
        if (!img) continue;
        let left: number;
        let top: number;
        if (grid) {
            const c = i % gridCols;
            const r = Math.floor(i / gridCols);
            left = c * GRID_COL_STEP;
            top = r * GRID_ROW_STEP;
        } else {
            left = LINE_PAD_X + i * LINE_STEP;
            top = 8;
        }
        visibleSlice.push({ img, index: i, left, top });
    }

    const selectedName = grid ? images[visualIndex]?.filename : undefined;

    return (
        <>
            <div
                ref={containerRef}
                data-testid="filmstrip"
                className={`${grid ? s.filmstripGrid : s.filmstrip}${focused ? ` ${s.filmstripFocused}` : ""}`}
                onScroll={handleScroll}
                onPointerDown={() => {
                    const store = useAppState.getState();
                    if (store.geometryEdit) store.setGeometryEdit(false);
                    setActivePanel(Panel.Filmstrip);
                }}
            >
                <div
                    className={grid ? s.virtualTrackGrid : s.virtualTrack}
                    style={grid ? { width: `${totalGridColsW}px`, height: `${totalGridHeight}px`, margin: "0 auto" } : { width: `${totalLineWidth}px` }}
                >
                    {visibleSlice.map(({ img, index, left, top }) => (
                        <FilmstripItem
                            key={img.id}
                            img={img}
                            grid={grid}
                            active={index === visualIndex}
                            selected={visualSelectedIds.has(img.id)}
                            index={index}
                            onSelect={handleSelect}
                            onOpen={handleOpen}
                            onContextMenu={handleContextMenu}
                            pixelData={thumbnailRegistry.get(img.id)?.data}
                            left={left}
                            top={top}
                        />
                    ))}
                </div>
            </div>
            {grid && (
                <div className={s.bottomBar}>
                    <span>{selectedName ? `${visualIndex + 1} of ${images.length} — ${selectedName}` : ""}</span>
                    <span>Press Enter or double-click to edit</span>
                </div>
            )}
            {contextMenu && (
                <ContextMenu
                    items={contextMenuItems}
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
});
