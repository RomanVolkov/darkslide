import type { PixelData } from "../backend/types";

export class LruCache<K, V> {
    private map = new Map<K, V>();
    readonly capacity: number;

    constructor(capacity = 100) {
        this.capacity = capacity;
    }

    get(key: K): V | undefined {
        const value = this.map.get(key);
        if (value === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key: K, value: V): this {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.capacity) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) {
                this.map.delete(oldestKey);
            }
        }
        return this;
    }

    delete(key: K): boolean {
        return this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    get size(): number {
        return this.map.size;
    }

    values(): IterableIterator<V> {
        return this.map.values();
    }
}

export interface ThumbnailEntry {
    data: PixelData;
    quality: "fast" | "hq";
    adjHash?: number;
    adjJson?: string;
    /** Requested HQ render size in px; `undefined` for fast drafts. */
    maxDim?: number;
}

export const THUMBNAIL_REGISTRY_CAPACITY = 500;

export const thumbnailRegistry = new LruCache<string, ThumbnailEntry>(THUMBNAIL_REGISTRY_CAPACITY);

export function getThumbnailRegistryMemoryBytes(): number {
    let total = 0;
    for (const entry of thumbnailRegistry.values()) {
        if (entry?.data?.data) {
            total += entry.data.data.byteLength;
        }
    }
    return total;
}

export function getThumbnailData(id: string): PixelData | undefined {
    const entry = thumbnailRegistry.get(id);
    if (!entry) return undefined;
    if ("quality" in entry) {
        return (entry as ThumbnailEntry).data;
    }
    return entry as unknown as PixelData;
}
