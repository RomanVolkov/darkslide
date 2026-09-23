import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { ImageEntry, ImageID, AdjustmentKey, SessionSummary } from "../types";
import { LoadedImage, Adjustments, Histogram, PixelData } from "../backend/types";
import { DEFAULT_ADJUSTMENTS, ADJ_GET, ADJ_SET, normalizeAdjustments } from "../types/adjustments.ts";
import {
    SLIDER_MIN,
    SLIDER_MAX,
    SLIDER_STEP,
    SLIDER_STEP_BIG,
} from "../components/Slider/sliderConfig.ts";
import { Panel } from "../components/constants/index.ts";
import { ImageProcessor } from "../services/ImageProcessor";
import { ImageFormat, PngCompression } from "../components/types";
import { invoke } from "@tauri-apps/api/core";
import { thumbnailRegistry } from "../services/thumbnailRegistry";
import { beginApply, endApply, undo as historyUndo, redo as historyRedo } from "../services/undoHistory";

export const FilmstripDirection = {
    Backward: -1,
    Forward: 1,
} as const;

export type FilmstripDirection = typeof FilmstripDirection[keyof typeof FilmstripDirection];
export type FilmstripView = "strip" | "grid";

export const SliderDirection = {
    Decrease: -1,
    Increase: 1,
} as const;

export type SliderDirection = typeof SliderDirection[keyof typeof SliderDirection];

export const SliderStep = {
    Normal: "normal",
    Big: "big",
} as const;
export type SliderStep = typeof SliderStep[keyof typeof SliderStep];

export interface AppState {
    images: ImageEntry[]
    activeIndex: number
    selectedIds: Set<ImageID>
    focusPanel: Panel

    loadProgress: { done: number; total: number } | null
    exportProgress: { done: number; total: number } | null

    showKeymap: boolean;
    showExport: boolean;
    showOriginal: boolean;
    showEraseConfirm: boolean;
    geometryEdit: boolean;

    sessionId: number | null;
    sessions: SessionSummary[];
    showSessions: boolean;

    filmstripView: FilmstripView;
    renderedData: PixelData | null;
    renderedImageId: ImageID | null;
    renderedHistogram: Histogram | null;
    /** Monotonic counter, incremented each time a preview render completes. */
    renderSeq: number;
    toastMessage: string;

    loadImages: (loaded: LoadedImage[], replace: boolean) => void
    deleteImages: (ids: Set<ImageID>) => void
    restoreImages: (items: Array<{ entry: ImageEntry; index: number }>, sessionId?: number | null) => void
    setActiveImage: (index: number) => void
    moveActiveImage: (direction: FilmstripDirection, count: number, extend: boolean, clamp?: boolean) => void

    selectOne: (id: ImageID) => void
    selectClear: () => void
    selectExtend: (id: ImageID) => void
    selectAll: () => void

    yankAdjustments: () => void
    pasteAdjustments: (ids: Set<ImageID>) => void

    updateImage: (id: ImageID, updater: (img: ImageEntry) => void) => void
    adjustSlider: (key: AdjustmentKey, direction: SliderDirection, step: SliderStep, count: number) => void;
    resetSlider: (key: AdjustmentKey) => void
    resetAdjustments: () => void
    undoAdjustment: () => void
    redoAdjustment: () => void

    setFocusPanel: (panel: Panel) => void

    setLoadProgress: (progress: { done: number; total: number } | null) => void;
    setExportProgress: (progress: { done: number; total: number } | null) => void;

    setShowKeymap: (v: boolean) => void;
    setShowExport: (v: boolean) => void;
    setShowOriginal: (v: boolean) => void;
    setShowEraseConfirm: (v: boolean) => void;
    setGeometryEdit: (v: boolean) => void;
    setSession: (id: number | null) => void;
    setSessions: (sessions: SessionSummary[]) => void;
    setShowSessions: (v: boolean) => void;
    eraseAllAdjustments: () => Promise<void>;
    setFilmstripView: (v: FilmstripView) => void;
    setRenderedPreview: (data: PixelData | null, histogram: Histogram | null, imageId?: ImageID | null) => void;
    showToast: (msg: string) => void;
    exportImages: (processor: ImageProcessor, format: ImageFormat, quality: number | null, pngCompression: PngCompression | null, showToast: (msg: string) => void) => void;
}

let _clipboard: Adjustments | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Apply an undo/redo snapshot exactly like pasteAdjustments applies edits:
 * mute the history listener, swap adjustments, invalidate the thumbnail,
 * persist to SQLite. Preview re-render follows via ImageRenderer's
 * store subscription. Runs after store creation, so referencing
 * useAppState here is safe.
 */
