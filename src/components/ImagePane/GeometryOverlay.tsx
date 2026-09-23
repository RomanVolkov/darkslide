import { memo, useEffect, useRef, useState } from "react";
import s from "./GeometryOverlay.module.css";
import {
    keyboardManager,
    NormalizedKeyEvent,
    KeyboardEventType,
    RegistrationID,
} from "../../services/KeyboardManager.ts";
import { useAppState } from "../../state/appState.ts";
import { getThumbnailData } from "../../services/thumbnailRegistry.ts";
import { Key } from "../constants/index.ts";
import { useLatest } from "../../utils/utils.ts";
import type { Geometry } from "../../backend/types.ts";

type SubMode = "rotate" | "perspective" | "distortion" | "position";
const SUBMODES: SubMode[] = ["rotate", "perspective", "distortion", "position"];

const STRAIGHTEN_MAX = 45;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const PERSPECTIVE_MAX = 100;
const DISTORTION_MAX = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Keyboard-first crop/straighten overlay.
 *
 * `g` (from the adjustments panel) enters the mode. `Tab` cycles between
 * rotate, perspective, distortion, and position sub-modes; `h`/`l` change angle (or pan x,
 * horizontal perspective, distortion), `j`/`k` change zoom (or pan y, vertical perspective);
 * shift is the coarse step; `0` / `x` resets; `Enter`/`Escape` exit.
 * Dragging the overlay adjusts the active mode with the mouse.
 */
