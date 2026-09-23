import s from "./Selection.module.css";

export function Selection<T extends string | number>({
    options,
    value,
    onChange,
    renderLabel,
    focused,
}: {
    options: readonly T[];
    value: T;
    onChange: (value: T) => void;
    renderLabel?: (value: T) => string;
    focused?: boolean;
}) {
    return (
        <div className={`${s.row}${focused ? ` ${s.rowFocused}` : ""}`}>
            {options.map((opt) => (
                <button
                    key={opt}
                    className={`${s.option}${value === opt ? ` ${s.optionActive}` : ""}`}
                    onClick={() => onChange(opt)}
                >
                    {renderLabel ? renderLabel(opt) : String(opt)}
                </button>
            ))}
        </div>
    );
}
