export interface TraceEvent {
    name: string;
    cat: string;
    ph: "X" | "i" | "B" | "E" | "C" | "M";
    ts: number;
    dur?: number | undefined;
    pid: number;
    tid: number;
    args?: Record<string, unknown> | undefined;
}

export type HitchSeverity = "slight" | "moderate" | "severe";

export interface FrameHitch {
    timestampMs: number;
    timestampUs: number;
    durationMs: number;
    expectedIntervalMs: number;
    activeStep: string;
    severity: HitchSeverity;
    droppedFramesCount: number;
}

export interface StepHitchMetrics {
    droppedFrames: number;
    hitchCount: number;
    worstHitchMs: number;
    totalHitchMs: number;
}

export interface FrameStatsSummary {
    totalFrames: number;
    averageFps: number;
    totalDroppedFrames: number;
    hitchCount: number;
    worstHitch: FrameHitch | null;
    hitches: FrameHitch[];
    hitchesByStep: Record<string, StepHitchMetrics>;
}

export interface WebMemoryProviders {
    getThumbnailCacheBytes?: () => number;
    getThumbnailCacheCount?: () => number;
    getRenderedPreviewBytes?: () => number;
    getImageCount?: () => number;
}

export interface WebMemorySnapshot {
    timestampMs: number;
    timestampUs: number;
    activeStep: string;
    canvasCount: number;
    canvasTextureBytes: number;
    canvasTextureMB: number;
    thumbnailCacheBytes: number;
    thumbnailCacheMB: number;
    renderedPreviewBytes: number;
    renderedPreviewMB: number;
    totalTrackedBytes: number;
    totalTrackedMB: number;
    domNodeCount: number;
    jsHeapUsedMB?: number | undefined;
}

export interface MemoryStatsSummary {
    peakCanvasTextureMB: number;
    peakThumbnailCacheMB: number;
    peakRenderedPreviewMB: number;
    peakTotalTrackedMB: number;
    initialTotalTrackedMB: number;
    finalTotalTrackedMB: number;
    peakDomNodes: number;
    peakCanvasCount: number;
    snapshotsCount: number;
    snapshots: WebMemorySnapshot[];
}

export interface MainThreadLagStats {
    totalLagMs: number;
    peakLagMs: number;
    stallCount: number;
    lagByStep: Record<string, number>;
}

export interface TraceSummary {
    totalDurationMs: number;
    averageFps: number;
    frameCount: number;
    droppedFrames: number;
    steps: Record<string, number>;
    frameStats?: FrameStatsSummary | undefined;
    memoryStats?: MemoryStatsSummary | undefined;
    mainThreadLag?: MainThreadLagStats | undefined;
    memory?: {
        jsHeapSizeLimit?: number | undefined;
        totalJSHeapSize?: number | undefined;
        usedJSHeapSize?: number | undefined;
    } | undefined;
}

export interface WebTraceReport {
    traceEvents: TraceEvent[];
    summary: TraceSummary;
}

export const FRAME_CONFIG = {
    TARGET_INTERVAL_MS: 16.67,
    HITCH_THRESHOLD_MS: 24,
    SEVERITY_SLIGHT_MAX_MS: 50,
    SEVERITY_MODERATE_MAX_MS: 100,
    TRACK_STEPS_TID: 1,
    TRACK_HITCHES_TID: 2,
    PID: 1,
    MEMORY_SAMPLE_INTERVAL_MS: 100,
    LAG_SAMPLE_INTERVAL_MS: 50,
    LAG_THRESHOLD_MS: 10,
    STALL_THRESHOLD_MS: 50,
} as const;

export class WebTraceRecorder {
    private active = false;
    private startTime = 0;
    private originTime = 0;
    private events: TraceEvent[] = [];
    private stepStarts = new Map<string, number>();
    private stepDurations: Record<string, number> = {};
    private currentActiveStep: string | null = null;