function applyHistorySnapshot(id: ImageID, snapshot: Adjustments): void {
    beginApply();
    try {
        useAppState.setState(state => {
            const img = state.images.find(i => i.id === id);
            if (img) img.adjustments = snapshot;
        });
    } finally {
        endApply();
    }
    thumbnailRegistry.delete(id);
    invoke("update_adjustments", { id, adjustments: snapshot }).catch(() => {});
}

export const useAppState = create<AppState>()(
    immer((set, get) => ({
        images: [],
        activeIndex: 0,
        selectedIds: new Set(),
        focusPanel: Panel.Adjustments,
        loadProgress: null,
        exportProgress: null,
        showKeymap: false,
        showExport: false,
        showOriginal: false,
        showEraseConfirm: false,
        geometryEdit: false,
        sessionId: null,
        sessions: [],
        showSessions: false,
        filmstripView: "strip",
        renderedData: null,
        renderedImageId: null,
        renderedHistogram: null,
        renderSeq: 0,
        toastMessage: "",

        loadImages: (loaded: LoadedImage[], replace: boolean) => set(state => {
            const sortedLoaded = [...loaded].sort((a, b) =>
                a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" })
            );
            const values = sortedLoaded.map<ImageEntry>(l => ({
                id: l.id,
                filename: l.filename,
                adjustments: l.adjustments,
            }));

            if (replace) {
                state.images = values;
                state.activeIndex = 0;
                state.selectedIds = new Set();
                state.filmstripView = "strip";
            } else {
                state.activeIndex = state.images.length;
                state.images.push(...values);
            }
        }),

        setActiveImage: (index: number) => set(state => {
            if (state.images.length === 0) return;
            const img = state.images[index];
            if (!img) return;
            state.activeIndex = index;
            state.selectedIds = new Set([img.id]);
        }),

        moveActiveImage: (direction: FilmstripDirection, count: number, extend: boolean, clamp?: boolean) => set(state => {
            const total = state.images.length;
            if (total === 0) return;

            const raw = state.activeIndex + direction * count;
            if (extend) {
                const clamped = Math.max(0, Math.min(total - 1, raw));
                const [lo, hi] = state.activeIndex <= clamped
                    ? [state.activeIndex, clamped]
                    : [clamped, state.activeIndex];

                const ids = new Set(state.selectedIds);
                for (let i = lo; i <= hi; i++) {
                    const img = state.images[i];
                    if (img) ids.add(img.id);
                }
                state.selectedIds = ids;
                state.activeIndex = clamped;
            } else {
                const nextIdx = clamp
                    ? Math.max(0, Math.min(total - 1, raw))
                    : ((raw % total) + total) % total;
                const next = state.images[nextIdx];
                if (next) state.selectedIds = new Set([next.id]);
                state.activeIndex = nextIdx;
            }
        }),

        selectOne: (id: ImageID) => set(state => {
            state.selectedIds = new Set([id]);
        }),

        selectExtend: (id: ImageID) => set(state => {
            state.selectedIds.add(id);
        }),

        selectClear: () => set(state => {
            state.selectedIds = new Set();
        }),

        selectAll: () => set(state => {
            state.selectedIds = new Set(state.images.map((img: ImageEntry) => img.id));
        }),

        deleteImages: (ids: Set<ImageID>) => set(state => {
            state.images = state.images.filter((img: ImageEntry) => !ids.has(img.id));
            state.activeIndex = Math.max(0, Math.min(state.activeIndex, state.images.length - 1));
            state.selectedIds = new Set();
            if (state.images.length === 0) {
                state.filmstripView = "strip";
                state.sessionId = null;
            }
            for (const id of ids) {
                thumbnailRegistry.delete(id);
            }
        }),

        restoreImages: (items: Array<{ entry: ImageEntry; index: number }>, sessionId?: number | null) => set(state => {
            const sorted = [...items].sort((a, b) => a.index - b.index);
            for (const item of sorted) {
                const idx = Math.max(0, Math.min(item.index, state.images.length));
                if (!state.images.some(img => img.id === item.entry.id)) {
                    state.images.splice(idx, 0, item.entry);
                }
            }
            if (sessionId !== undefined && sessionId !== null && state.sessionId === null) {
                state.sessionId = sessionId;
            }
            const restoredIds = items.map(item => item.entry.id);
            state.selectedIds = new Set(restoredIds);
            if (sorted.length > 0) {
                const targetIdx = state.images.findIndex(img => img.id === sorted[0]!.entry.id);
                if (targetIdx !== -1) {
                    state.activeIndex = targetIdx;
                }
            }
        }),

        resetAdjustments: () => set(state => {
            const activeImage = state.images[state.activeIndex];
            if (activeImage) {
                activeImage.adjustments = structuredClone(DEFAULT_ADJUSTMENTS);
            }
        }),

        yankAdjustments: () => {
            const adj = get().images[get().activeIndex]?.adjustments;
            if (adj) { _clipboard = { ...adj, rotation: 0 }; }
        },

        pasteAdjustments: (ids: Set<ImageID>) => {
            const value = _clipboard;
            if (!value) return;

            set(state => {
                state.images
                    .filter((i: ImageEntry) => ids.has(i.id))
                    .forEach((i: ImageEntry) => {
                        i.adjustments = normalizeAdjustments({ ...value, rotation: i.adjustments.rotation });
                    });
            });

            for (const id of ids) {
                thumbnailRegistry.delete(id);
            }

            const currentImages = get().images;
            for (const id of ids) {
                const img = currentImages.find(i => i.id === id);
                if (img) {
                    invoke("update_adjustments", { id: img.id, adjustments: img.adjustments }).catch(() => {});
                }
            }
        },

        updateImage: (id, updater) => set(state => {
            const img = state.images.find(i => i.id === id);
            if (img) updater(img);
        }),

        adjustSlider: (key, direction, step, count) => set(state => {
            const activeImg = state.images[state.activeIndex];
            if (!activeImg) return;

            const stepSize = step === SliderStep.Big ? (SLIDER_STEP_BIG[key] ?? 10) : (SLIDER_STEP[key] ?? 1);
            const min = SLIDER_MIN[key] ?? -100;
            const max = SLIDER_MAX[key] ?? 100;
            const current = ADJ_GET[key](normalizeAdjustments(activeImg.adjustments));
            const next = Math.min(max, Math.max(min, current + direction * stepSize * count));

            activeImg.adjustments = ADJ_SET[key](normalizeAdjustments(activeImg.adjustments), next);
        }),

        resetSlider: (key) => set(state => {
            const activeImg = state.images[state.activeIndex];
            if (!activeImg) return;

            const defaultValue = ADJ_GET[key](DEFAULT_ADJUSTMENTS);
            activeImg.adjustments = ADJ_SET[key](normalizeAdjustments(activeImg.adjustments), defaultValue);
        }),

        undoAdjustment: () => {
            const img = get().images[get().activeIndex];
            if (!img) return;
            const snapshot = historyUndo(img.id);
            if (snapshot) applyHistorySnapshot(img.id, snapshot);
        },

        redoAdjustment: () => {
            const img = get().images[get().activeIndex];
            if (!img) return;
            const snapshot = historyRedo(img.id);
            if (snapshot) applyHistorySnapshot(img.id, snapshot);
        },

        setFocusPanel: (panel: Panel) => set(state => { state.focusPanel = panel; }),
        setLoadProgress: (progress) => set(state => { state.loadProgress = progress; }),
        setExportProgress: (progress) => set(state => { state.exportProgress = progress; }),
        setShowKeymap: (v) => set(state => { state.showKeymap = v; }),
        setShowExport: (v) => set(state => { state.showExport = v; }),
        setShowOriginal: (v) => set(state => { state.showOriginal = v; }),
        setShowEraseConfirm: (v) => set(state => { state.showEraseConfirm = v; }),
        setGeometryEdit: (v) => set(state => { state.geometryEdit = v; }),
        setSession: (id) => set(state => { state.sessionId = id; }),
        setSessions: (sessions) => set(state => { state.sessions = sessions; }),
        setShowSessions: (v) => set(state => { state.showSessions = v; }),
        eraseAllAdjustments: async () => {
            await invoke("clear_all_adjustments").catch(() => {});
            set(state => {
                for (const img of state.images) {
                    img.adjustments = structuredClone(DEFAULT_ADJUSTMENTS);
                }
            });
            thumbnailRegistry.clear();
            get().showToast("All adjustments erased from database");
        },
        setFilmstripView: (v) => set(state => { state.filmstripView = v; }),
        setRenderedPreview: (data, histogram, imageId = null) => set(state => {
            state.renderedData = data;
            state.renderedImageId = imageId;
            state.renderedHistogram = histogram;
            if (data) state.renderSeq += 1;
        }),
        showToast: (msg: string) => {
            if (toastTimeout) clearTimeout(toastTimeout);
            set(state => { state.toastMessage = msg; });
            toastTimeout = setTimeout(() => {
                set(state => { state.toastMessage = ""; });
            }, 2000);
        },
        exportImages: (processor, format, quality, pngCompression, showToast) => {
            const { images, activeIndex, selectedIds } = get();
            const activeImg = images[activeIndex];
            let exportImgs: ImageEntry[];
            if (selectedIds.size > 0) {
                const exportIds = new Set([...selectedIds, ...(activeImg ? [activeImg.id] : [])]);
                exportImgs = images.filter((img) => exportIds.has(img.id));
            } else {
                exportImgs = activeImg ? [activeImg] : [];
            }
            if (exportImgs.length > 0) {
                processor.exportImages(
                    useAppState,
                    exportImgs,
                    format,
                    quality,
                    pngCompression,
                    showToast
                );
            }
        },
    }))
);

