export function canScrollTarget(
    target: EventTarget | null,
    deltaX: number,
    deltaY: number,
): boolean {
    let el = target instanceof HTMLElement ? target : null;
    while (el && el !== document.body && el !== document.documentElement) {
        const style = window.getComputedStyle(el);

        if (Math.abs(deltaY) > 0) {
            const canScrollY =
                (style.overflowY === "auto" || style.overflowY === "scroll") &&
                el.scrollHeight > el.clientHeight;
            if (canScrollY) {
                if (deltaY < 0 && el.scrollTop > 0.5) return true;
                if (deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 0.5) return true;
            }
        }

        if (Math.abs(deltaX) > 0) {
            const canScrollX =
                (style.overflowX === "auto" || style.overflowX === "scroll") &&
                el.scrollWidth > el.clientWidth;
            if (canScrollX) {
                if (deltaX < 0 && el.scrollLeft > 0.5) return true;
                if (deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 0.5) return true;
            }
        }

        el = el.parentElement;
    }
    return false;
}

export function lockScroll(target: Window = window): () => void {
    const onWheel = (e: WheelEvent) => {
        if (!canScrollTarget(e.target, e.deltaX, e.deltaY)) {
            e.preventDefault();
        }
    };

    const onGesture = (e: Event) => {
        e.preventDefault();
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    target.addEventListener("gesturestart", onGesture);
    target.addEventListener("gesturechange", onGesture);
    target.addEventListener("gestureend", onGesture);

    return () => {
        target.removeEventListener("wheel", onWheel);
        target.removeEventListener("gesturestart", onGesture);
        target.removeEventListener("gesturechange", onGesture);
        target.removeEventListener("gestureend", onGesture);
    };
}