    // Frame tracking
    private frameTimestamps: number[] = [];
    private lastFrameTime = 0;
    private hasLastFrame = false;
    private hitches: FrameHitch[] = [];
    private hitchesByStep: Record<string, StepHitchMetrics> = {};
    private rafId: number | null = null;

    // Memory tracking
    private memoryProviders: WebMemoryProviders | null = null;
    private memorySnapshots: WebMemorySnapshot[] = [];
    private memoryTimerId: ReturnType<typeof setInterval> | null = null;

    // Main thread lag tracking
    private lagTimerId: ReturnType<typeof setTimeout> | null = null;
    private expectedLagTick = 0;
    private totalLagMs = 0;
    private peakLagMs = 0;
    private stallCount = 0;
    private lagByStep: Record<string, number> = {};

    constructor(providers?: WebMemoryProviders) {
        if (providers) {
            this.memoryProviders = providers;
        }
    }

    setMemoryProviders(providers: WebMemoryProviders) {
        this.memoryProviders = providers;
    }

    start(providers?: WebMemoryProviders) {
        if (providers) {
            this.memoryProviders = providers;
        }

        this.active = true;
        this.startTime = performance.now();
        this.originTime = performance.timeOrigin || Date.now();
        this.events = [];
        this.stepStarts.clear();
        this.stepDurations = {};
        this.currentActiveStep = null;

        this.frameTimestamps = [];
        this.lastFrameTime = 0;
        this.hasLastFrame = false;
        this.hitches = [];
        this.hitchesByStep = {};

        this.memorySnapshots = [];
        this.totalLagMs = 0;
        this.peakLagMs = 0;
        this.stallCount = 0;
        this.lagByStep = {};

        // Setup Chrome Trace thread metadata
        this.events.push(
            {
                name: "thread_name",
                cat: "__metadata",
                ph: "M",
                ts: Math.round(this.originTime * 1000),
                pid: FRAME_CONFIG.PID,
                tid: FRAME_CONFIG.TRACK_STEPS_TID,
                args: { name: "Scenario Steps" },
            },
            {
                name: "thread_name",
                cat: "__metadata",
                ph: "M",
                ts: Math.round(this.originTime * 1000),
                pid: FRAME_CONFIG.PID,
                tid: FRAME_CONFIG.TRACK_HITCHES_TID,
                args: { name: "Hitches & Dropped Frames" },
            }
        );

        // Start RAF frame loop
        if (typeof requestAnimationFrame !== "undefined") {
            const onFrame = (now: number) => {
                if (!this.active) return;
                this.processFrame(now);
                this.rafId = requestAnimationFrame(onFrame);
            };
            this.rafId = requestAnimationFrame(onFrame);
        }

        // Start periodic memory sampling
        this.sampleMemory();
        this.memoryTimerId = setInterval(() => {
            if (!this.active) return;
            this.sampleMemory();
        }, FRAME_CONFIG.MEMORY_SAMPLE_INTERVAL_MS);

        // Start main thread lag detector
        this.scheduleLagTick();
    }

    private scheduleLagTick() {
        if (!this.active) return;
        const now = performance.now();
        this.expectedLagTick = now + FRAME_CONFIG.LAG_SAMPLE_INTERVAL_MS;
        this.lagTimerId = setTimeout(() => {
            if (!this.active) return;
            const current = performance.now();
            const lag = current - this.expectedLagTick;
            if (lag > FRAME_CONFIG.LAG_THRESHOLD_MS) {
                const lagMs = Number(lag.toFixed(2));
                this.totalLagMs = Number((this.totalLagMs + lagMs).toFixed(2));
                this.peakLagMs = Math.max(this.peakLagMs, lagMs);
                if (lagMs >= FRAME_CONFIG.STALL_THRESHOLD_MS) {
                    this.stallCount++;
                }
                const active = this.currentActiveStep ?? "idle";
                this.lagByStep[active] = Number(((this.lagByStep[active] ?? 0) + lagMs).toFixed(2));
            }
            this.scheduleLagTick();
        }, FRAME_CONFIG.LAG_SAMPLE_INTERVAL_MS);
    }

