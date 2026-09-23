import { invoke } from "@tauri-apps/api/core";
import { useAppState } from "../state/appState.ts";
import { lutState } from "../state/lutState.ts";
import { WebTraceRecorder } from "./webTraceRecorder.ts";
import { applyAdjustmentGroup, applyMaximalAdjustments, type AdjustmentGroup } from "./profilingAdjustments.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import type { Adjustments } from "../backend/types.ts";
import { historyDepth, sealBurst } from "./undoHistory.ts";
import { getThumbnailRegistryMemoryBytes, thumbnailRegistry } from "./thumbnailRegistry.ts";
import { Panel } from "../components/constants/index.ts";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the first preview of `id` arrives (used right after load). */
async function waitForImage(store: typeof useAppState, id: string, maxWaitMs = 3000): Promise<void> {
    const start = performance.now();
    while (performance.now() - start < maxWaitMs) {
        if (store.getState().renderedImageId === id) return;
        await delay(10);
    }
}

/**
 * Wait until a preview render completes *after* `seq0`. Returns the elapsed ms
 * (capped at `maxWaitMs`). Keying on the monotonic render sequence is what lets
 * the scenario actually measure a fresh render after an edit, rather than
 * matching the previous render of the same image.
 */
async function waitForRenderSince(store: typeof useAppState, seq0: number, maxWaitMs = 8000): Promise<number> {
    const start = performance.now();
    while (performance.now() - start < maxWaitMs) {
        if (store.getState().renderSeq > seq0) return performance.now() - start;
        await delay(5);
    }
    return performance.now() - start;
}

/** Switch the active image and wait for its render. */
async function selectAndRender(store: typeof useAppState, index: number, maxWaitMs = 8000): Promise<number> {
    const state = store.getState();
    if (!state.images[index] || state.activeIndex === index) return 0;
    const seq0 = state.renderSeq;
    store.getState().setActiveImage(index);
    return waitForRenderSince(store, seq0, maxWaitMs);
}

/** Apply an adjustment change and wait for the resulting render. */
async function editAndRender(
    store: typeof useAppState,
    mutate: (adj: Adjustments) => Adjustments,
    maxWaitMs = 15000,
): Promise<number> {
    const state = store.getState();
    const img = state.images[state.activeIndex];
    if (!img) return 0;
    const seq0 = state.renderSeq;
    store.getState().updateImage(img.id, (entry) => {
        entry.adjustments = mutate(entry.adjustments);
    });
    return waitForRenderSince(store, seq0, maxWaitMs);
}

async function tryLoadM31Lut(): Promise<number | null> {
    const candidatePaths = [
        "test_fixtures/luts/M31 - Rec709.cube",
        "/Users/romanvolkov/Desktop/M31 - Rec709.cube",
    ];

    for (const p of candidatePaths) {
        try {
            await invoke("import_lut", { lutPath: p });
            break;
        } catch {}
    }

    try {
        await lutState.getState().loadItems();
        const items = lutState.getState().items;
        const found = items.find((item) => item.name.toLowerCase().includes("m31"));
        return found ? found.id : null;
    } catch {
        return null;
    }
}

export interface ThumbnailTierTiming {
    count: number;
    avgMs: number;
    maxMs: number;
}

export type ThumbnailRenderer = (
    items: { id: string; adj: Adjustments; quality?: "fast" | "hq"; maxDim?: number }[],
) => Promise<unknown>;

/** Production renderer: the Tauri backend's `render_thumbnails_batch`. */
async function defaultThumbnailRenderer(items: Parameters<ThumbnailRenderer>[0]): Promise<unknown> {
    const { getBackend } = await import("../backend/index.ts");
    const backend = await getBackend();
    return backend.renderThumbnails(items);
}

/**
 * Render `ids` once at `quality`/`maxDim`, timing the *wall clock* for the whole
 * set. Thumbnails bypass the preview pipeline (they never touch `renderSeq`), so
 * the awaited `renderThumbnails` calls are timed directly — no render-token wait.
 *
 * The batch size mirrors the production dispatcher (4 for HQ, 12 for fast), and
 * `count` is the number of images so `avgMs` is directly comparable across runs.
 */
