import { memo, useRef, useEffect } from "react";
import { useAppState } from "../../state/appState.ts";

const RED_BUF = new Float32Array(256);
const GREEN_BUF = new Float32Array(256);
const BLUE_BUF = new Float32Array(256);
const LUMA_BUF = new Float32Array(256);

function drawCurve(
    ctx: CanvasRenderingContext2D,
    counts: Float32Array,
    W: number,
    H: number,
    fillColor: string,
    strokeColor: string,
) {
    let max = 0;
    for (const c of counts) if (c > max) max = c;
    if (max === 0) return;
    const logMax = Math.log1p(max);

    // Build the top curve path once, reuse for fill and stroke.
    ctx.beginPath();
    counts.forEach((c, i) => {
        if (i === 0) ctx.moveTo(0, H - (Math.log1p(c) / logMax) * H);
        else ctx.lineTo((i / 255) * W, H - (Math.log1p(c) / logMax) * H);
    });

    // Stroke the top line (solid).
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Close down to form the filled area and fill semi-transparently.
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
}

export const HistogramView = memo(({ className }: {
    className?: string;
}) => {
    const histogram = useAppState(s => s.renderedHistogram);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!histogram || !canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = 200, cssH = 80;
        if (canvas.width !== cssW * dpr) canvas.width = cssW * dpr;
        if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const W = cssW;
        const H = cssH;

        RED_BUF.set(histogram.red);
        GREEN_BUF.set(histogram.green);
        BLUE_BUF.set(histogram.blue);
        LUMA_BUF.set(histogram.luma);

        ctx.clearRect(0, 0, W, H);
        drawCurve(ctx, LUMA_BUF, W, H, "rgba(210,210,210,0.15)", "rgba(210,210,210,0.7)");
        drawCurve(ctx, BLUE_BUF, W, H, "rgba(80,140,255,0.15)", "rgba(80,140,255,0.9)");
        drawCurve(ctx, GREEN_BUF, W, H, "rgba(80,210,80,0.15)", "rgba(80,210,80,0.9)");
        drawCurve(ctx, RED_BUF, W, H, "rgba(255,80,80,0.15)", "rgba(255,80,80,0.9)");
    }, [histogram]);

    return <canvas data-testid="histogram" ref={canvasRef} width={200} height={80} style={{ width: 200, height: 80 }} className={className} />;
});
