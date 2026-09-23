import { memo, useRef, useCallback, useEffect } from "react";
import s from "./ImagePane.module.css";
import { debug } from "../../utils/debug.ts"
import { useAppState } from "../../state/appState.ts";
import { getThumbnailData } from "../../services/thumbnailRegistry.ts";
import { GeometryOverlay } from "./GeometryOverlay.tsx";

export const ImagePane = memo(() => {
    const activeImage = useAppState(s => s.images[s.activeIndex]);
    const pixels = useAppState(s => s.renderedData);
    const renderedImageId = useAppState(s => s.renderedImageId);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const bitmapRef = useRef<ImageBitmap | null>(null);

    // Draw the stored bitmap into the canvas, scaled to contain within the
    // container. The canvas backing store is sized in device pixels so the
    // image stays sharp on Retina / HiDPI displays.
    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        const bitmap = bitmapRef.current;
        if (!canvas || !container || !bitmap) return;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = container.clientWidth;
        const cssH = container.clientHeight;
        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);
        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            debug.log("failed to created canvas::2d");
            return;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const scale = Math.min(cssW / bitmap.width, cssH / bitmap.height);
        const x = (cssW - bitmap.width * scale) / 2;
        const y = (cssH - bitmap.height * scale) / 2;
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(bitmap, x, y, bitmap.width * scale, bitmap.height * scale);
    }, []);

    // Decode incoming pixel data into a GPU-resident ImageBitmap, then draw.
    // Cancels stale decodes so a slow promise can never overwrite a newer
    // bitmap, and closes the old bitmap when it is replaced.
    useEffect(() => {
        if (!activeImage) {
            bitmapRef.current?.close();
            bitmapRef.current = null;
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        let cancelled = false;

        const isFullResMatch = pixels && renderedImageId === activeImage.id;
        const sourceData = isFullResMatch ? pixels : getThumbnailData(activeImage.id);

        if (!sourceData) {
            return;
        }

        const bytes = sourceData.data as Uint8ClampedArray<ArrayBuffer>;
        createImageBitmap(new ImageData(bytes, sourceData.width, sourceData.height)).then((bitmap) => {
            if (cancelled) {
                bitmap.close();
                return;
            }
            bitmapRef.current?.close();
            bitmapRef.current = bitmap;
            draw();
        });
        return () => { cancelled = true; };
    }, [activeImage?.id, pixels, renderedImageId, draw]);

    // Redraw whenever the container is resized (e.g. window resize).
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver(draw);
        ro.observe(container);
        return () => ro.disconnect();
    }, [draw]);

    // Release the current bitmap and canvas backing store on unmount.
    useEffect(() => {
        return () => {
            bitmapRef.current?.close();
            bitmapRef.current = null;
            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
        };
    }, []);

    const hasContent = !!activeImage && (
        (pixels && renderedImageId === activeImage.id) ||
        !!getThumbnailData(activeImage.id) ||
        !!bitmapRef.current
    );

    return (
        <div ref={containerRef} data-testid="image-pane" className={s.imagePane}>
            {hasContent
                ? <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
                : <div className={s.imagePlaceholder} />}
            <GeometryOverlay />
        </div>
    );
});