    /**
     * Sample current web-level memory (DOM canvases, thumbnail cache, preview buffer).
     * Public so callers and tests can trigger on-demand checkpoints.
     */
    sampleMemory(timestampNow?: number): WebMemorySnapshot {
        const now = timestampNow ?? performance.now();
        const tsUs = Math.round((this.originTime + now) * 1000);
        const activeStep = this.currentActiveStep ?? "idle";

        let canvasCount = 0;
        let canvasTextureBytes = 0;
        if (typeof document !== "undefined") {
            const canvases = document.querySelectorAll("canvas");
            canvasCount = canvases.length;
            for (let i = 0; i < canvases.length; i++) {
                const c = canvases[i] as HTMLCanvasElement;
                canvasTextureBytes += (c.width || 0) * (c.height || 0) * 4;
            }
        }

        const domNodeCount = typeof document !== "undefined" ? document.getElementsByTagName("*").length : 0;
        const thumbnailCacheBytes = this.memoryProviders?.getThumbnailCacheBytes?.() ?? 0;
        const renderedPreviewBytes = this.memoryProviders?.getRenderedPreviewBytes?.() ?? 0;
        const totalTrackedBytes = canvasTextureBytes + thumbnailCacheBytes + renderedPreviewBytes;

        const canvasTextureMB = Number((canvasTextureBytes / (1024 * 1024)).toFixed(2));
        const thumbnailCacheMB = Number((thumbnailCacheBytes / (1024 * 1024)).toFixed(2));
        const renderedPreviewMB = Number((renderedPreviewBytes / (1024 * 1024)).toFixed(2));
        const totalTrackedMB = Number((totalTrackedBytes / (1024 * 1024)).toFixed(2));

        let jsHeapUsedMB: number | undefined = undefined;
        if (typeof window !== "undefined" && "performance" in window) {
            const perfMem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
            if (perfMem?.usedJSHeapSize) {
                jsHeapUsedMB = Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(2));
            }
        }

        const snapshot: WebMemorySnapshot = {
            timestampMs: Number(now.toFixed(2)),
            timestampUs: tsUs,
            activeStep,
            canvasCount,
            canvasTextureBytes,
            canvasTextureMB,
            thumbnailCacheBytes,
            thumbnailCacheMB,
            renderedPreviewBytes,
            renderedPreviewMB,
            totalTrackedBytes,
            totalTrackedMB,
            domNodeCount,
            jsHeapUsedMB,
        };
        this.memorySnapshots.push(snapshot);

        if (this.active) {
            // Chrome Trace Counter: Web Memory Breakdown
            this.events.push({
                name: "Web Memory (MB)",
                cat: "memory",
                ph: "C",
                ts: tsUs,
                pid: FRAME_CONFIG.PID,
                tid: FRAME_CONFIG.TRACK_STEPS_TID,
                args: {
                    canvas_texture_mb: canvasTextureMB,
                    thumbnail_cache_mb: thumbnailCacheMB,
                    rendered_preview_mb: renderedPreviewMB,
                    total_tracked_mb: totalTrackedMB,
                },
            });

            // Chrome Trace Counter: DOM & Canvas Counts
            this.events.push({
                name: "DOM & Canvas Counts",
                cat: "memory",
                ph: "C",
                ts: tsUs,
                pid: FRAME_CONFIG.PID,
                tid: FRAME_CONFIG.TRACK_STEPS_TID,
                args: {
                    dom_nodes: domNodeCount,
                    canvases: canvasCount,
                },
            });
        }

