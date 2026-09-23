import { useState, useCallback, useEffect, useMemo } from "preact/hooks";
import { memo } from "preact/compat";
import { Slider } from "../Slider/Slider";
import type { SelectiveColor, SelectiveChannel } from "../../backend/types.ts";
import { keyboardManager, RegistrationID, KeyboardEventType, type NormalizedKeyEvent } from "../../services/KeyboardManager.ts";
import { Key } from "../constants/index.ts";
import { useLatest } from "../../utils/utils.ts";
import s from "./SelectiveColorPanel.module.css";

export enum SelectiveColorChannelKey {
    Red = "red",
    Orange = "orange",
    Yellow = "yellow",
    Green = "green",
    Aqua = "aqua",
    Blue = "blue",
    Purple = "purple",
    Magenta = "magenta",
}
export type SelectiveChannelKey = SelectiveColorChannelKey;

export enum SelectiveColorSliderField {
    Hue = "hue",
    Saturation = "saturation",
    Luminance = "luminance",
}
export type SliderField = SelectiveColorSliderField;

export const SELECTIVE_COLOR_STEPS = {
    NORMAL: 1,
    SHIFT: 10,
} as const;

export const SELECTIVE_COLOR_LIMITS = {
    MIN: -100,
    MAX: 100,
    DEFAULT: 0,
} as const;

export const SELECTIVE_COLOR_GRADIENT = {
    HUE_SPREAD: 30,
    HUE_CYCLE: 360,
    SAT_MIN_PCT: 10,
    SAT_MID_PCT: 55,
    SAT_MAX_PCT: 100,
    LUM_MIN_PCT: 20,
    LUM_MID_PCT: 50,
    LUM_MAX_PCT: 80,
} as const;

export interface ChannelInfo {
    key: SelectiveChannelKey;
    label: string;
    centerHue: number;
    color: string;
    shortcut: string;
}

export const CHANNELS: ChannelInfo[] = [
    { key: SelectiveColorChannelKey.Red, label: "Red", centerHue: 0, color: "hsl(0, 85%, 55%)", shortcut: Key.One },
    { key: SelectiveColorChannelKey.Orange, label: "Orange", centerHue: 30, color: "hsl(30, 95%, 55%)", shortcut: Key.Two },
    { key: SelectiveColorChannelKey.Yellow, label: "Yellow", centerHue: 60, color: "hsl(60, 90%, 50%)", shortcut: Key.Three },
    { key: SelectiveColorChannelKey.Green, label: "Green", centerHue: 120, color: "hsl(120, 70%, 45%)", shortcut: Key.Four },
    { key: SelectiveColorChannelKey.Aqua, label: "Aqua", centerHue: 180, color: "hsl(180, 80%, 45%)", shortcut: Key.Five },
    { key: SelectiveColorChannelKey.Blue, label: "Blue", centerHue: 240, color: "hsl(240, 80%, 60%)", shortcut: Key.Six },
    { key: SelectiveColorChannelKey.Purple, label: "Purple", centerHue: 280, color: "hsl(280, 80%, 60%)", shortcut: Key.Seven },
    { key: SelectiveColorChannelKey.Magenta, label: "Magenta", centerHue: 320, color: "hsl(320, 80%, 55%)", shortcut: Key.Eight },
];

export const SLIDER_FIELDS: readonly SliderField[] = [
    SelectiveColorSliderField.Hue,
    SelectiveColorSliderField.Saturation,
    SelectiveColorSliderField.Luminance,
] as const;

const CHANNEL_KEY_MAP: Record<string, SelectiveColorChannelKey> = {
    [Key.One]: SelectiveColorChannelKey.Red,
    [Key.Two]: SelectiveColorChannelKey.Orange,
    [Key.Three]: SelectiveColorChannelKey.Yellow,
    [Key.Four]: SelectiveColorChannelKey.Green,
    [Key.Five]: SelectiveColorChannelKey.Aqua,
    [Key.Six]: SelectiveColorChannelKey.Blue,
    [Key.Seven]: SelectiveColorChannelKey.Purple,
    [Key.Eight]: SelectiveColorChannelKey.Magenta,
};

