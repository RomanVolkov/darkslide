import "@testing-library/jest-dom";

class IntersectionObserverMock implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "0px";
    readonly thresholds: ReadonlyArray<number> = [0];
    private callback: IntersectionObserverCallback;
    private elements = new Set<Element>();

    constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element): void {
        this.elements.add(target);
        // Immediately report the element as intersecting so visibility-driven
        // effects run synchronously in tests.
        this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this,
        );
    }

    unobserve(target: Element): void {
        this.elements.delete(target);
    }

    disconnect(): void {
        this.elements.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

// jsdom does not implement IntersectionObserver; provide a minimal stub for
// components that depend on visibility tracking.
global.IntersectionObserver = IntersectionObserverMock;

// jsdom does not implement ResizeObserver; provide a no-op stub.
if (typeof global.ResizeObserver === "undefined") {
    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
}

// jsdom's canvas implementation does not support getContext("2d"); stub a
// minimal 2D context so canvas-based components can render in tests.
const originalGetContext = HTMLCanvasElement.prototype.getContext;
(HTMLCanvasElement.prototype as unknown as { getContext: Function }).getContext = function (
    contextId: string,
    options?: unknown,
) {
    if (contextId === "2d") {
        return {
            putImageData: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray(0) }),
            createImageData: () => ({ data: new Uint8ClampedArray(0) }),
            drawImage: () => {},
            clearRect: () => {},
            fillRect: () => {},
            strokeRect: () => {},
            setTransform: () => {},
            beginPath: () => {},
            closePath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            arc: () => {},
            stroke: () => {},
            fill: () => {},
            setLineDash: () => {},
            save: () => {},
            restore: () => {},
            translate: () => {},
            rotate: () => {},
            scale: () => {},
            measureText: () => ({ width: 0 }),
            fillText: () => {},
            strokeText: () => {},
            canvas: this,
        } as unknown as CanvasRenderingContext2D;
    }
    return originalGetContext.call(this, contextId, options);
};

// jsdom does not implement Element.scrollIntoView; stub it.
Element.prototype.scrollIntoView = function () {};

// jsdom does not implement Element.scrollTo; stub it.
Element.prototype.scrollTo = function () {};

// jsdom does not implement ImageData; provide a minimal constructor.
global.ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace: PredefinedColorSpace = "srgb";

    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, heightOrOptions?: number) {
        if (typeof dataOrWidth === "number") {
            this.width = dataOrWidth;
            this.height = widthOrHeight;
            this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
            this.data = dataOrWidth;
            this.width = widthOrHeight;
            this.height = heightOrOptions ?? this.data.length / (this.width * 4);
        }
    }
} as unknown as typeof ImageData;