export async function timeThumbnailTier(
    ids: string[],
    quality: "fast" | "hq",
    maxDim: number,
    adjustments: Adjustments,
    render: ThumbnailRenderer = defaultThumbnailRenderer,
): Promise<ThumbnailTierTiming> {
    if (ids.length === 0) return { count: 0, avgMs: 0, maxMs: 0 };

    const batchSize = quality === "fast" ? 12 : 4;
    const batchDurations: number[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
        const items = ids
            .slice(i, i + batchSize)
            .map((id) => ({ id, adj: adjustments, quality, maxDim }));
        const start = performance.now();
        await render(items);
        batchDurations.push(performance.now() - start);
    }

    const wallMs = batchDurations.reduce((a, b) => a + b, 0);
    return {
        count: ids.length,
        avgMs: wallMs / ids.length,
        maxMs: Math.max(...batchDurations),
    };
}

export interface PairedHqTiming {
    count: number;
    legacyAvgMs: number;
    newAvgMs: number;
    legacyPeakMs: number;
    newPeakMs: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Measure legacy 400 px HQ against the view-aware 200 px HQ on the *same* images,
 * alternating the order per image, so fixture content size and page-cache warmth
 * cancel out and only the output-size effect remains.
 */
export async function measureHqPair(
    ids: string[],
    adjustments: Adjustments,
    render: ThumbnailRenderer = defaultThumbnailRenderer,
): Promise<PairedHqTiming> {
    const legacy: number[] = [];
    const next: number[] = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const order: Array<400 | 200> = i % 2 === 0 ? [400, 200] : [200, 400];
        const byDim = new Map<400 | 200, number>();
        for (const dim of order) {
            const start = performance.now();
            await render([{ id, adj: adjustments, quality: "hq", maxDim: dim }]);
            byDim.set(dim, performance.now() - start);
        }
        legacy.push(byDim.get(400)!);
        next.push(byDim.get(200)!);
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
        count: ids.length,
        legacyAvgMs: mean(legacy),
        newAvgMs: mean(next),
        legacyPeakMs: legacy.length ? Math.max(...legacy) : 0,
        newPeakMs: next.length ? Math.max(...next) : 0,
    };
}

export interface UndoRedoStepResult {
    edits: number;
    undos: number;
    redos: number;
    finalRenderMs: number;
    depthAfterBurst: { undo: number; redo: number } | null;
}

export async function runUndoRedoHistoryStep(
    store: typeof useAppState,
    waitRender: (store: typeof useAppState, seq0: number, maxWaitMs?: number) => Promise<number> = waitForRenderSince,
): Promise<UndoRedoStepResult> {
    const state = store.getState();
    const activeIdx = state.activeIndex;
    const img = state.images[activeIdx];
    if (!img) {
        return { edits: 0, undos: 0, redos: 0, finalRenderMs: 0, depthAfterBurst: null };
    }

    const id = img.id;
    const editsCount = 35;
    const undosCount = 10;
    const redosCount = 5;

    // Burst of 35 distinct edits, each followed by sealBurst
    const seq0 = store.getState().renderSeq;
    for (let i = 1; i <= editsCount; i++) {
        store.getState().updateImage(id, (entry) => {
            entry.adjustments = {
                ...entry.adjustments,
                light: { ...entry.adjustments.light, exposure: i * 0.1 },
            };
        });
        sealBurst(id);
    }
    const depthAfterBurst = historyDepth(id);

    // Wait for one final render after the burst
    const finalRenderMs = await waitRender(store, seq0, 15000);

    // Undo 10x with render wait after each
    for (let i = 0; i < undosCount; i++) {
        const s0 = store.getState().renderSeq;
        store.getState().undoAdjustment();
        await waitRender(store, s0, 8000);
    }

    // Redo 5x with render wait after each
    for (let i = 0; i < redosCount; i++) {
        const s0 = store.getState().renderSeq;
        store.getState().redoAdjustment();
        await waitRender(store, s0, 8000);
    }

    return {
        edits: editsCount,
        undos: undosCount,
        redos: redosCount,
        finalRenderMs: Math.round(finalRenderMs),
        depthAfterBurst,
    };
}

