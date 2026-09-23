import { memo, useRef, useEffect, useState, useCallback } from "react";
import type { ColorBalance, ToneBalance } from "../../backend/types.ts";
import { keyboardManager, NormalizedKeyEvent, KeyboardEventType, RegistrationID } from "../../services/KeyboardManager.ts";
import { Key } from "../constants/index.ts";
import { useLatest } from "../../utils/utils.ts";
import { Slider } from "../Slider/Slider.tsx";
import s from "./ColorWheel.module.css";

export enum ColorBalanceTone {
    Shadows = "shadows",
    Midtones = "midtones",
    Highlights = "highlights",
}
export type ToneKey = ColorBalanceTone;

export enum ColorBalanceControl {
    Wheel = "wheel",
    Luminance = "luminance",
}

export const COLOR_BALANCE_STEPS = {
    HUE_NORMAL: 2,
    HUE_SHIFT: 15,
    SAT_NORMAL: 1,
    SAT_SHIFT: 10,
    LUM_NORMAL: 1,
    LUM_SHIFT: 10,
} as const;

export const COLOR_BALANCE_LIMITS = {
    LUM_MIN: -100,
    LUM_MAX: 100,
    LUM_DEFAULT: 0,
    SAT_MIN: 0,
    SAT_MAX: 100,
    SAT_DEFAULT: 0,
    HUE_DEFAULT: 0,
    HUE_CYCLE: 360,
    SNAP_RADIUS: 4,
} as const;

export const COLOR_WHEEL_CONFIG = {
    SIZE: 176,
    RADIUS: 176 / 2,
    MAX_COLOR_BYTE: 255,
} as const;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const THIRD_CIRCLE_RAD = (2 * Math.PI) / 3;
const TWO_THIRDS_CIRCLE_RAD = (4 * Math.PI) / 3;

const TONES: ToneKey[] = [
    ColorBalanceTone.Shadows,
    ColorBalanceTone.Midtones,
    ColorBalanceTone.Highlights,
];
const TONE_LABELS: Record<ToneKey, string> = {
    [ColorBalanceTone.Shadows]: "Shadows",
    [ColorBalanceTone.Midtones]: "Midtones",
    [ColorBalanceTone.Highlights]: "Highlights",
};

const DEFAULT_TONE: ToneBalance = {
    hue: COLOR_BALANCE_LIMITS.HUE_DEFAULT,
    saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT,
    luminance: COLOR_BALANCE_LIMITS.LUM_DEFAULT,
};

function drawWheel(ctx: CanvasRenderingContext2D, size: number) {
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
        const dy = cy - y; // Invert so positive y is up
        for (let x = 0; x < size; x++) {
            const dx = x - cx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const idx = (y * size + x) * 4;

            if (dist > radius) {
                data[idx + 3] = 0;
                continue;
            }

            const sat = dist / radius;
            let angle = Math.atan2(dy, dx);
            if (angle < 0) angle += 2 * Math.PI;

            // Math: dR = cos(θ), dG = cos(θ - 120°), dB = cos(θ - 240°)
            const dr = sat * Math.cos(angle);
            const dg = sat * Math.cos(angle - THIRD_CIRCLE_RAD);
            const db = sat * Math.cos(angle - TWO_THIRDS_CIRCLE_RAD);

            const r = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * dr) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));
            const g = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * dg) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));
            const b = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * db) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));

            // Anti-alias edge
            const alpha = dist > radius - 1 ? Math.round((radius - dist) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE) : COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE;

            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = alpha;
        }
    }

    ctx.putImageData(imgData, 0, 0);

    // Draw central neutral snap ring
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, COLOR_BALANCE_LIMITS.SNAP_RADIUS, 0, 2 * Math.PI);
    ctx.stroke();

    // Subtle outer border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 0.5, 0, 2 * Math.PI);
    ctx.stroke();
}

export interface ColorWheelProps {
    value: ColorBalance;
    onChange: (value: ColorBalance) => void;
    active: boolean;
    focused: boolean;
    onActivate?: () => void;
    onExit?: () => void;
}

