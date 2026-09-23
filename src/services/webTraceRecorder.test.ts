import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebTraceRecorder, FRAME_CONFIG, type WebTraceReport, type WebMemoryProviders } from "./webTraceRecorder.ts";

describe("WebTraceRecorder - Frame Hitch & Dropped Frames Tracking", () => {
    let recorder: WebTraceRecorder;

    beforeEach(() => {
        recorder = new WebTraceRecorder();
    });

    afterEach(() => {
        recorder.finalize();
    });

    it("initializes metadata events for steps and hitches tracks", () => {
        recorder.start();
        const json = JSON.parse(recorder.finalize()) as WebTraceReport;

        const metadataEvents = json.traceEvents.filter((e) => e.cat === "__metadata");
        expect(metadataEvents.length).toBe(2);

        const stepsTrack = metadataEvents.find((e) => e.tid === FRAME_CONFIG.TRACK_STEPS_TID);
        expect(stepsTrack?.args?.name).toBe("Scenario Steps");

        const hitchesTrack = metadataEvents.find((e) => e.tid === FRAME_CONFIG.TRACK_HITCHES_TID);
        expect(hitchesTrack?.args?.name).toBe("Hitches & Dropped Frames");
    });

    it("tracks regular frames without logging hitches when intervals <= 24ms", () => {
        recorder.start();

        // Feed frames at ~16ms intervals
        recorder.processFrame(100);
        recorder.processFrame(116.6);
        recorder.processFrame(133.2);
        recorder.processFrame(149.8);

        const json = JSON.parse(recorder.finalize()) as WebTraceReport;
        expect(json.summary.frameCount).toBe(4);
        expect(json.summary.droppedFrames).toBe(0);
        expect(json.summary.frameStats?.hitchCount).toBe(0);
        expect(json.summary.frameStats?.worstHitch).toBeNull();
    });

    it("detects hitches, classifies severity, and tags active steps", () => {
        recorder.start();

        // 1. Initial frame
        recorder.processFrame(100);

        // 2. Normal frame inside step_a
        recorder.startStep("step_a");
        recorder.processFrame(116.6);

        // 3. Slight hitch (35ms interval) in step_a
        recorder.processFrame(151.6); // 151.6 - 116.6 = 35ms (>24ms <= 50ms)
        recorder.endStep("step_a");

        // 4. Moderate hitch (70ms interval) between steps (idle)
        recorder.processFrame(221.6); // 221.6 - 151.6 = 70ms (>50ms <= 100ms)

        // 5. Severe hitch (150ms interval) in step_b
        recorder.startStep("step_b");
        recorder.processFrame(371.6); // 371.6 - 221.6 = 150ms (>100ms)
        recorder.endStep("step_b");

        const json = JSON.parse(recorder.finalize()) as WebTraceReport;
        const stats = json.summary.frameStats;

        expect(stats).toBeDefined();
        expect(stats?.hitchCount).toBe(3);

        const hitches = stats!.hitches;
        expect(hitches[0]?.severity).toBe("slight");
        expect(hitches[0]?.activeStep).toBe("step_a");
        expect(hitches[0]?.durationMs).toBe(35);

        expect(hitches[1]?.severity).toBe("moderate");
        expect(hitches[1]?.activeStep).toBe("idle");
        expect(hitches[1]?.durationMs).toBe(70);

        expect(hitches[2]?.severity).toBe("severe");
        expect(hitches[2]?.activeStep).toBe("step_b");
        expect(hitches[2]?.durationMs).toBe(150);

        // Check worst hitch
        expect(stats?.worstHitch?.durationMs).toBe(150);
        expect(stats?.worstHitch?.severity).toBe("severe");
        expect(stats?.worstHitch?.activeStep).toBe("step_b");

        // Check per-step breakdown
        expect(stats?.hitchesByStep["step_a"]).toBeDefined();
        expect(stats?.hitchesByStep["step_a"]?.hitchCount).toBe(1);
        expect(stats?.hitchesByStep["step_a"]?.worstHitchMs).toBe(35);

        expect(stats?.hitchesByStep["step_b"]).toBeDefined();
        expect(stats?.hitchesByStep["step_b"]?.hitchCount).toBe(1);
        expect(stats?.hitchesByStep["step_b"]?.worstHitchMs).toBe(150);

        // Check instant trace events
        const hitchEvents = json.traceEvents.filter((e) => e.cat === "frame_drop");
        expect(hitchEvents.length).toBe(3);
        expect(hitchEvents[0]?.name).toBe("frame_hitch_slight");
        expect(hitchEvents[0]?.tid).toBe(FRAME_CONFIG.TRACK_HITCHES_TID);
        expect(hitchEvents[2]?.name).toBe("frame_hitch_severe");
    });

    it("calculates total dropped frames accurately based on target interval", () => {
        recorder.start();

        recorder.processFrame(0);
        // Interval of 50ms = dropped ~2 frames (50 / 16.67 ≈ 3 total frames, minus 1 = 2 dropped)
        recorder.processFrame(50);

        const json = JSON.parse(recorder.finalize()) as WebTraceReport;
        expect(json.summary.droppedFrames).toBe(2);
        expect(json.summary.frameStats?.totalDroppedFrames).toBe(2);
    });

    it("handles zero frames gracefully", () => {
        recorder.start();
        const json = JSON.parse(recorder.finalize()) as WebTraceReport;
        expect(json.summary.frameCount).toBe(0);
        expect(json.summary.droppedFrames).toBe(0);
        expect(json.summary.frameStats?.worstHitch).toBeNull();
        expect(json.summary.frameStats?.hitches.length).toBe(0);
    });
});