const DEFAULT_CHANNEL: SelectiveChannel = {
    hue: SELECTIVE_COLOR_LIMITS.DEFAULT,
    saturation: SELECTIVE_COLOR_LIMITS.DEFAULT,
    luminance: SELECTIVE_COLOR_LIMITS.DEFAULT,
};

export interface SelectiveColorPanelProps {
    value: SelectiveColor;
    onChange: (value: SelectiveColor) => void;
    active: boolean;
    focused: boolean;
    onActivate?: () => void;
    onExit?: () => void;
}

export const SelectiveColorPanel = memo(({
    value,
    onChange,
    active,
    focused,
    onActivate,
    onExit,
}: SelectiveColorPanelProps) => {
    const [activeChannelKey, setActiveChannelKey] = useState<SelectiveChannelKey>(SelectiveColorChannelKey.Red);
    const [activeSlider, setActiveSlider] = useState<SliderField>(SelectiveColorSliderField.Hue);

    const activeChannelMeta = useMemo(
        () => CHANNELS.find((c) => c.key === activeChannelKey) ?? CHANNELS[0]!,
        [activeChannelKey]
    );

    const valueRef = useLatest(value);
    const activeChannelKeyRef = useLatest(activeChannelKey);
    const activeSliderRef = useLatest(activeSlider);

    const currentChannel = value[activeChannelKey] ?? DEFAULT_CHANNEL;

    const updateCurrentChannelField = useCallback(
        (field: SliderField, fieldValue: number) => {
            const clamped = Math.max(
                SELECTIVE_COLOR_LIMITS.MIN,
                Math.min(SELECTIVE_COLOR_LIMITS.MAX, Math.round(fieldValue))
            );
            const curVal = valueRef.current;
            const curKey = activeChannelKeyRef.current;
            const curChan = curVal[curKey] ?? DEFAULT_CHANNEL;
            const updatedChannel: SelectiveChannel = {
                ...curChan,
                [field]: clamped,
            };
            const nextVal = {
                ...curVal,
                [curKey]: updatedChannel,
            };
            valueRef.current = nextVal;
            onChange(nextVal);
        },
        [onChange, valueRef, activeChannelKeyRef]
    );

    const resetCurrentChannel = useCallback(() => {
        const curVal = valueRef.current;
        const curKey = activeChannelKeyRef.current;
        const nextVal = {
            ...curVal,
            [curKey]: { ...DEFAULT_CHANNEL },
        };
        valueRef.current = nextVal;
        onChange(nextVal);
    }, [onChange, valueRef, activeChannelKeyRef]);

    const resetAllChannels = useCallback(() => {
        const nextVal: SelectiveColor = {
            [SelectiveColorChannelKey.Red]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Orange]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Yellow]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Green]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Aqua]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Blue]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Purple]: { ...DEFAULT_CHANNEL },
            [SelectiveColorChannelKey.Magenta]: { ...DEFAULT_CHANNEL },
        };
        valueRef.current = nextVal;
        onChange(nextVal);
    }, [onChange, valueRef]);

    // Gradient tracks calculated based on canonical center hue of the active channel
    const centerHue = activeChannelMeta.centerHue;
    const hueTrack = useMemo(() => {
        const leftHue =
            (centerHue - SELECTIVE_COLOR_GRADIENT.HUE_SPREAD + SELECTIVE_COLOR_GRADIENT.HUE_CYCLE) %
            SELECTIVE_COLOR_GRADIENT.HUE_CYCLE;
        const rightHue = (centerHue + SELECTIVE_COLOR_GRADIENT.HUE_SPREAD) % SELECTIVE_COLOR_GRADIENT.HUE_CYCLE;
        return `linear-gradient(to right, hsl(${leftHue}, 80%, 50%), hsl(${centerHue}, 80%, 50%), hsl(${rightHue}, 80%, 50%))`;
    }, [centerHue]);

    const satTrack = useMemo(() => {
        return `linear-gradient(to right, hsl(${centerHue}, ${SELECTIVE_COLOR_GRADIENT.SAT_MIN_PCT}%, 50%), hsl(${centerHue}, ${SELECTIVE_COLOR_GRADIENT.SAT_MID_PCT}%, 50%), hsl(${centerHue}, ${SELECTIVE_COLOR_GRADIENT.SAT_MAX_PCT}%))`;
    }, [centerHue]);

    const lumTrack = useMemo(() => {
        return `linear-gradient(to right, hsl(${centerHue}, 70%, ${SELECTIVE_COLOR_GRADIENT.LUM_MIN_PCT}%), hsl(${centerHue}, 70%, ${SELECTIVE_COLOR_GRADIENT.LUM_MID_PCT}%), hsl(${centerHue}, 70%, ${SELECTIVE_COLOR_GRADIENT.LUM_MAX_PCT}%))`;
    }, [centerHue]);

    // Format helpers for +/- values
    const formatValue = (v: number) => (v > 0 ? `+${v}` : `${v}`);

    // Ref for keyboard handler
    const localRef = useLatest({
        activeChannelKey,
        setActiveChannelKey,
        activeSlider,
        setActiveSlider,
        currentChannel,
        updateCurrentChannelField,
        resetCurrentChannel,
        resetAllChannels,
        onExit,
    });

    useEffect(() => {
        if (!active) {
            keyboardManager.unregister(RegistrationID.selectiveColor);
            return;
        }

        keyboardManager.register(
            RegistrationID.selectiveColor,
            (e: NormalizedKeyEvent) => {
                if (e.type !== KeyboardEventType.down) return false;
                const curKey = activeChannelKeyRef.current;
                const curSlider = activeSliderRef.current;
                const {
                    setActiveChannelKey: setChannel,
                    setActiveSlider: setSlider,
                    currentChannel: curChannel,
                    updateCurrentChannelField: updateField,
                    resetCurrentChannel: resetChannel,
                    resetAllChannels: resetAll,
                    onExit: exit,
                } = localRef.current;

                if (e.key === Key.Escape || e.key === Key.Enter) {
                    exit?.();
                    return true;
                }

                // Digits 1-8 select channel directly
                const targetChannel = CHANNEL_KEY_MAP[e.key];
                if (targetChannel) {
                    activeChannelKeyRef.current = targetChannel;
                    setChannel(targetChannel);
                    return true;
                }

                // [ / ] cycle channel left/right
                if (e.key === Key.BracketLeft) {
                    const curIdx = CHANNELS.findIndex((c) => c.key === curKey);
                    const prevIdx = (curIdx - 1 + CHANNELS.length) % CHANNELS.length;
                    const target = CHANNELS[prevIdx];
                    if (target) {
                        activeChannelKeyRef.current = target.key;
                        setChannel(target.key);
                    }
                    return true;
                }
                if (e.key === Key.BracketRight) {
                    const curIdx = CHANNELS.findIndex((c) => c.key === curKey);
                    const nextIdx = (curIdx + 1) % CHANNELS.length;
                    const target = CHANNELS[nextIdx];
                    if (target) {
                        activeChannelKeyRef.current = target.key;
                        setChannel(target.key);
                    }
                    return true;
                }

                // Tab / Shift+Tab cycles active color channel
                if (e.key === Key.Tab) {
                    const curIdx = CHANNELS.findIndex((c) => c.key === curKey);
                    const nextIdx = e.shift
                        ? (curIdx - 1 + CHANNELS.length) % CHANNELS.length
                        : (curIdx + 1) % CHANNELS.length;
                    const target = CHANNELS[nextIdx];
                    if (target) {
                        activeChannelKeyRef.current = target.key;
                        setChannel(target.key);
                    }
                    return true;
                }

                // j / k / ArrowDown / ArrowUp moves slider focus down / up
                if (
                    e.key === Key.j ||
                    e.key === Key.J ||
                    e.key === Key.ArrowDown ||
                    e.key === Key.Arrow_down
                ) {
                    const curIdx = SLIDER_FIELDS.indexOf(curSlider);
                    const nextIdx = (curIdx + 1) % SLIDER_FIELDS.length;
                    const nextField = SLIDER_FIELDS[nextIdx];
                    if (nextField) {
                        activeSliderRef.current = nextField;
                        setSlider(nextField);
                    }
                    return true;
                }
                if (
                    e.key === Key.k ||
                    e.key === Key.K ||
                    e.key === Key.ArrowUp ||
                    e.key === Key.Arrow_up
                ) {
                    const curIdx = SLIDER_FIELDS.indexOf(curSlider);
                    const prevIdx = (curIdx - 1 + SLIDER_FIELDS.length) % SLIDER_FIELDS.length;
                    const prevField = SLIDER_FIELDS[prevIdx];
                    if (prevField) {
                        activeSliderRef.current = prevField;
                        setSlider(prevField);
                    }
                    return true;
                }

                const isShift =
                    e.shift ||
                    e.key === Key.H ||
                    e.key === Key.L ||
                    e.key === Key.J ||
                    e.key === Key.K ||
                    e.key === Key.X ||
                    Boolean(e.origin?.shiftKey);
                const step = isShift ? SELECTIVE_COLOR_STEPS.SHIFT : SELECTIVE_COLOR_STEPS.NORMAL * e.count;

                // h / l / ArrowLeft / ArrowRight / Minus / Plus / Equal adjusts currently active slider
                if (
                    e.key === Key.h ||
                    e.key === Key.H ||
                    e.key === Key.ArrowLeft ||
                    e.key === Key.Arrow_left ||
                    e.key === Key.Minus
                ) {
                    const val = curChannel[curSlider] ?? SELECTIVE_COLOR_LIMITS.DEFAULT;
                    updateField(curSlider, val - step);
                    return true;
                }
                if (
                    e.key === Key.l ||
                    e.key === Key.L ||
                    e.key === Key.ArrowRight ||
                    e.key === Key.Arrow_right ||
                    e.key === Key.Plus ||
                    e.key === Key.Equal
                ) {
                    const val = curChannel[curSlider] ?? SELECTIVE_COLOR_LIMITS.DEFAULT;
                    updateField(curSlider, val + step);
                    return true;
                }

                // Reset: x for active channel, Shift+X for all channels
                if (e.key === Key.X || (e.key === Key.x && isShift)) {
                    resetAll();
                    return true;
                }
                if (e.key === Key.x && !isShift) {
                    resetChannel();
                    return true;
                }

                return false;
            }
        );

        keyboardManager.setActive(RegistrationID.selectiveColor);

        return () => {
            keyboardManager.unregister(RegistrationID.selectiveColor);
        };
    }, [active, localRef]);

    const isChannelEdited = (key: SelectiveChannelKey) => {
        const ch = value[key];
        if (!ch) return false;
        return (
            ch.hue !== SELECTIVE_COLOR_LIMITS.DEFAULT ||
            ch.saturation !== SELECTIVE_COLOR_LIMITS.DEFAULT ||
            ch.luminance !== SELECTIVE_COLOR_LIMITS.DEFAULT
        );
    };

    return (
        <div
            className={`${s.container}${focused ? ` ${s.containerFocused}` : ""}${active ? ` ${s.containerActive}` : ""}`}
            data-testid="selective-color-panel"
            data-focused={focused}
            data-active={active}
            data-row-type="selective_color"
            tabIndex={0}
        >
            {/* 8-chip swatch bar */}
            <div className={s.swatchBar} data-testid="selective-swatch-bar">
                {CHANNELS.map((ch) => {
                    const isSelected = ch.key === activeChannelKey;
                    const edited = isChannelEdited(ch.key);
                    const handleChipReset = () => {
                        onActivate?.();
                        onChange({
                            ...value,
                            [ch.key]: { ...DEFAULT_CHANNEL },
                        });
                    };

                    return (
                        <button
                            key={ch.key}
                            type="button"
                            className={`${s.swatchChip}${isSelected ? ` ${s.swatchChipSelected}` : ""}`}
                            style={{ backgroundColor: ch.color }}
                            title={`${ch.label} (${ch.shortcut}) - Double click to reset`}
                            data-testid={`swatch-${ch.key}`}
                            data-selected={isSelected}
                            data-edited={edited}
                            onClick={() => {
                                onActivate?.();
                                setActiveChannelKey(ch.key);
                            }}
                            onDoubleClick={handleChipReset}
                            {...({ onDblClick: handleChipReset })}
                        >
                            {isSelected && <span className={s.activeDot} data-testid={`active-dot-${ch.key}`} />}
                            {edited && <span className={s.editDot} data-testid={`edit-dot-${ch.key}`} />}
                        </button>
                    );
                })}
            </div>

            {/* Header displaying active channel */}
            <div className={s.headerRow}>
                <span className={s.channelTitle} data-testid="active-channel-label">
                    {activeChannelMeta.label}
                </span>
            </div>

            {/* 3 dedicated sliders */}
            <div className={s.slidersList}>
                <Slider
                    label="Hue"
                    value={currentChannel.hue}
                    focused={active && activeSlider === SelectiveColorSliderField.Hue}
                    trackGradient={hueTrack}
                    min={SELECTIVE_COLOR_LIMITS.MIN}
                    max={SELECTIVE_COLOR_LIMITS.MAX}
                    step={SELECTIVE_COLOR_STEPS.NORMAL}
                    defaultValue={SELECTIVE_COLOR_LIMITS.DEFAULT}
                    format={formatValue}
                    onChange={(v) => updateCurrentChannelField(SelectiveColorSliderField.Hue, v)}
                    onInteract={() => {
                        setActiveSlider(SelectiveColorSliderField.Hue);
                        onActivate?.();
                    }}
                    onReset={() => updateCurrentChannelField(SelectiveColorSliderField.Hue, SELECTIVE_COLOR_LIMITS.DEFAULT)}
                />
                <Slider
                    label="Saturation"
                    value={currentChannel.saturation}
                    focused={active && activeSlider === SelectiveColorSliderField.Saturation}
                    trackGradient={satTrack}
                    min={SELECTIVE_COLOR_LIMITS.MIN}
                    max={SELECTIVE_COLOR_LIMITS.MAX}
                    step={SELECTIVE_COLOR_STEPS.NORMAL}
                    defaultValue={SELECTIVE_COLOR_LIMITS.DEFAULT}
                    format={formatValue}
                    onChange={(v) => updateCurrentChannelField(SelectiveColorSliderField.Saturation, v)}
                    onInteract={() => {
                        setActiveSlider(SelectiveColorSliderField.Saturation);
                        onActivate?.();
                    }}
                    onReset={() => updateCurrentChannelField(SelectiveColorSliderField.Saturation, SELECTIVE_COLOR_LIMITS.DEFAULT)}
                />
                <Slider
                    label="Luminance"
                    value={currentChannel.luminance}
                    focused={active && activeSlider === SelectiveColorSliderField.Luminance}
                    trackGradient={lumTrack}
                    min={SELECTIVE_COLOR_LIMITS.MIN}
                    max={SELECTIVE_COLOR_LIMITS.MAX}
                    step={SELECTIVE_COLOR_STEPS.NORMAL}
                    defaultValue={SELECTIVE_COLOR_LIMITS.DEFAULT}
                    format={formatValue}
                    onChange={(v) => updateCurrentChannelField(SelectiveColorSliderField.Luminance, v)}
                    onInteract={() => {
                        setActiveSlider(SelectiveColorSliderField.Luminance);
                        onActivate?.();
                    }}
                    onReset={() => updateCurrentChannelField(SelectiveColorSliderField.Luminance, SELECTIVE_COLOR_LIMITS.DEFAULT)}
                />
            </div>

            {/* Hint at bottom of the active group */}
            {active && (
                <div className={s.hint}>
                    Tab color · j/k slider · h/l adjust (⇧×10) · x reset · Esc
                </div>
            )}
        </div>
    );
});