        return snapshot;
    }

    /**
     * Process an incoming animation frame timestamp.
     * Public so it can be deterministically exercised in test suites.
     */
    processFrame(now: number) {
        if (!this.active) return;
        this.frameTimestamps.push(now);

        if (this.hasLastFrame) {
            const interval = now - this.lastFrameTime;
            if (interval > FRAME_CONFIG.HITCH_THRESHOLD_MS) {
                const droppedCount = Math.max(1, Math.round(interval / FRAME_CONFIG.TARGET_INTERVAL_MS) - 1);
                let severity: HitchSeverity = "slight";
                if (interval > FRAME_CONFIG.SEVERITY_MODERATE_MAX_MS) {
                    severity = "severe";
                } else if (interval > FRAME_CONFIG.SEVERITY_SLIGHT_MAX_MS) {
                    severity = "moderate";
                }

                const activeStep = this.currentActiveStep ?? "idle";
                const hitchTsUs = Math.round((this.originTime + this.lastFrameTime) * 1000);
                const hitchDurMs = Number(interval.toFixed(2));

                const hitch: FrameHitch = {
                    timestampMs: Number(this.lastFrameTime.toFixed(2)),
                    timestampUs: hitchTsUs,
                    durationMs: hitchDurMs,
                    expectedIntervalMs: FRAME_CONFIG.TARGET_INTERVAL_MS,
                    activeStep,
                    severity,
                    droppedFramesCount: droppedCount,
                };
                this.hitches.push(hitch);

                // Accumulate per-step hitch metrics
                const stepMetric = this.hitchesByStep[activeStep] ?? {
                    droppedFrames: 0,
                    hitchCount: 0,
                    worstHitchMs: 0,
                    totalHitchMs: 0,
                };
                stepMetric.droppedFrames += droppedCount;
                stepMetric.hitchCount += 1;
                stepMetric.worstHitchMs = Math.max(stepMetric.worstHitchMs, hitchDurMs);
                stepMetric.totalHitchMs = Number((stepMetric.totalHitchMs + hitchDurMs).toFixed(2));
                this.hitchesByStep[activeStep] = stepMetric;

                // Emit Chrome Trace Instant Event on the Hitches track
                this.events.push({
                    name: `frame_hitch_${severity}`,
                    cat: "frame_drop",
                    ph: "i",
                    ts: hitchTsUs,
                    pid: FRAME_CONFIG.PID,
                    tid: FRAME_CONFIG.TRACK_HITCHES_TID,
                    args: {
                        durationMs: hitchDurMs,
                        droppedFrames: droppedCount,
                        activeStep,
                        severity,
                    },
                });
            }
        }

        this.lastFrameTime = now;
        this.hasLastFrame = true;
    }

    startStep(name: string) {
        if (!this.active) return;
        const now = performance.now();
        this.currentActiveStep = name;
        this.stepStarts.set(name, now);
        this.sampleMemory(now);
        try {
            performance.mark(`${name}:start`);
        } catch {}
    }

    endStep(name: string, args?: Record<string, unknown>) {
        if (!this.active) return;
        const end = performance.now();
        const start = this.stepStarts.get(name) ?? end;
        const durMs = Math.max(0, end - start);
        this.stepDurations[name] = Number(durMs.toFixed(2));
        this.sampleMemory(end);

        if (this.currentActiveStep === name) {
            this.currentActiveStep = null;
        }

        const startUs = Math.round((this.originTime + start) * 1000);
        const durUs = Math.round(durMs * 1000);

        this.events.push({
            name,
            cat: "scenario",
            ph: "X",
            ts: startUs,
            dur: durUs,
            pid: FRAME_CONFIG.PID,
            tid: FRAME_CONFIG.TRACK_STEPS_TID,
            args,
        });

        try {
            performance.mark(`${name}:end`);
            performance.measure(name, `${name}:start`, `${name}:end`);
        } catch {}
    }

    recordInstant(name: string, args?: Record<string, unknown>) {
        if (!this.active) return;
        const now = performance.now();
        const tsUs = Math.round((this.originTime + now) * 1000);
        this.events.push({
            name,
            cat: "scenario",
            ph: "i",
            ts: tsUs,
            pid: FRAME_CONFIG.PID,
            tid: FRAME_CONFIG.TRACK_STEPS_TID,
            args,
        });
    }

    finalize(): string {
        this.active = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.memoryTimerId !== null) {
            clearInterval(this.memoryTimerId);
            this.memoryTimerId = null;
        }
        if (this.lagTimerId !== null) {
            clearTimeout(this.lagTimerId);
            this.lagTimerId = null;
        }

        const endTime = performance.now();
        const totalDurationMs = Number(Math.max(0, endTime - this.startTime).toFixed(2));

        const frameCount = this.frameTimestamps.length;
        let averageFps = 0;
        let totalDroppedFrames = 0;

        if (frameCount > 1) {
            const firstFrame = this.frameTimestamps[0] ?? this.startTime;
            const lastFrame = this.frameTimestamps[frameCount - 1] ?? endTime;
            const elapsedSec = (lastFrame - firstFrame) / 1000;
            if (elapsedSec > 0) {
                averageFps = Number((frameCount / elapsedSec).toFixed(1));
            }
        }

        for (const h of this.hitches) {
            totalDroppedFrames += h.droppedFramesCount;
        }

        let worstHitch: FrameHitch | null = null;
        for (const h of this.hitches) {
            if (!worstHitch || h.durationMs > worstHitch.durationMs) {
                worstHitch = h;
            }
        }

        const frameStats: FrameStatsSummary = {
            totalFrames: frameCount,
            averageFps,
            totalDroppedFrames,
            hitchCount: this.hitches.length,
            worstHitch,
            hitches: this.hitches,
            hitchesByStep: this.hitchesByStep,
        };

        // Memory summary computation
        let peakCanvasTextureMB = 0;
        let peakThumbnailCacheMB = 0;
        let peakRenderedPreviewMB = 0;
        let peakTotalTrackedMB = 0;
        let peakDomNodes = 0;
        let peakCanvasCount = 0;

        for (const s of this.memorySnapshots) {
            peakCanvasTextureMB = Math.max(peakCanvasTextureMB, s.canvasTextureMB);
            peakThumbnailCacheMB = Math.max(peakThumbnailCacheMB, s.thumbnailCacheMB);
            peakRenderedPreviewMB = Math.max(peakRenderedPreviewMB, s.renderedPreviewMB);
            peakTotalTrackedMB = Math.max(peakTotalTrackedMB, s.totalTrackedMB);
            peakDomNodes = Math.max(peakDomNodes, s.domNodeCount);
            peakCanvasCount = Math.max(peakCanvasCount, s.canvasCount);
        }

        const initialTotalTrackedMB = this.memorySnapshots[0]?.totalTrackedMB ?? 0;
        const finalTotalTrackedMB = this.memorySnapshots[this.memorySnapshots.length - 1]?.totalTrackedMB ?? 0;

        const memoryStats: MemoryStatsSummary = {
            peakCanvasTextureMB,
            peakThumbnailCacheMB,
            peakRenderedPreviewMB,
            peakTotalTrackedMB,
            initialTotalTrackedMB,
            finalTotalTrackedMB,
            peakDomNodes,
            peakCanvasCount,
            snapshotsCount: this.memorySnapshots.length,
            snapshots: this.memorySnapshots,
        };

        const mainThreadLag: MainThreadLagStats = {
            totalLagMs: this.totalLagMs,
            peakLagMs: this.peakLagMs,
            stallCount: this.stallCount,
            lagByStep: this.lagByStep,
        };

        let memoryInfo: TraceSummary["memory"] = undefined;
        if (typeof window !== "undefined" && "performance" in window) {
            const perfMem = (performance as unknown as { memory?: Record<string, number> }).memory;
            if (perfMem) {
                memoryInfo = {
                    jsHeapSizeLimit: perfMem.jsHeapSizeLimit,
                    totalJSHeapSize: perfMem.totalJSHeapSize,
                    usedJSHeapSize: perfMem.usedJSHeapSize,
                };
            }
        }

        const report: WebTraceReport = {
            traceEvents: this.events,
            summary: {
                totalDurationMs,
                averageFps,
                frameCount,
                droppedFrames: totalDroppedFrames,
                steps: this.stepDurations,
                frameStats,
                memoryStats,
                mainThreadLag,
                memory: memoryInfo,
            },
        };

        return JSON.stringify(report, null, 2);
    }
}