describe("WebTraceRecorder - Web Memory & DOM Analytics", () => {
    let recorder: WebTraceRecorder;

    beforeEach(() => {
        document.body.innerHTML = "";
    });

    afterEach(() => {
        document.body.innerHTML = "";
        recorder?.finalize();
    });

    it("calculates canvas GPU texture memory and counts DOM nodes", () => {
        // Create 2 test canvases:
        // Canvas 1: 100 x 100 x 4 bytes = 40,000 bytes
        const c1 = document.createElement("canvas");
        c1.width = 100;
        c1.height = 100;
        document.body.appendChild(c1);

        // Canvas 2: 200 x 150 x 4 bytes = 120,000 bytes
        const c2 = document.createElement("canvas");
        c2.width = 200;
        c2.height = 150;
        document.body.appendChild(c2);

        // Total canvas texture bytes = 160,000 bytes ≈ 0.15 MB
        const providers: WebMemoryProviders = {
            getThumbnailCacheBytes: () => 1024 * 1024 * 5, // 5 MB
            getRenderedPreviewBytes: () => 1024 * 1024 * 10, // 10 MB
        };

        recorder = new WebTraceRecorder(providers);
        recorder.start();

        const snap = recorder.sampleMemory(500);
        expect(snap.canvasCount).toBe(2);
        expect(snap.canvasTextureBytes).toBe(160000);
        expect(snap.thumbnailCacheMB).toBe(5);
        expect(snap.renderedPreviewMB).toBe(10);
        expect(snap.totalTrackedMB).toBeCloseTo(15.15, 1);
        expect(snap.domNodeCount).toBeGreaterThanOrEqual(2);

        const report = JSON.parse(recorder.finalize()) as WebTraceReport;
        expect(report.summary.memoryStats).toBeDefined();
        const memStats = report.summary.memoryStats!;
        expect(memStats.peakCanvasCount).toBe(2);
        expect(memStats.peakThumbnailCacheMB).toBe(5);
        expect(memStats.peakRenderedPreviewMB).toBe(10);
        expect(memStats.peakTotalTrackedMB).toBeCloseTo(15.15, 1);

        // Check Chrome Trace Counter Events
        const memCounter = report.traceEvents.find(
            (e) => e.ph === "C" && e.name === "Web Memory (MB)"
        );
        expect(memCounter).toBeDefined();
        expect(memCounter?.args?.canvas_texture_mb).toBe(snap.canvasTextureMB);
        expect(memCounter?.args?.thumbnail_cache_mb).toBe(5);

        const domCounter = report.traceEvents.find(
            (e) => e.ph === "C" && e.name === "DOM & Canvas Counts"
        );
        expect(domCounter).toBeDefined();
        expect(domCounter?.args?.canvases).toBe(2);
    });

    it("tracks peak memory across steps and reports post-cleanup state", () => {
        let thumbBytes = 1024 * 1024 * 2; // 2 MB
        let previewBytes = 1024 * 1024 * 4; // 4 MB

        recorder = new WebTraceRecorder({
            getThumbnailCacheBytes: () => thumbBytes,
            getRenderedPreviewBytes: () => previewBytes,
        });
        recorder.start();

        recorder.startStep("heavy_edit");
        thumbBytes = 1024 * 1024 * 25; // Grow to 25 MB
        previewBytes = 1024 * 1024 * 15; // Grow to 15 MB
        recorder.sampleMemory(100);
        recorder.endStep("heavy_edit");

        recorder.startStep("cleanup");
        thumbBytes = 0;
        previewBytes = 0;
        recorder.sampleMemory(200);
        recorder.endStep("cleanup");

        const report = JSON.parse(recorder.finalize()) as WebTraceReport;
        const mem = report.summary.memoryStats!;
        expect(mem.peakThumbnailCacheMB).toBe(25);
        expect(mem.peakRenderedPreviewMB).toBe(15);
        expect(mem.peakTotalTrackedMB).toBe(40);
        expect(mem.finalTotalTrackedMB).toBe(0);
    });
});

describe("WebTraceRecorder - Main Thread Execution Lag", () => {
    it("records main-thread lag metrics in summary", () => {
        const recorder = new WebTraceRecorder();
        recorder.start();

        recorder.startStep("compute");
        recorder.endStep("compute");

        const report = JSON.parse(recorder.finalize()) as WebTraceReport;
        expect(report.summary.mainThreadLag).toBeDefined();
        expect(report.summary.mainThreadLag?.totalLagMs).toBeDefined();
        expect(report.summary.mainThreadLag?.stallCount).toBeDefined();
        expect(report.summary.mainThreadLag?.lagByStep).toBeDefined();
    });
});
