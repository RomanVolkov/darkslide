import { memo, useRef, useEffect, useState, useCallback } from "react";
import type { CurvePoint, Curves } from "../../backend/types.ts";
import { evaluateCurve } from "../../utils/curve.ts";
import s from "./CurveEditor.module.css";
import { keyboardManager, NormalizedKeyEvent, KeyboardEventType, RegistrationID } from "../../services/KeyboardManager.ts";
import { useAppState } from "../../state/appState.ts";
import { Key } from "../constants/index.ts";
import { useLatest } from "../../utils/utils.ts";
import { DEFAULT_CURVE } from "../../types/adjustments.ts";
import { CURVE_CANVAS_SIZE } from "./constants.ts";

export type CurveChannel = "rgb" | "red" | "green" | "blue";
const CHANNELS: CurveChannel[] = ["rgb", "red", "green", "blue"];
const CHANNEL_LABELS: Record<CurveChannel, string> = { rgb: "RGB", red: "R", green: "G", blue: "B" };
// Luminance (rgb) is white; per-channel curves use their own hue.
const CHANNEL_COLORS: Record<CurveChannel, string> = {
    rgb: "rgba(255,255,255,0.92)",
    red: "rgba(255,90,90,0.92)",
    green: "rgba(90,220,110,0.92)",
    blue: "rgba(100,150,255,0.92)",
};
const CHANNEL_COLORS_FAINT: Record<CurveChannel, string> = {
    rgb: "rgba(255,255,255,0.28)",
    red: "rgba(255,90,90,0.3)",
    green: "rgba(90,220,110,0.3)",
    blue: "rgba(100,150,255,0.3)",
};

