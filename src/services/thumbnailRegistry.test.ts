import { describe, it, expect, beforeEach } from "vitest";
import { LruCache, thumbnailRegistry, getThumbnailData, THUMBNAIL_REGISTRY_CAPACITY } from "./thumbnailRegistry";
import type { PixelData } from "../backend/types";

function makePixelData(width = 10, height = 10): PixelData {
    return {
        kind: "raw",
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
    };
}

describe("LruCache", () => {
    it("stores and retrieves values", () => {
        const cache = new LruCache<string, number>(3);
        cache.set("a", 1);
        cache.set("b", 2);
        expect(cache.get("a")).toBe(1);
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBeUndefined();
        expect(cache.size).toBe(2);
    });

    it("evicts the least recently used item when capacity is exceeded", () => {
        const cache = new LruCache<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);

        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBe(3);
        expect(cache.size).toBe(2);
    });

    it("accessing an item marks it as recently used", () => {
        const cache = new LruCache<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.get("a")).toBe(1);

        cache.set("c", 3);

        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe(1);
        expect(cache.get("c")).toBe(3);
    });

    it("updating an existing key updates its value and moves it to most recent", () => {
        const cache = new LruCache<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("a", 10);

        cache.set("c", 3);

        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe(10);
        expect(cache.get("c")).toBe(3);
    });

    it("supports delete, has, and clear", () => {
        const cache = new LruCache<string, number>(3);
        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.has("a")).toBe(true);
        expect(cache.has("z")).toBe(false);

        expect(cache.delete("a")).toBe(true);
        expect(cache.delete("z")).toBe(false);
        expect(cache.has("a")).toBe(false);
        expect(cache.size).toBe(1);

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.has("b")).toBe(false);
    });
});

describe("thumbnailRegistry", () => {
    beforeEach(() => {
        thumbnailRegistry.clear();
    });

    it("stores and retrieves thumbnail data through getThumbnailData", () => {
        const data = makePixelData();
        thumbnailRegistry.set("img-1", { data, quality: "fast", adjJson: "{}" });

        expect(getThumbnailData("img-1")).toBe(data);
        expect(getThumbnailData("img-2")).toBeUndefined();
    });

    it("stores and updates quality and adjustment json in thumbnail entry", () => {
        const fastData = makePixelData(10, 10);
        const hqData = makePixelData(20, 20);

        thumbnailRegistry.set("img-1", { data: fastData, quality: "fast", adjJson: '{"exposure":0}' });
        expect(thumbnailRegistry.get("img-1")?.quality).toBe("fast");
        expect(thumbnailRegistry.get("img-1")?.adjJson).toBe('{"exposure":0}');
        expect(getThumbnailData("img-1")).toBe(fastData);

        thumbnailRegistry.set("img-1", { data: hqData, quality: "hq", adjJson: '{"exposure":0}' });
        expect(thumbnailRegistry.get("img-1")?.quality).toBe("hq");
        expect(getThumbnailData("img-1")).toBe(hqData);

        const editedData = makePixelData(20, 20);
        thumbnailRegistry.set("img-1", { data: editedData, quality: "hq", adjJson: '{"exposure":15}' });
        expect(thumbnailRegistry.get("img-1")?.adjJson).toBe('{"exposure":15}');
        expect(getThumbnailData("img-1")).toBe(editedData);
    });

    it("stores and updates quality and adjustment hash in thumbnail entry", () => {
        const fastData = makePixelData(10, 10);
        const hqData = makePixelData(20, 20);

        thumbnailRegistry.set("img-1", { data: fastData, quality: "fast", adjHash: 123456 });
        expect(thumbnailRegistry.get("img-1")?.quality).toBe("fast");
        expect(thumbnailRegistry.get("img-1")?.adjHash).toBe(123456);
        expect(getThumbnailData("img-1")).toBe(fastData);

        thumbnailRegistry.set("img-1", { data: hqData, quality: "hq", adjHash: 789012 });
        expect(thumbnailRegistry.get("img-1")?.quality).toBe("hq");
        expect(thumbnailRegistry.get("img-1")?.adjHash).toBe(789012);
        expect(getThumbnailData("img-1")).toBe(hqData);
    });

    it("stores and updates the requested HQ maxDim in the entry", () => {
        const stripData = makePixelData(200, 150);
        thumbnailRegistry.set("img-1", { data: stripData, quality: "hq", adjHash: 42, maxDim: 200 });
        expect(thumbnailRegistry.get("img-1")?.maxDim).toBe(200);
        expect(getThumbnailData("img-1")).toBe(stripData);

        const gridData = makePixelData(400, 300);
        thumbnailRegistry.set("img-1", { data: gridData, quality: "hq", adjHash: 42, maxDim: 400 });
        expect(thumbnailRegistry.get("img-1")?.maxDim).toBe(400);
        expect(getThumbnailData("img-1")).toBe(gridData);
    });

    it("bounds cache size to capacity and evicts oldest items", () => {
        const total = THUMBNAIL_REGISTRY_CAPACITY + 20;
        for (let i = 0; i < total; i++) {
            thumbnailRegistry.set(`img-${i}`, {
                data: makePixelData(),
                quality: "fast",
                adjJson: "{}",
            });
        }

        expect(thumbnailRegistry.size).toBe(THUMBNAIL_REGISTRY_CAPACITY);
        expect(thumbnailRegistry.has("img-0")).toBe(false);
        expect(thumbnailRegistry.has(`img-${total - THUMBNAIL_REGISTRY_CAPACITY - 1}`)).toBe(false);
        expect(thumbnailRegistry.has(`img-${total - THUMBNAIL_REGISTRY_CAPACITY}`)).toBe(true);
        expect(thumbnailRegistry.has(`img-${total - 1}`)).toBe(true);
    });
});