export const GeometryOverlay = memo(() => {
    const active = useAppState(s => s.geometryEdit);
    const geometry = useAppState(s => s.images[s.activeIndex]?.adjustments.geometry);
    const activeImage = useAppState(s => s.images[s.activeIndex]);
    const pixels = useAppState(s => s.renderedData);
    const renderedImageId = useAppState(s => s.renderedImageId);
    const [subMode, setSubMode] = useState<SubMode>("rotate");
    const localRef = useLatest({ subMode });
    const dragRef = useRef<{ x: number; y: number; g: Geometry } | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

    // Dimensions of the image currently displayed in the pane (full preview or
    // thumbnail fallback), used to align the crop frame with the image bounds.
    const source = activeImage
        ? (pixels && renderedImageId === activeImage.id ? pixels : getThumbnailData(activeImage.id))
        : null;
    const imgW = source?.width ?? 0;
    const imgH = source?.height ?? 0;

    useEffect(() => {
        const el = overlayRef.current;
        if (!active || !el || imgW === 0 || imgH === 0) {
            setFrame(null);
            return;
        }
        const compute = () => {
            const W = el.clientWidth;
            const H = el.clientHeight;
            if (!W || !H) return;
            const scale = Math.min(W / imgW, H / imgH);
            const width = imgW * scale;
            const height = imgH * scale;
            setFrame({ left: (W - width) / 2, top: (H - height) / 2, width, height });
        };
        compute();
        const ro = new ResizeObserver(compute);
        ro.observe(el);
        return () => ro.disconnect();
    }, [active, imgW, imgH]);

    const patchGeometry = (patch: Partial<Geometry>) => {
        const { images, activeIndex, updateImage } = useAppState.getState();
        const img = images[activeIndex];
        if (!img) return;
        updateImage(img.id, (im) => {
            im.adjustments = {
                ...im.adjustments,
                geometry: { ...im.adjustments.geometry, ...patch },
            };
        });
    };

    useEffect(() => {
        keyboardManager.register(RegistrationID.geometry, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;

            const { images, activeIndex } = useAppState.getState();
            const img = images[activeIndex];
            if (!img) return false;

            const g = img.adjustments.geometry;
            const mode = localRef.current.subMode;
            const count = e.count;
            // Shift+letter arrives as an uppercase `key`; normalize so the
            // h/l/j/k cases work and `e.shift` selects the coarse step.
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const angleStep = e.shift ? 1.0 : 0.1;
            const panStep = e.shift ? 0.25 : 0.05;
            const zoomStep = e.shift ? 0.1 : 0.02;
            const perspectiveStep = e.shift ? 5.0 : 1.0;
            const distortionStep = e.shift ? 5.0 : 1.0;
            // Fill-mode has no slack at zoom 1, so panning is only possible once
            // zoomed in. We never bump zoom implicitly — the HUD tells the user
            // to zoom first.
            const canPan = g.zoom > 1.0 + 1e-6;

            switch (key) {
                case Key.Tab: {
                    e.origin.preventDefault();
                    const curIdx = SUBMODES.indexOf(mode);
                    const nextIdx = e.shift
                        ? (curIdx - 1 + SUBMODES.length) % SUBMODES.length
                        : (curIdx + 1) % SUBMODES.length;
                    setSubMode(SUBMODES[nextIdx] ?? "rotate");
                    return true;
                }
                case Key.h:
                    if (mode === "rotate") {
                        patchGeometry({ straighten: clamp(g.straighten - angleStep * count, -STRAIGHTEN_MAX, STRAIGHTEN_MAX) });
                    } else if (mode === "perspective") {
                        patchGeometry({ perspective_h: clamp(g.perspective_h - perspectiveStep * count, -PERSPECTIVE_MAX, PERSPECTIVE_MAX) });
                    } else if (mode === "distortion") {
                        patchGeometry({ distortion: clamp(g.distortion - distortionStep * count, -DISTORTION_MAX, DISTORTION_MAX) });
                    } else if (canPan) {
                        patchGeometry({ crop_x: clamp(g.crop_x - panStep * count, -1, 1) });
                    }
                    return true;
                case Key.l:
                    if (mode === "rotate") {
                        patchGeometry({ straighten: clamp(g.straighten + angleStep * count, -STRAIGHTEN_MAX, STRAIGHTEN_MAX) });
                    } else if (mode === "perspective") {
                        patchGeometry({ perspective_h: clamp(g.perspective_h + perspectiveStep * count, -PERSPECTIVE_MAX, PERSPECTIVE_MAX) });
                    } else if (mode === "distortion") {
                        patchGeometry({ distortion: clamp(g.distortion + distortionStep * count, -DISTORTION_MAX, DISTORTION_MAX) });
                    } else if (canPan) {
                        patchGeometry({ crop_x: clamp(g.crop_x + panStep * count, -1, 1) });
                    }
                    return true;
                case Key.j:
                    if (mode === "rotate") {
                        patchGeometry({ zoom: clamp(g.zoom - zoomStep * count, ZOOM_MIN, ZOOM_MAX) });
                    } else if (mode === "perspective") {
                        patchGeometry({ perspective_v: clamp(g.perspective_v - perspectiveStep * count, -PERSPECTIVE_MAX, PERSPECTIVE_MAX) });
                    } else if (mode === "distortion") {
                        patchGeometry({ distortion: clamp(g.distortion - distortionStep * count, -DISTORTION_MAX, DISTORTION_MAX) });
                    } else if (canPan) {
                        patchGeometry({ crop_y: clamp(g.crop_y + panStep * count, -1, 1) });
                    }
                    return true;
                case Key.k:
                    if (mode === "rotate") {
                        patchGeometry({ zoom: clamp(g.zoom + zoomStep * count, ZOOM_MIN, ZOOM_MAX) });
                    } else if (mode === "perspective") {
                        patchGeometry({ perspective_v: clamp(g.perspective_v + perspectiveStep * count, -PERSPECTIVE_MAX, PERSPECTIVE_MAX) });
                    } else if (mode === "distortion") {
                        patchGeometry({ distortion: clamp(g.distortion + distortionStep * count, -DISTORTION_MAX, DISTORTION_MAX) });
                    } else if (canPan) {
                        patchGeometry({ crop_y: clamp(g.crop_y - panStep * count, -1, 1) });
                    }
                    return true;
                case Key.x:
                case Key.Zero:
                    patchGeometry({
                        straighten: 0,
                        zoom: 1,
                        crop_x: 0,
                        crop_y: 0,
                        distortion: 0,
                        perspective_v: 0,
                        perspective_h: 0,
                    });
                    return true;
                case Key.Enter:
                case Key.Escape:
                    e.origin.preventDefault();
                    useAppState.getState().setGeometryEdit(false);
                    keyboardManager.setActive(RegistrationID.adjustments);
                    return true;
                default:
                    return false;
            }
        }, false);
        return () => { keyboardManager.unregister(RegistrationID.geometry); };
    }, []);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!active || !geometry) return;
        dragRef.current = { x: e.clientX, y: e.clientY, g: geometry };
        (e.currentTarget as Element & { setPointerCapture?: (id: number) => void })
            .setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const w = frame?.width || e.currentTarget.clientWidth || 1;
        const h = frame?.height || e.currentTarget.clientHeight || 1;
        const fx = (e.clientX - drag.x) / w;
        const fy = (e.clientY - drag.y) / h;

        if (localRef.current.subMode === "rotate") {
            patchGeometry({
                straighten: clamp(drag.g.straighten + fx * 90, -STRAIGHTEN_MAX, STRAIGHTEN_MAX),
                zoom: clamp(drag.g.zoom + fy * 2, ZOOM_MIN, ZOOM_MAX),
            });
        } else if (localRef.current.subMode === "perspective") {
            patchGeometry({
                perspective_h: clamp(drag.g.perspective_h + fx * 100, -PERSPECTIVE_MAX, PERSPECTIVE_MAX),
                perspective_v: clamp(drag.g.perspective_v - fy * 100, -PERSPECTIVE_MAX, PERSPECTIVE_MAX),
            });
        } else if (localRef.current.subMode === "distortion") {
            patchGeometry({
                distortion: clamp(drag.g.distortion + (fx - fy) * 50, -DISTORTION_MAX, DISTORTION_MAX),
            });
        } else if (drag.g.zoom > 1.0 + 1e-6) {
            patchGeometry({
                crop_x: clamp(drag.g.crop_x - fx * 2, -1, 1),
                crop_y: clamp(drag.g.crop_y - fy * 2, -1, 1),
            });
        }
    };

    const onPointerUp = () => {
        dragRef.current = null;
    };

    if (!active || !geometry) return null;

    return (
        <div
            ref={overlayRef}
            className={s.overlay}
            data-testid="geometry-overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            {frame && (
                <>
                    <div
                        className={s.frame}
                        style={{ inset: "auto", left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
                    />
                    <div
                        className={s.grid}
                        style={{ inset: "auto", left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
                    />
                </>
            )}
            <div
                className={s.hud}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={s.modePills}>
                    <button
                        type="button"
                        className={`${s.modeBtn} ${subMode === "rotate" ? s.modeActive : ""}`}
                        onClick={() => setSubMode("rotate")}
                        aria-pressed={subMode === "rotate"}
                    >
                        ROTATE/ZOOM
                    </button>
                    <button
                        type="button"
                        className={`${s.modeBtn} ${subMode === "perspective" ? s.modeActive : ""}`}
                        onClick={() => setSubMode("perspective")}
                        aria-pressed={subMode === "perspective"}
                    >
                        PERSPECTIVE
                    </button>
                    <button
                        type="button"
                        className={`${s.modeBtn} ${subMode === "distortion" ? s.modeActive : ""}`}
                        onClick={() => setSubMode("distortion")}
                        aria-pressed={subMode === "distortion"}
                    >
                        DISTORTION
                    </button>
                    <button
                        type="button"
                        className={`${s.modeBtn} ${subMode === "position" ? s.modeActive : ""}`}
                        onClick={() => setSubMode("position")}
                        aria-pressed={subMode === "position"}
                    >
                        POSITION
                    </button>
                </div>
                <div className={s.hudValues}>
                    {subMode === "rotate" && (
                        <>
                            <span>{geometry.straighten.toFixed(1)}°</span>
                            <span>{geometry.zoom.toFixed(2)}×</span>
                        </>
                    )}
                    {subMode === "perspective" && (
                        <>
                            <span>V: {geometry.perspective_v > 0 ? `+${geometry.perspective_v.toFixed(0)}` : geometry.perspective_v.toFixed(0)}</span>
                            <span>H: {geometry.perspective_h > 0 ? `+${geometry.perspective_h.toFixed(0)}` : geometry.perspective_h.toFixed(0)}</span>
                        </>
                    )}
                    {subMode === "distortion" && (
                        <span>Distort: {geometry.distortion > 0 ? `+${geometry.distortion.toFixed(0)}` : geometry.distortion.toFixed(0)}</span>
                    )}
                    {subMode === "position" && (
                        <span>({geometry.crop_x.toFixed(2)}, {geometry.crop_y.toFixed(2)})</span>
                    )}
                </div>
                <div className={s.actions}>
                    <button
                        type="button"
                        className={s.actionBtn}
                        onClick={() => patchGeometry({
                            straighten: 0,
                            zoom: 1,
                            crop_x: 0,
                            crop_y: 0,
                            distortion: 0,
                            perspective_v: 0,
                            perspective_h: 0,
                        })}
                        title="Reset Geometry (0 or x)"
                    >
                        Reset
                    </button>
                    <button
                        type="button"
                        className={`${s.actionBtn} ${s.doneBtn}`}
                        onClick={() => {
                            useAppState.getState().setGeometryEdit(false);
                            keyboardManager.setActive(RegistrationID.adjustments);
                        }}
                        title="Done (Enter or Esc)"
                    >
                        Done
                    </button>
                </div>
            </div>
            <div className={s.hint}>
                {subMode === "position" && geometry.zoom <= 1
                    ? "Zoom in (k) to pan · Tab mode · x reset · Enter/Esc done"
                    : subMode === "perspective"
                    ? "Tab mode · h/l horiz · j/k vert · x reset · Enter/Esc done"
                    : subMode === "distortion"
                    ? "Tab mode · h/l distortion · x reset · Enter/Esc done"
                    : "Tab mode · h/l angle · j/k zoom · x reset · Enter/Esc done"}
            </div>
        </div>
    );
});