export async function runProfilingScenario(store: typeof useAppState = useAppState): Promise<void> {
    const recorder = new WebTraceRecorder({
        getThumbnailCacheBytes: () => getThumbnailRegistryMemoryBytes(),
        getThumbnailCacheCount: () => thumbnailRegistry.size,
        getRenderedPreviewBytes: () => store.getState().renderedData?.data?.byteLength ?? 0,
        getImageCount: () => store.getState().images.length,
    });
    recorder.start();

    function recordMemoryCheckpoint(tag: string) {
        const snapshot = recorder.sampleMemory();
        recorder.recordInstant(`memory_${tag}`, {
            thumbnailCacheCount: thumbnailRegistry.size,
            thumbnailCacheMB: snapshot.thumbnailCacheMB,
            renderedPreviewMB: snapshot.renderedPreviewMB,
            canvasTextureMB: snapshot.canvasTextureMB,
            totalTrackedMB: snapshot.totalTrackedMB,
            imagesInStore: store.getState().images.length,
            domCanvases: snapshot.canvasCount,
            domNodeCount: snapshot.domNodeCount,
        });
    }

    recorder.startStep("wait_initial_load");

    const maxWaitLoadMs = 60000;
    const startWait = performance.now();
    while (performance.now() - startWait < maxWaitLoadMs) {
        const state = store.getState();
        if (state.images.length > 0 && state.loadProgress === null) {
            break;
        }
        await delay(50);
    }

    const initialImages = store.getState().images;
    if (initialImages.length === 0) {
        recorder.endStep("wait_initial_load", { error: "no_images" });
        const trace = recorder.finalize();
        await invoke("save_web_profile", { traceJson: trace, outputDir: null }).catch(() => {});
        await invoke("exit_app", { code: 1 }).catch(() => {});
        return;
    }

    const firstImage = initialImages[0];
    if (firstImage) {
        await waitForImage(store, firstImage.id, 3000);
    }
    recorder.endStep("wait_initial_load", { imagesCount: initialImages.length });
    recordMemoryCheckpoint("post_initial_load");

    recorder.startStep("filmstrip_navigation");
    const navLimit = Math.min(initialImages.length, 6);
    let navRenderMs = 0;
    for (let i = 0; i < navLimit; i++) {
        navRenderMs += await selectAndRender(store, i);
    }
    recorder.endStep("filmstrip_navigation", { imagesNavigated: navLimit, renderMs: Math.round(navRenderMs) });

    // ── Thumbnail pipeline benchmarks ──
    // Every step samples a *disjoint* id range so no pass warms another's cache.
    // The first `visibleReserve` images are left to the live filmstrip (it has
    // already requested them); everything after is cold.
    const allImages = store.getState().images;
    const visibleReserve = Math.min(15, Math.max(0, allImages.length - 5));
    const cold = allImages.slice(visibleReserve);

    const sliceIds = (start: number, count: number): string[] =>
        cold.slice(start, Math.min(cold.length, start + count)).map((img) => img.id);

    const fastIds = sliceIds(0, 10);
    const pairedIds = sliceIds(10, 20);
    const fillBudget = Math.max(0, Math.floor((cold.length - 30) / 2));
    const oldFillIds = sliceIds(30, fillBudget);
    const newFillIds = sliceIds(30 + fillBudget, fillBudget);

    const renderRaw: ThumbnailRenderer = defaultThumbnailRenderer;

    recorder.startStep("thumbnail_fast");
    const fastTiming = await timeThumbnailTier(fastIds, "fast", 160, DEFAULT_ADJUSTMENTS, renderRaw);
    recorder.endStep("thumbnail_fast", {
        count: fastTiming.count,
        avgMs: Math.round(fastTiming.avgMs * 100) / 100,
        maxMs: Math.round(fastTiming.maxMs),
        maxDim: 160,
    });

    // Legacy 400 px HQ vs new view-aware 200 px HQ, on the same images.
    recorder.startStep("thumbnail_hq");
    const hqPair = await measureHqPair(pairedIds, DEFAULT_ADJUSTMENTS, renderRaw);
    recorder.endStep("thumbnail_hq", {
        count: hqPair.count,
        avgMs: round2(hqPair.newAvgMs),
        legacyAvgMs: round2(hqPair.legacyAvgMs),
        speedup: hqPair.newAvgMs > 0 ? round2(hqPair.legacyAvgMs / hqPair.newAvgMs) : 0,
        peak200Ms: Math.round(hqPair.newPeakMs),
        peak400Ms: Math.round(hqPair.legacyPeakMs),
        measured: "paired-alt-order",
    });

    // Repeat with maximal adjustments to exercise the render/filter passes too.
    const editedAdj = applyMaximalAdjustments(structuredClone(DEFAULT_ADJUSTMENTS));
    recorder.startStep("thumbnail_hq_edited");
    const editedPair = await measureHqPair(pairedIds, editedAdj, renderRaw);
    recorder.endStep("thumbnail_hq_edited", {
        count: editedPair.count,
        avgMs: round2(editedPair.newAvgMs),
        legacyAvgMs: round2(editedPair.legacyAvgMs),
        speedup: editedPair.newAvgMs > 0 ? round2(editedPair.legacyAvgMs / editedPair.newAvgMs) : 0,
        measured: "paired-alt-order",
    });

    // ── Strip fast fill: old scheduler (batch 4, serial) vs new (batch 12 × 3) ──
    const fastItemsFor = (ids: string[]) =>
        ids.map((id) => ({ id, adj: DEFAULT_ADJUSTMENTS, quality: "fast" as const, maxDim: 160 }));

    recorder.startStep("thumbnail_strip_fill_sequential");
    const oldItems = fastItemsFor(oldFillIds);
    const seqStart = performance.now();
    for (let i = 0; i < oldItems.length; i += 4) {
        await renderRaw(oldItems.slice(i, i + 4));
    }
    const seqMs = performance.now() - seqStart;
    recorder.endStep("thumbnail_strip_fill_sequential", {
        count: oldItems.length,
        batchSize: 4,
        concurrency: 1,
        wallMs: Math.round(seqMs),
        perThumbMs: Math.round((seqMs / Math.max(1, oldItems.length)) * 100) / 100,
    });

    recorder.startStep("thumbnail_strip_fill_100");
    const newItems = fastItemsFor(newFillIds);
    const fillStart = performance.now();
    let fillIndex = 0;
    const fillWorkers = Array.from({ length: 3 }, async () => {
        while (fillIndex < newItems.length) {
            const sliceStart = fillIndex;
            fillIndex += 12;
            const batch = newItems.slice(sliceStart, sliceStart + 12);
            if (batch.length === 0) return;
            await renderRaw(batch);
        }
    });
    await Promise.all(fillWorkers);
    const fillMs = performance.now() - fillStart;
    recorder.endStep("thumbnail_strip_fill_100", {
        count: newItems.length,
        batchSize: 12,
        concurrency: 3,
        wallMs: Math.round(fillMs),
        perThumbMs: Math.round((fillMs / Math.max(1, newItems.length)) * 100) / 100,
    });
    recordMemoryCheckpoint("post_thumbnails");

    recorder.startStep("load_external_lut");
    const m31LutId = await tryLoadM31Lut();
    recorder.endStep("load_external_lut", { m31LutId });

    // ── Feature isolation: what does each adjustment family cost to render? ──
    if (store.getState().activeIndex !== 0) {
        await selectAndRender(store, 0);
    }
    const targetImage0 = store.getState().images[0];
    if (targetImage0) {
        const groups: Array<[string, AdjustmentGroup]> = [
            ["render_tonal_only", "light"],
            ["render_curves_only", "curves"],
            ["render_denoise_only", "denoise"],
            ["render_grain_only", "grain"],
            ["render_geometry_only", "geometry"],
            ["render_color_balance_only", "color_balance"],
            ["render_selective_color_only", "selective_color"],
        ];
        for (const [name, group] of groups) {
            recorder.startStep(name);
            // Reset to defaults so each family is measured in isolation.
            const renderMs = await editAndRender(
                store,
                () => applyAdjustmentGroup(structuredClone(DEFAULT_ADJUSTMENTS), group),
            );
            recorder.endStep(name, { renderMs: Math.round(renderMs) });
        }

        // ── Geometry Overlay interaction step (g, Tab, tilts, distortion, Enter) ──
        recorder.startStep("geometry_overlay_interaction");
        const { keyboardManager, RegistrationID } = await import("./KeyboardManager.ts");
        store.getState().setFocusPanel(Panel.Adjustments);
        keyboardManager.setActive(RegistrationID.adjustments);
        await delay(30);

        if (typeof window !== "undefined") {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true }));
        }
        await delay(30);
        if (!store.getState().geometryEdit) {
            store.getState().setGeometryEdit(true);
            keyboardManager.setActive(RegistrationID.geometry);
        }

        if (typeof window !== "undefined") {
            // Switch to PERSPECTIVE mode (Tab)
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            await delay(30);
            // Apply vertical and horizontal tilts (j/k for V, h/l for H)
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true }));
            await delay(30);
            // Switch to DISTORTION mode (Tab)
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            await delay(30);
            // Apply distortion (l)
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true }));
            await delay(30);
            // Commit and exit (Enter)
            const seqGeo = store.getState().renderSeq;
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            const geoRenderMs = await waitForRenderSince(store, seqGeo, 15000);
            recorder.endStep("geometry_overlay_interaction", { renderMs: Math.round(geoRenderMs) });
        } else {
            recorder.endStep("geometry_overlay_interaction", { renderMs: 0 });
        }
    }

    recorder.startStep("edit_image_all_sliders");
    let allRenderMs = 0;
    if (targetImage0) {
        allRenderMs = await editAndRender(store, (adj) => {
            const next = applyMaximalAdjustments(adj);
            if (m31LutId !== null) {
                next.lut_id = m31LutId;
                next.lut_intensity = 80;
            }
            return next;
        });
    }
    recorder.endStep("edit_image_all_sliders", { renderMs: Math.round(allRenderMs) });

    if (initialImages.length > 1) {
        recorder.startStep("edit_image_secondary");
        await selectAndRender(store, 1);
        const renderMs = await editAndRender(store, (adj) => ({
            ...adj,
            light: { ...adj.light, exposure: -0.6, contrast: 12 },
            color: { ...adj.color, tint: -10 },
            detail: { ...adj.detail, clarity: 18 },
        }));
        recorder.endStep("edit_image_secondary", { renderMs: Math.round(renderMs) });
    }

    recorder.startStep("fullscreen_grid_view");
    store.getState().setFilmstripView("grid");
    await delay(300);
    const midIdx = Math.min(12, store.getState().images.length - 1);
    await selectAndRender(store, midIdx);
    await delay(200);
    store.getState().setFilmstripView("strip");
    await delay(200);
    recorder.endStep("fullscreen_grid_view");
    recordMemoryCheckpoint("post_grid");

    recorder.startStep("copy_paste_adjustments");
    if (store.getState().activeIndex !== 0) {
        await selectAndRender(store, 0);
    }
    store.getState().yankAdjustments();

    const pasteTargetIdx = Math.min(5, store.getState().images.length - 1);
    await selectAndRender(store, pasteTargetIdx);
    const pasteTarget = store.getState().images[pasteTargetIdx];
    let pasteRenderMs = 0;
    if (pasteTarget) {
        const seq0 = store.getState().renderSeq;
        store.getState().pasteAdjustments(new Set([pasteTarget.id]));
        pasteRenderMs = await waitForRenderSince(store, seq0, 15000);
    }
    recorder.endStep("copy_paste_adjustments", { renderMs: Math.round(pasteRenderMs) });

    recorder.startStep("undo_redo_history");
    if (store.getState().activeIndex !== 0) {
        await selectAndRender(store, 0);
    }
    const undoRedoMetrics = await runUndoRedoHistoryStep(store);
    recorder.endStep("undo_redo_history", {
        edits: undoRedoMetrics.edits,
        undos: undoRedoMetrics.undos,
        redos: undoRedoMetrics.redos,
        finalRenderMs: undoRedoMetrics.finalRenderMs,
    });
    recordMemoryCheckpoint("post_undo_redo");

    recorder.startStep("fast_scrolling_stress");
    const fastLimit = Math.min(store.getState().images.length, 25);
    for (let i = 0; i < fastLimit; i++) {
        store.getState().setActiveImage(i);
        await delay(40);
    }
    for (let i = fastLimit - 1; i >= 0; i -= 2) {
        store.getState().setActiveImage(i);
        await delay(40);
    }
    const finalImg = store.getState().images[0];
    if (finalImg) {
        await waitForImage(store, finalImg.id, 3000);
    }
    recorder.endStep("fast_scrolling_stress", { itemsScrolled: fastLimit });
    recordMemoryCheckpoint("post_scrolling");

    recorder.startStep("export_images");
    const exportFolder = "/tmp/darkslide_profile_export";
    const exportLimit = Math.min(store.getState().images.length, 15);
    // Give every exported image the maximal adjustments so export exercises the
    // deepest full-resolution pipeline.
    for (let i = 0; i < exportLimit; i++) {
        const img = store.getState().images[i];
        if (img) {
            store.getState().updateImage(img.id, (entry) => {
                entry.adjustments = applyMaximalAdjustments(entry.adjustments);
            });
        }
    }
    const exportItems = store.getState().images.slice(0, exportLimit);
    const durations: number[] = [];
    let completedCount = 0;
    await Promise.all(exportItems.map(async (img) => {
        const stem = img.filename.replace(/\.[^.]+$/, "");
        const path = `${exportFolder}/${stem}.jpg`;
        const t0 = performance.now();
        try {
            await invoke("export", {
                id: img.id,
                adjustments: img.adjustments,
                path,
                imageType: "jpg",
                quality: 90,
                pngCompression: null,
            });
        } catch (e) {
            recorder.recordInstant("export_error", { error: String(e) });
        }
        durations.push(performance.now() - t0);
        completedCount++;
        store.getState().setExportProgress({ done: completedCount, total: exportItems.length });
    }));
    store.getState().setExportProgress(null);
    await invoke("cleanup_dir", { path: exportFolder }).catch(() => {});
    const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const maxMs = durations.length ? Math.max(...durations) : 0;
    recorder.endStep("export_images", {
        count: exportItems.length,
        avgMs: Math.round(avgMs),
        maxMs: Math.round(maxMs),
    });
    recordMemoryCheckpoint("post_export");

    // Diagnostic phase: clear caches and wait to see if WebKit RSS drops
    recorder.startStep("memory_cleanup_diagnostic");
    thumbnailRegistry.clear();
    store.getState().setRenderedPreview(null, null, null);
    if (typeof (window as any).gc === "function") {
        (window as any).gc();
    }
    await delay(2500);
    recordMemoryCheckpoint("post_cleanup");
    recorder.endStep("memory_cleanup_diagnostic");

    const traceReportJson = recorder.finalize();
    await invoke("save_web_profile", { traceJson: traceReportJson, outputDir: null }).catch(() => {});
    await delay(2000);
    await invoke("exit_app", { code: 0 }).catch(() => {});
}
