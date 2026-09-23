import { ImageProcessor } from "./ImageProcessor";
import { useAppState } from "../state/appState";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import type { Adjustments } from "../backend/types";
import { invoke } from "@tauri-apps/api/core";

export const ADJ_COALESCE_MS = 25;
export const NAV_COALESCE_MS = 40;

export type RenderReason = "immediate" | "coalesced" | "nav";

export interface Scheduler {
    requestAnimationFrame(callback: FrameRequestCallback): number;
    cancelAnimationFrame(handle: number): void;
    setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: Scheduler = {
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => cancelAnimationFrame(id),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
};

interface RenderSpec {
    id: string;
    adj: Adjustments;
    showOriginal: boolean;
}

function getOriginalAdjustments(rotation: number): Adjustments {
    if (rotation === 0) return DEFAULT_ADJUSTMENTS;
    return { ...DEFAULT_ADJUSTMENTS, rotation };
}

function subscribeToActiveImage(callback: (reason: RenderReason) => void) {
    return useAppState.subscribe((state, prevState) => {
        const curIdx = state.activeIndex;
        const prevIdx = prevState.activeIndex;
        const curImg = state.images[curIdx];
        const prevImg = prevState.images[prevIdx];
        const idChanged = curImg?.id !== prevImg?.id;
        const showOriginalChanged = state.showOriginal !== prevState.showOriginal;
        if (idChanged) {
            const adjacentIds: string[] = [];
            const prev = state.images[curIdx - 1];
            if (curIdx > 0 && prev) {
                adjacentIds.push(prev.id);
            }
            const next = state.images[curIdx + 1];
            if (curIdx + 1 < state.images.length && next) {
                adjacentIds.push(next.id);
            }
            invoke("set_active_image", { id: curImg?.id ?? "", adjacent_ids: adjacentIds }).catch(() => {});
            callback("nav");
        } else if (showOriginalChanged) {
            callback("immediate");
        } else if (curImg?.adjustments !== prevImg?.adjustments) {
            callback("coalesced");
        }
    });
}

/**
 * Subscribes to the active image and schedules preview renders.
 *
 * Adjustment-only changes are coalesced with a short timeout so rapid slider
 * movements produce only one backend request. Image switches and "show original"
 * toggles render immediately. Each scheduled render gets a monotonic counter;
 * responses whose counter is older than the latest scheduled render are dropped,
 * preventing stale previews from overwriting newer results.
 */
export class ImageRenderer {
    private processor: ImageProcessor;
    private scheduler: Scheduler;
    private unsubscribe: (() => void) | null = null;
    private rafId: number | null = null;
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    private scheduled: RenderSpec | null = null;
    private latestRenderCount = 0;
    private lastRenderedCount = 0;

    constructor(processor: ImageProcessor, scheduler: Scheduler = defaultScheduler) {
        this.processor = processor;
        this.scheduler = scheduler;
    }

    start() {
        const state = useAppState.getState();
        const curIdx = state.activeIndex;
        const activeImage = state.images[curIdx];
        if (activeImage) {
            const adjacentIds: string[] = [];
            const prev = state.images[curIdx - 1];
            if (curIdx > 0 && prev) {
                adjacentIds.push(prev.id);
            }
            const next = state.images[curIdx + 1];
            if (curIdx + 1 < state.images.length && next) {
                adjacentIds.push(next.id);
            }
            invoke("set_active_image", { id: activeImage.id, adjacent_ids: adjacentIds }).catch(() => {});
        }
        this.unsubscribe = subscribeToActiveImage((reason) => this.scheduleRender(reason));
        this.scheduleRender("immediate");
    }

    private scheduleRender(reason: RenderReason) {
        if (this.rafId !== null) {
            this.scheduler.cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.timeoutId !== null) {
            this.scheduler.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        const state = useAppState.getState();
        const activeImage = state.images[state.activeIndex];
        this.scheduled = activeImage
            ? {
                  id: activeImage.id,
                  adj: state.showOriginal
                      ? getOriginalAdjustments(activeImage.adjustments.rotation)
                      : activeImage.adjustments,
                  showOriginal: state.showOriginal,
              }
            : null;

        const renderCount = ++this.latestRenderCount;

        const runRender = () => {
            this.renderActiveImage(renderCount);
        };

        if (reason === "immediate") {
            this.rafId = this.scheduler.requestAnimationFrame(runRender);
        } else {
            const delay = reason === "nav" ? NAV_COALESCE_MS : ADJ_COALESCE_MS;
            this.timeoutId = this.scheduler.setTimeout(() => {
                this.timeoutId = null;
                this.rafId = this.scheduler.requestAnimationFrame(runRender);
            }, delay);
        }
    }

    private renderActiveImage(renderCount: number) {
        this.rafId = null;
        const state = useAppState.getState();
        const activeImage = state.images[state.activeIndex];
        if (!activeImage) {
            state.setRenderedPreview(null, null);
            this.scheduled = null;
            return;
        }

        const scheduledAdj = this.scheduled?.adj;
        const adj = state.showOriginal
            ? (activeImage.adjustments.rotation === scheduledAdj?.rotation
                ? scheduledAdj
                : getOriginalAdjustments(activeImage.adjustments.rotation))
            : activeImage.adjustments;

        // Drop stale renders: if the state has moved past what we scheduled,
        // another scheduleRender has already superseded this frame.
        if (this.scheduled) {
            if (
                this.scheduled.id !== activeImage.id ||
                this.scheduled.adj !== adj ||
                this.scheduled.showOriginal !== state.showOriginal
            ) {
                return;
            }
        }

        const targetId = activeImage.id;
        this.processor.render(targetId, adj, renderCount, (_id, data, histogram, count) => {
            if (count < this.lastRenderedCount) return;
            const current = useAppState.getState();
            if (current.images[current.activeIndex]?.id === targetId) {
                this.lastRenderedCount = count;
                current.setRenderedPreview(data, histogram, targetId);
            }
        });
        this.scheduled = null;
    }

    dispose() {
        this.unsubscribe?.();
        if (this.rafId !== null) this.scheduler.cancelAnimationFrame(this.rafId);
        if (this.timeoutId !== null) this.scheduler.clearTimeout(this.timeoutId);
    }
}