export const CurveEditor = memo(({ curves, active, focused, selectedPoint, setSelectedPoint, setCurveActive, onActivate }: {
    curves: Curves;
    active: boolean; // currently in curve-edit mode
    focused: boolean; // focusedIndex is on this row (sidebar focus)
    selectedPoint: number;
    setSelectedPoint: React.Dispatch<React.SetStateAction<number>>;
    setCurveActive: React.Dispatch<React.SetStateAction<boolean>>;
    onActivate?: () => void;
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [activeChannel, setActiveChannel] = useState<CurveChannel>("rgb");
    const curve = curves[activeChannel] ?? [];
    const dragRef = useRef<number | null>(null);

    const applyCurve = useCallback((newCurve: CurvePoint[]) => {
        const { images, activeIndex, updateImage } = useAppState.getState();
        const activeImage = images[activeIndex];
        if (!activeImage) return;
        const ch = localStateRef.current.activeChannel;
        updateImage(activeImage.id, (img) => {
            img.adjustments = {
                ...img.adjustments,
                curves: { ...img.adjustments.curves, [ch]: newCurve },
            };
        });
    }, []);

    // selectedPoint is owned by the parent so the highlight stays in sync after
    // H/L navigation and panel re-renders — don't shadow it with local state.
    const localStateRef = useLatest({ curvePointIndex: selectedPoint, setCurveActive, activeChannel, applyCurve });

    const getActiveCurve = () => {
        const { images, activeIndex } = useAppState.getState();
        const activeImage = images[activeIndex];
        const ch = localStateRef.current?.activeChannel ?? activeChannel;
        return activeImage?.adjustments.curves[ch] ?? curve;
    };

    const findPointIndex = (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return -1;
        const rect = canvas.getBoundingClientRect();
        let bestIdx = -1;
        let minDst = 16;
        const curCurve = getActiveCurve();
        for (let i = 0; i < curCurve.length; i++) {
            const pt = curCurve[i];
            if (!pt) continue;
            const px = rect.left + (pt.x / 255) * rect.width;
            const py = rect.bottom - (pt.y / 255) * rect.height;
            const dst = Math.hypot(clientX - px, clientY - py);
            if (dst < minDst) {
                minDst = dst;
                bestIdx = i;
            }
        }
        return bestIdx;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        onActivate?.();
        setCurveActive(true);
        keyboardManager.setActive(RegistrationID.curve);

        const canvas = canvasRef.current;
        if (!canvas) return;

        const hitIdx = findPointIndex(e.clientX, e.clientY);
        if (hitIdx !== -1) {
            setSelectedPoint(hitIdx);
            dragRef.current = hitIdx;
            (e.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
        } else {
            const curCurve = getActiveCurve();
            const rect = canvas.getBoundingClientRect();
            const cx = Math.round(Math.max(1, Math.min(254, ((e.clientX - rect.left) / rect.width) * 255)));
            const cy = Math.round(Math.max(0, Math.min(255, ((rect.bottom - e.clientY) / rect.height) * 255)));

            let insertIdx = 1;
            while (insertIdx < curCurve.length && curCurve[insertIdx]!.x <= cx) {
                insertIdx++;
            }
            const prev = curCurve[insertIdx - 1];
            const next = curCurve[insertIdx];
            if (prev && next && prev.x < cx && cx < next.x) {
                const newPoint = { x: cx, y: cy };
                const nc = [...curCurve.slice(0, insertIdx), newPoint, ...curCurve.slice(insertIdx)];
                setSelectedPoint(insertIdx);
                applyCurve(nc);
                dragRef.current = insertIdx;
                (e.currentTarget as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
            }
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const pi = dragRef.current;
        if (pi === null) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const curCurve = getActiveCurve();
        const rect = canvas.getBoundingClientRect();
        const rawX = Math.round(((e.clientX - rect.left) / rect.width) * 255);
        const rawY = Math.round(((rect.bottom - e.clientY) / rect.height) * 255);
        const y = Math.max(0, Math.min(255, rawY));

        let x: number;
        if (pi === 0) {
            x = 0;
        } else if (pi === curCurve.length - 1) {
            x = 255;
        } else {
            const prev = curCurve[pi - 1];
            const next = curCurve[pi + 1];
            const minX = (prev ? prev.x : 0) + 1;
            const maxX = (next ? next.x : 255) - 1;
            x = Math.max(minX, Math.min(maxX, rawX));
        }

        applyCurve(curCurve.map((p, idx) => (idx === pi ? { x, y } : p)));
    };

    const onPointerUp = () => {
        dragRef.current = null;
    };

    const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const curCurve = getActiveCurve();
        const hitIdx = findPointIndex(e.clientX, e.clientY);
        if (hitIdx > 0 && hitIdx < curCurve.length - 1) {
            const nc = curCurve.filter((_, idx) => idx !== hitIdx);
            setSelectedPoint(Math.max(0, hitIdx - 1));
            applyCurve(nc);
        }
    };

    const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const curCurve = getActiveCurve();
        const hitIdx = findPointIndex(e.clientX, e.clientY);
        if (hitIdx > 0 && hitIdx < curCurve.length - 1) {
            const nc = curCurve.filter((_, idx) => idx !== hitIdx);
            setSelectedPoint(Math.max(0, hitIdx - 1));
            applyCurve(nc);
        }
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
        if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
        if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const W = cssW, H = cssH;

        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = "#242424";
        ctx.fillRect(0, 0, W, H);

        // Grid
        ctx.strokeStyle = "rgba(255,255,255,0.07)";
        ctx.lineWidth = 1;
        for (const v of [0.25, 0.5, 0.75]) {
            ctx.beginPath(); ctx.moveTo(v * W, 0); ctx.lineTo(v * W, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, v * H); ctx.lineTo(W, v * H); ctx.stroke();
        }

        // Linear reference
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
        ctx.setLineDash([]);

        // All four curves at once: inactive channels faint, active highlighted.
        for (const ch of CHANNELS) {
            const pts = curves[ch] ?? [];
            const isActive = ch === activeChannel;
            ctx.strokeStyle = isActive ? CHANNEL_COLORS[ch] : CHANNEL_COLORS_FAINT[ch];
            ctx.lineWidth = isActive ? 1.8 : 1.2;
            ctx.beginPath();
            for (let xi = 0; xi <= 255; xi++) {
                const yi = evaluateCurve(pts, xi);
                const cx = (xi / 255) * W, cy = H - (yi / 255) * H;
                xi === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        }

        // Control points for the active channel only.
        curve.forEach((pt, i) => {
            const cx = (pt.x / 255) * W, cy = H - (pt.y / 255) * H;
            const sel = active && i === selectedPoint;
            ctx.fillStyle = sel ? "rgba(255,160,60,1)" : CHANNEL_COLORS[activeChannel];
            ctx.beginPath(); ctx.arc(cx, cy, sel ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
            if (sel) {
                ctx.strokeStyle = "rgba(255,160,60,0.4)";
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
            }
        });
    }, [curves, activeChannel, curve, active, focused, selectedPoint]);


    useEffect(() => {
        keyboardManager.register(RegistrationID.curve, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;

            const { images, activeIndex } = useAppState.getState();
            const activeImage = images[activeIndex];
            const channel = localStateRef.current.activeChannel;
            const curve = activeImage?.adjustments.curves[channel] ?? [];
            const curveLen = curve.length;

            const applyCurve = (newCurve: CurvePoint[]) => {
                localStateRef.current.applyCurve(newCurve);
            };

            const count = e.count;
            switch (e.key) {
                case Key.Tab: {
                    e.origin.preventDefault();
                    setSelectedPoint(0);
                    setActiveChannel((c) => {
                        const i = CHANNELS.indexOf(c);
                        return CHANNELS[(i + 1) % CHANNELS.length] ?? "rgb";
                    });
                    return true;
                }
                case Key.h: {
                    const pi = localStateRef.current.curvePointIndex;
                    if (pi <= 0 || pi >= curveLen - 1) return false;
                    const step = count * 5;
                    const prev = curve[pi - 1];
                    if (!prev) return false;
                    applyCurve(curve.map((p, ci) =>
                        ci !== pi ? p : { ...p, x: Math.max(prev.x + 1, p.x - step) }));
                    return true;
                }
                case Key.l: {
                    const pi = localStateRef.current.curvePointIndex;
                    if (pi <= 0 || pi >= curveLen - 1) return false;
                    const step = count * 5;
                    const next = curve[pi + 1];
                    if (!next) return false;
                    applyCurve(curve.map((p, ci) =>
                        ci !== pi ? p : { ...p, x: Math.min(next.x - 1, p.x + step) }));
                    return true;
                }
                case Key.j: {
                    const pi = localStateRef.current.curvePointIndex;
                    const step = count * 5;
                    applyCurve(curve.map((p, ci) =>
                        ci !== pi ? p : { ...p, y: Math.max(0, Math.min(255, p.y - step)) }));
                    return true;
                }
                case Key.k: {
                    const pi = localStateRef.current.curvePointIndex;
                    const step = count * 5;
                    applyCurve(curve.map((p, ci) =>
                        ci !== pi ? p : { ...p, y: Math.max(0, Math.min(255, p.y + step)) }));
                    return true;
                }
                case Key.h.toUpperCase(): {
                    if (curveLen === 0) return false;
                    setSelectedPoint((i) => ((i - count) % curveLen + curveLen) % curveLen);
                    return true;
                }
                case Key.l.toUpperCase(): {
                    if (curveLen === 0) return false;
                    setSelectedPoint((i) => (i + count) % curveLen);
                    return true;
                }
                case Key.a: {
                    const pi = localStateRef.current.curvePointIndex;
                    const insertAfter = pi >= curveLen - 1 ? pi - 1 : pi;
                    const p0 = curve[insertAfter], p1 = curve[insertAfter + 1];
                    if (!p0 || !p1) return false;
                    const nx = Math.round((p0.x + p1.x) / 2);
                    const ny = Math.round(evaluateCurve(curve, nx));
                    const nc = [...curve.slice(0, insertAfter + 1), { x: nx, y: ny }, ...curve.slice(insertAfter + 1)];
                    setSelectedPoint(insertAfter + 1);
                    applyCurve(nc);
                    return true;
                }
                case Key.d: {
                    const pi = localStateRef.current.curvePointIndex;
                    if (pi > 0 && pi < curveLen - 1) {
                        const nc = curve.filter((_, ci) => ci !== pi);
                        setSelectedPoint(Math.min(pi, curveLen - 3));
                        applyCurve(nc);
                    }
                    return true;
                }
                case Key.Zero: {
                    setSelectedPoint(0);
                    applyCurve([...DEFAULT_CURVE]);
                    return true;
                }
                case Key.Escape:
                    e.origin.preventDefault();
                    localStateRef.current.setCurveActive(false);
                    keyboardManager.setActive(RegistrationID.adjustments);
                    return true;

                default:
                    return false;
            }
        }, false);
        return () => { keyboardManager.unregister(RegistrationID.curve); }
    }, []);

    return (
        <div
            className={`${s.row}${focused || active ? ` ${s.rowFocused}` : ""}`}
            data-focused={focused || active}
            data-row-type="curve"
            onClick={onActivate}
            style={{ cursor: onActivate ? "pointer" : undefined }}
        >
            <canvas
                ref={canvasRef}
                width={CURVE_CANVAS_SIZE}
                height={CURVE_CANVAS_SIZE}
                className={s.canvas}
                data-testid="curve-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
            />
            <div className={s.tabs} role="tablist" aria-label="Curve channel">
                {CHANNELS.map((ch) => (
                    <button
                        key={ch}
                        type="button"
                        role="tab"
                        aria-selected={ch === activeChannel}
                        className={`${s.tab}${ch === activeChannel ? ` ${s.tabActive}` : ""}`}
                        onClick={() => setActiveChannel(ch)}
                        title={`${CHANNEL_LABELS[ch]} curve`}
                    >
                        {CHANNEL_LABELS[ch]}
                    </button>
                ))}
                <button
                    type="button"
                    className={s.resetBtn}
                    onClick={(e) => {
                        e.stopPropagation();
                        setSelectedPoint(0);
                        applyCurve([...DEFAULT_CURVE]);
                    }}
                    title="Reset Curve (0)"
                    data-testid="curve-reset-btn"
                >
                    Reset
                </button>
            </div>
            {focused && (
                <div className={s.hint}>Enter to edit · Tab channel · H/L switch handle</div>
            )}
        </div>
    );
});
