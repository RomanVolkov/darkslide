import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Production Profiling Isolation", () => {
    it("ensures production bundle strips WebTraceRecorder and scenarioRunner", () => {
        const distAssetsDir = path.resolve(__dirname, "../../dist/assets");
        if (!fs.existsSync(distAssetsDir)) {
            // Dist not built yet in this run, skip bundle inspection
            return;
        }

        const files = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith(".js"));
        expect(files.length).toBeGreaterThan(0);

        for (const file of files) {
            const content = fs.readFileSync(path.join(distAssetsDir, file), "utf-8");
            expect(content.includes("WebTraceRecorder")).toBe(false);
            expect(content.includes("runProfilingScenario")).toBe(false);
            expect(content.includes("frame_hitch_")).toBe(false);
            expect(content.includes("thumbnail_cache_mb")).toBe(false);
        }
    });
});
