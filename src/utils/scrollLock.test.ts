import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { canScrollTarget, lockScroll } from "./scrollLock.ts";

describe("scrollLock", () => {
    let container: HTMLDivElement;
    let scrollable: HTMLDivElement;
    let child: HTMLSpanElement;

    beforeEach(() => {
        container = document.createElement("div");
        scrollable = document.createElement("div");
        child = document.createElement("span");

        scrollable.style.overflowY = "auto";
        scrollable.style.overflowX = "hidden";
        Object.defineProperty(scrollable, "scrollHeight", { value: 300, configurable: true });
        Object.defineProperty(scrollable, "clientHeight", { value: 100, configurable: true });
        Object.defineProperty(scrollable, "scrollTop", { value: 50, writable: true, configurable: true });

        scrollable.appendChild(child);
        container.appendChild(scrollable);
        document.body.appendChild(container);
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("allows scroll when container is in the middle of scroll range", () => {
        expect(canScrollTarget(child, 0, 10)).toBe(true);
        expect(canScrollTarget(child, 0, -10)).toBe(true);
    });

    it("disallows vertical scroll when at top and scrolling up", () => {
        scrollable.scrollTop = 0;
        expect(canScrollTarget(child, 0, -10)).toBe(false);
    });

    it("allows vertical scroll when at top and scrolling down", () => {
        scrollable.scrollTop = 0;
        expect(canScrollTarget(child, 0, 10)).toBe(true);
    });

    it("disallows vertical scroll when at bottom and scrolling down", () => {
        scrollable.scrollTop = 200;
        expect(canScrollTarget(child, 0, 10)).toBe(false);
    });

    it("disallows scroll on non-scrollable target", () => {
        const nonScrollable = document.createElement("div");
        container.appendChild(nonScrollable);
        expect(canScrollTarget(nonScrollable, 0, 10)).toBe(false);
        expect(canScrollTarget(nonScrollable, 10, 0)).toBe(false);
    });

    it("locks wheel event when scroll cannot be consumed", () => {
        const unlock = lockScroll(window);
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "target", { value: container });
        Object.defineProperty(event, "deltaY", { value: 10 });
        Object.defineProperty(event, "deltaX", { value: 0 });

        const preventDefaultSpy = vi.spyOn(event, "preventDefault");
        window.dispatchEvent(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
        unlock();
    });

    it("does not lock wheel event when scroll can be consumed", () => {
        const unlock = lockScroll(window);
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "target", { value: child });
        Object.defineProperty(event, "deltaY", { value: 10 });
        Object.defineProperty(event, "deltaX", { value: 0 });

        const preventDefaultSpy = vi.spyOn(event, "preventDefault");
        window.dispatchEvent(event);

        expect(preventDefaultSpy).not.toHaveBeenCalled();
        unlock();
    });

    it("prevents gesturestart events", () => {
        const unlock = lockScroll(window);
        const event = new Event("gesturestart", { bubbles: true, cancelable: true });
        const preventDefaultSpy = vi.spyOn(event, "preventDefault");
        window.dispatchEvent(event);

        expect(preventDefaultSpy).toHaveBeenCalled();
        unlock();
    });
});
