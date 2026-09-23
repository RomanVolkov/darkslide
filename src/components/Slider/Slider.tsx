import s from "./Slider.module.css";

export function Slider({
    label,
    value,
    focused,
    disabled,
    onChange,
    onInteract,
    onReset,
    trackGradient,
    min = -100,
    max = 100,
    step = 1,
    defaultValue = 0,
    format,
    testId,
}: {
    label: string;
    value: number;
    focused: boolean;
    disabled?: boolean;
    onChange: (v: number) => void;
    /** Called when the user interacts with the slider (focus / pointer down). */
    onInteract?: () => void;
    /** Called on double-click to reset. If not provided, calls onChange(defaultValue). */
    onReset?: () => void;
    trackGradient?: string;
    min?: number;
    max?: number;
    step?: number;
    defaultValue?: number;
    format?: (v: number) => string;
    testId?: string;
}) {
    const handleReset = () => {
        if (disabled) return;
        onInteract?.();
        if (onReset) {
            onReset();
        } else {
            onChange(defaultValue);
        }
    };

    return (
        <div
            className={`${s.sliderRow}${focused ? ` ${s.sliderRowFocused}` : ""}${disabled ? ` ${s.sliderRowDisabled}` : ""}`}
            data-focused={focused}
            data-row-type="slider"
            aria-disabled={disabled ? true : undefined}
            onDoubleClick={handleReset}
            {...({ onDblClick: handleReset })}
        >
            <div className={s.sliderHeader} title="Double-click to reset">
                <span className={`${s.sliderLabel}${disabled ? ` ${s.sliderLabelDisabled}` : ""}`}>{label}</span>
                <span className={s.sliderValue}>{format ? format(value) : value}</span>
            </div>
            <input
                type="range"
                data-testid={testId}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                style={trackGradient ? { background: trackGradient } : undefined}
                onPointerDown={onInteract}
                onFocus={onInteract}
                onDoubleClick={handleReset}
                {...({ onDblClick: handleReset })}
                onChange={(e) => {
                    if (disabled) return;
                    onInteract?.();
                    onChange(Number(e.currentTarget.value));
                }}
            />
        </div>
    );
}