export const ColorWheel = memo(({
    value,
    onChange,
    active,
    focused,
    onActivate,
    onExit,
}: ColorWheelProps) => {
    const [activeTone, setActiveTone] = useState<ToneKey>(ColorBalanceTone.Midtones);
    const [activeControl, setActiveControl] = useState<ColorBalanceControl>(ColorBalanceControl.Wheel);
    const [isWheelEditing, setIsWheelEditing] = useState<boolean>(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);

    const valueRef = useLatest(value);
    const activeToneRef = useLatest(activeTone);
    const activeControlRef = useLatest(activeControl);
    const isWheelEditingRef = useLatest(isWheelEditing);

    useEffect(() => {
        if (!active) {
            setIsWheelEditing(false);
            isWheelEditingRef.current = false;
        }
    }, [active]);

    const currentTone: ToneBalance = value[activeTone] ?? DEFAULT_TONE;

    const updateCurrentTone = useCallback((updater: (prev: ToneBalance) => ToneBalance) => {
        const curVal = valueRef.current;
        const curToneKey = activeToneRef.current;
        const curTone = curVal[curToneKey] ?? DEFAULT_TONE;
        const nextTone = updater(curTone);
        const nextVal = {
            ...curVal,
            [curToneKey]: nextTone,
        };
        valueRef.current = nextVal;
        onChange(nextVal);
    }, [onChange, valueRef, activeToneRef]);

    const resetCurrentTone = useCallback(() => {
        updateCurrentTone(() => ({ ...DEFAULT_TONE }));
    }, [updateCurrentTone]);

    const resetAllTones = useCallback(() => {
        const nextVal = {
            shadows: { ...DEFAULT_TONE },
            midtones: { ...DEFAULT_TONE },
            highlights: { ...DEFAULT_TONE },
        };
        valueRef.current = nextVal;
        onChange(nextVal);
    }, [onChange, valueRef]);

    // Pre-render wheel background
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        drawWheel(ctx, COLOR_WHEEL_CONFIG.SIZE);
    }, []);

    // Pointer event handling for 2D puck dragging
    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!wrapperRef.current) return;
        try {
            wrapperRef.current.setPointerCapture?.(e.pointerId);
        } catch {
            // Ignore in testing environments or if capture failed
        }
        isDraggingRef.current = true;
        activeControlRef.current = ColorBalanceControl.Wheel;
        setActiveControl(ColorBalanceControl.Wheel);
        isWheelEditingRef.current = true;
        setIsWheelEditing(true);
        if (!active && onActivate) {
            onActivate();
        }

        const rect = wrapperRef.current.getBoundingClientRect();
        const updateFromPos = (clientX: number, clientY: number) => {
            const dx = clientX - (rect.left + COLOR_WHEEL_CONFIG.RADIUS);
            const dy = rect.top + COLOR_WHEEL_CONFIG.RADIUS - clientY; // positive up
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= COLOR_BALANCE_LIMITS.SNAP_RADIUS) {
                updateCurrentTone((prev) => ({ ...prev, saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT }));
            } else {
                const sat = Math.min(
                    COLOR_BALANCE_LIMITS.SAT_MAX,
                    (dist / COLOR_WHEEL_CONFIG.RADIUS) * COLOR_BALANCE_LIMITS.SAT_MAX
                );
                let angle = Math.atan2(dy, dx) * RAD_TO_DEG;
                if (angle < 0) angle += COLOR_BALANCE_LIMITS.HUE_CYCLE;
                updateCurrentTone((prev) => ({
                    ...prev,
                    hue: Math.round(angle * 10) / 10,
                    saturation: Math.round(sat * 10) / 10,
                }));
            }
        };

        updateFromPos(e.clientX, e.clientY);

        const onPointerMove = (moveEv: PointerEvent) => {
            if (!isDraggingRef.current) return;
            updateFromPos(moveEv.clientX, moveEv.clientY);
        };

        const onPointerUp = (upEv: PointerEvent) => {
            isDraggingRef.current = false;
            try {
                wrapperRef.current?.releasePointerCapture(upEv.pointerId);
            } catch {
                // Ignore if capture was lost
            }
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
    };

    // Calculate puck position
    const puckRadius = (currentTone.saturation / COLOR_BALANCE_LIMITS.SAT_MAX) * COLOR_WHEEL_CONFIG.RADIUS;
    const puckAngleRad = currentTone.hue * DEG_TO_RAD;
    const puckX = COLOR_WHEEL_CONFIG.RADIUS + puckRadius * Math.cos(puckAngleRad);
    const puckY = COLOR_WHEEL_CONFIG.RADIUS - puckRadius * Math.sin(puckAngleRad);

    // Dynamic puck color
    const puckRad = currentTone.hue * DEG_TO_RAD;
    const normSat = currentTone.saturation / COLOR_BALANCE_LIMITS.SAT_MAX;
    const dr = normSat * Math.cos(puckRad);
    const dg = normSat * Math.cos(puckRad - THIRD_CIRCLE_RAD);
    const db = normSat * Math.cos(puckRad - TWO_THIRDS_CIRCLE_RAD);
    const puckR = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * dr) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));
    const puckG = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * dg) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));
    const puckB = Math.min(COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE, Math.max(0, Math.round((0.5 + 0.5 * db) * COLOR_WHEEL_CONFIG.MAX_COLOR_BYTE)));
    const puckColor = `rgb(${puckR}, ${puckG}, ${puckB})`;

    // State ref for keyboard handler
    const localRef = useLatest({
        activeTone,
        setActiveTone,
        activeControl,
        setActiveControl,
        isWheelEditing,
        setIsWheelEditing,
        currentTone,
        updateCurrentTone,
        resetCurrentTone,
        resetAllTones,
        onExit,
    });

    useEffect(() => {
        if (!active) {
            keyboardManager.unregister(RegistrationID.colorBalance);
            return;
        }

        keyboardManager.register(
            RegistrationID.colorBalance,
            (e: NormalizedKeyEvent) => {
                if (e.type !== KeyboardEventType.down) return false;
                const curActiveTone = activeToneRef.current;
                const curActiveControl = activeControlRef.current;
                const curIsWheelEditing = isWheelEditingRef.current;
                const {
                    setActiveTone: setTone,
                    setActiveControl: setControl,
                    setIsWheelEditing: setWheelEditing,
                    updateCurrentTone: updateTone,
                    resetAllTones: resetAll,
                    onExit: exit,
                } = localRef.current;

                const isShift =
                    e.shift ||
                    e.key === Key.H ||
                    e.key === Key.L ||
                    e.key === Key.J ||
                    e.key === Key.K ||
                    e.key === Key.X ||
                    Boolean(e.origin?.shiftKey);

                // Global reset all tones: Shift+X
                if (e.key === Key.X || (e.key === Key.x && isShift)) {
                    resetAll();
                    return true;
                }

                // Tone switching via 1, 2, 3 (works in both Layer 1 and Layer 2)
                if (e.key === Key.One) {
                    activeToneRef.current = ColorBalanceTone.Shadows;
                    setTone(ColorBalanceTone.Shadows);
                    return true;
                }
                if (e.key === Key.Two) {
                    activeToneRef.current = ColorBalanceTone.Midtones;
                    setTone(ColorBalanceTone.Midtones);
                    return true;
                }
                if (e.key === Key.Three) {
                    activeToneRef.current = ColorBalanceTone.Highlights;
                    setTone(ColorBalanceTone.Highlights);
                    return true;
                }

                // Tab / Shift+Tab cycles active tone categories (works in both Layer 1 and Layer 2)
                if (e.key === Key.Tab) {
                    const idx = TONES.indexOf(curActiveTone);
                    const nextIdx = e.shift
                        ? (idx - 1 + TONES.length) % TONES.length
                        : (idx + 1) % TONES.length;
                    const nextTone = TONES[nextIdx];
                    if (nextTone) {
                        activeToneRef.current = nextTone;
                        setTone(nextTone);
                    }
                    return true;
                }

                // LAYER 2: Inside the Color Wheel
                if (curIsWheelEditing) {
                    // Esc or Enter exits wheel editing back to Layer 1
                    if (e.key === Key.Escape || e.key === Key.Enter) {
                        isWheelEditingRef.current = false;
                        setWheelEditing(false);
                        return true;
                    }

                    // Hue adjustment: h / l or ArrowLeft / ArrowRight
                    if (e.key === Key.h || e.key === Key.H || e.key === Key.ArrowLeft || e.key === Key.Arrow_left) {
                        const step = isShift ? COLOR_BALANCE_STEPS.HUE_SHIFT : COLOR_BALANCE_STEPS.HUE_NORMAL * e.count;
                        updateTone((prev) => ({
                            ...prev,
                            hue: (prev.hue - step + COLOR_BALANCE_LIMITS.HUE_CYCLE) % COLOR_BALANCE_LIMITS.HUE_CYCLE,
                        }));
                        return true;
                    }
                    if (e.key === Key.l || e.key === Key.L || e.key === Key.ArrowRight || e.key === Key.Arrow_right) {
                        const step = isShift ? COLOR_BALANCE_STEPS.HUE_SHIFT : COLOR_BALANCE_STEPS.HUE_NORMAL * e.count;
                        updateTone((prev) => ({
                            ...prev,
                            hue: (prev.hue + step) % COLOR_BALANCE_LIMITS.HUE_CYCLE,
                        }));
                        return true;
                    }

                    // Saturation adjustment: j / k or ArrowDown / ArrowUp or [ / ] or - / + / =
                    if (
                        e.key === Key.j ||
                        e.key === Key.J ||
                        e.key === Key.ArrowDown ||
                        e.key === Key.Arrow_down ||
                        e.key === Key.BracketLeft ||
                        e.key === Key.Minus
                    ) {
                        const step = isShift ? COLOR_BALANCE_STEPS.SAT_SHIFT : COLOR_BALANCE_STEPS.SAT_NORMAL * e.count;
                        updateTone((prev) => ({
                            ...prev,
                            saturation: Math.max(COLOR_BALANCE_LIMITS.SAT_MIN, prev.saturation - step),
                        }));
                        return true;
                    }
                    if (
                        e.key === Key.k ||
                        e.key === Key.K ||
                        e.key === Key.ArrowUp ||
                        e.key === Key.Arrow_up ||
                        e.key === Key.BracketRight ||
                        e.key === Key.Plus ||
                        e.key === Key.Equal
                    ) {
                        const step = isShift ? COLOR_BALANCE_STEPS.SAT_SHIFT : COLOR_BALANCE_STEPS.SAT_NORMAL * e.count;
                        updateTone((prev) => ({
                            ...prev,
                            saturation: Math.min(COLOR_BALANCE_LIMITS.SAT_MAX, prev.saturation + step),
                        }));
                        return true;
                    }

                    // Reset active tone's wheel
                    if (e.key === Key.x && !isShift) {
                        updateTone((prev) => ({
                            ...prev,
                            hue: COLOR_BALANCE_LIMITS.HUE_DEFAULT,
                            saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT,
                        }));
                        return true;
                    }

                    return false;
                }

                // LAYER 1: Color Balance Section
                if (e.key === Key.Escape) {
                    exit?.();
                    return true;
                }

                // Enter on Wheel enters Layer 2
                if (e.key === Key.Enter) {
                    if (curActiveControl === ColorBalanceControl.Wheel) {
                        isWheelEditingRef.current = true;
                        setWheelEditing(true);
                        return true;
                    }
                    return false;
                }

                // Vertical focus navigation between controls: j / k or ArrowDown / ArrowUp
                if (e.key === Key.j || e.key === Key.J || e.key === Key.ArrowDown || e.key === Key.Arrow_down) {
                    if (curActiveControl === ColorBalanceControl.Wheel) {
                        activeControlRef.current = ColorBalanceControl.Luminance;
                        setControl(ColorBalanceControl.Luminance);
                        return true;
                    }
                    return false;
                }
                if (e.key === Key.k || e.key === Key.K || e.key === Key.ArrowUp || e.key === Key.Arrow_up) {
                    if (curActiveControl === ColorBalanceControl.Luminance) {
                        activeControlRef.current = ColorBalanceControl.Wheel;
                        setControl(ColorBalanceControl.Wheel);
                        return true;
                    }
                    return false;
                }

                // When on Luminance slider:
                if (curActiveControl === ColorBalanceControl.Luminance) {
                    const step = isShift ? COLOR_BALANCE_STEPS.LUM_SHIFT : COLOR_BALANCE_STEPS.LUM_NORMAL * e.count;
                    if (e.key === Key.h || e.key === Key.H || e.key === Key.ArrowLeft || e.key === Key.Arrow_left) {
                        updateTone((prev) => ({
                            ...prev,
                            luminance: Math.max(COLOR_BALANCE_LIMITS.LUM_MIN, prev.luminance - step),
                        }));
                        return true;
                    }
                    if (e.key === Key.l || e.key === Key.L || e.key === Key.ArrowRight || e.key === Key.Arrow_right) {
                        updateTone((prev) => ({
                            ...prev,
                            luminance: Math.min(COLOR_BALANCE_LIMITS.LUM_MAX, prev.luminance + step),
                        }));
                        return true;
                    }
                    if (e.key === Key.BracketLeft || e.key === Key.Minus) {
                        updateTone((prev) => ({
                            ...prev,
                            luminance: Math.max(COLOR_BALANCE_LIMITS.LUM_MIN, prev.luminance - step),
                        }));
                        return true;
                    }
                    if (e.key === Key.BracketRight || e.key === Key.Plus || e.key === Key.Equal) {
                        updateTone((prev) => ({
                            ...prev,
                            luminance: Math.min(COLOR_BALANCE_LIMITS.LUM_MAX, prev.luminance + step),
                        }));
                        return true;
                    }
                    if (e.key === Key.x && !isShift) {
                        updateTone((prev) => ({ ...prev, luminance: COLOR_BALANCE_LIMITS.LUM_DEFAULT }));
                        return true;
                    }
                }

                // When on Wheel in Layer 1:
                if (curActiveControl === ColorBalanceControl.Wheel) {
                    if (e.key === Key.x && !isShift) {
                        updateTone((prev) => ({
                            ...prev,
                            hue: COLOR_BALANCE_LIMITS.HUE_DEFAULT,
                            saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT,
                        }));
                        return true;
                    }
                }

                return false;
            },
            true
        );

        keyboardManager.setActive(RegistrationID.colorBalance);

        return () => {
            keyboardManager.unregister(RegistrationID.colorBalance);
        };
    }, [active, localRef]);

    return (
        <div
            className={`${s.container} ${focused ? s.containerFocused : ""}`}
            data-focused={focused}
            data-active={active}
            data-row-type="color_balance"
            onClick={() => {
                if (!active && onActivate) onActivate();
            }}
        >
            {/* Tone selector pills */}
            <div className={s.tabs} role="tablist">
                {TONES.map((toneKey) => {
                    const toneVal = value[toneKey];
                    const isEdited = (toneVal?.saturation ?? 0) !== 0 || (toneVal?.luminance ?? 0) !== 0;
                    const isSelected = activeTone === toneKey;

                    return (
                        <button
                            key={toneKey}
                            role="tab"
                            aria-selected={isSelected}
                            className={`${s.tab} ${isSelected ? s.tabActive : ""}`}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                setActiveTone(toneKey);
                                if (!active && onActivate) onActivate();
                            }}
                            onDoubleClick={(ev) => {
                                ev.stopPropagation();
                                updateCurrentTone(() => ({ ...DEFAULT_TONE }));
                            }}
                            {...({
                                onDblClick: (ev: any) => {
                                    ev.stopPropagation();
                                    updateCurrentTone(() => ({ ...DEFAULT_TONE }));
                                },
                            })}
                            title={`Select ${TONE_LABELS[toneKey]} (double-click to reset)`}
                        >
                            {TONE_LABELS[toneKey]}
                            {isEdited && <span className={s.editDot} data-testid={`dot-${toneKey}`} />}
                        </button>
                    );
                })}
            </div>

            {/* Circular color disc and puck */}
            <div
                ref={wrapperRef}
                className={`${s.wheelWrapper}${
                    active && activeControl === ColorBalanceControl.Wheel
                        ? isWheelEditing
                            ? ` ${s.wheelWrapperEditing}`
                            : ` ${s.wheelWrapperFocused}`
                        : ""
                }`}
                onPointerDown={handlePointerDown}
                onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    updateCurrentTone((prev) => ({ ...prev, saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT }));
                }}
                {...({
                    onDblClick: (ev: any) => {
                        ev.stopPropagation();
                        updateCurrentTone((prev) => ({ ...prev, saturation: COLOR_BALANCE_LIMITS.SAT_DEFAULT }));
                    },
                })}
                data-testid="color-wheel-disc"
                data-editing={active && activeControl === ColorBalanceControl.Wheel && isWheelEditing}
            >
                <canvas
                    ref={canvasRef}
                    width={COLOR_WHEEL_CONFIG.SIZE}
                    height={COLOR_WHEEL_CONFIG.SIZE}
                    className={s.wheelCanvas}
                />
                <div
                    className={s.puck}
                    data-testid="color-wheel-puck"
                    style={{
                        left: `${puckX}px`,
                        top: `${puckY}px`,
                        backgroundColor: puckColor,
                    }}
                />
            </div>

            {/* Luminance standard slider */}
            <div className={s.sliderWrapper}>
                <Slider
                    testId="color-wheel-luminance"
                    label="Luminance"
                    value={Math.round(currentTone.luminance)}
                    focused={active && !isWheelEditing && activeControl === ColorBalanceControl.Luminance}
                    min={COLOR_BALANCE_LIMITS.LUM_MIN}
                    max={COLOR_BALANCE_LIMITS.LUM_MAX}
                    step={COLOR_BALANCE_STEPS.LUM_NORMAL}
                    defaultValue={COLOR_BALANCE_LIMITS.LUM_DEFAULT}
                    format={(v) => (v > 0 ? `+${v}` : `${v}`)}
                    onChange={(lum) => {
                        updateCurrentTone((prev) => ({ ...prev, luminance: lum }));
                    }}
                    onInteract={() => {
                        isWheelEditingRef.current = false;
                        setIsWheelEditing(false);
                        activeControlRef.current = ColorBalanceControl.Luminance;
                        setActiveControl(ColorBalanceControl.Luminance);
                        if (!active && onActivate) onActivate();
                    }}
                    onReset={() => {
                        updateCurrentTone((prev) => ({ ...prev, luminance: COLOR_BALANCE_LIMITS.LUM_DEFAULT }));
                    }}
                />
            </div>

            {/* Readout */}
            <div className={s.readout} data-testid="color-wheel-readout">
                H: {Math.round(currentTone.hue)}°&nbsp;&nbsp;
                S: {Math.round(currentTone.saturation)}%&nbsp;&nbsp;
                L: {currentTone.luminance > 0 ? `+${Math.round(currentTone.luminance)}` : Math.round(currentTone.luminance)}
            </div>

            {active && (
                <div className={s.hint}>
                    {isWheelEditing
                        ? "Tab tone · h/l hue · j/k sat (⇧×10) · x reset · Esc done"
                        : activeControl === ColorBalanceControl.Wheel
                        ? "Tab tone · j lum · Enter edit wheel · x reset · Esc exit"
                        : "Tab tone · k wheel · h/l lum (⇧×10) · x reset · Esc exit"}
                </div>
            )}
        </div>
    );
});
