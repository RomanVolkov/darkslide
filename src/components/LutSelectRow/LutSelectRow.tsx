import s from "./LutSelectRow.module.css";

/**
 * Clickable row in the adjustments sidebar for the current LUT selection.
 *
 * Styling and layout match Slider — border / padding / radius is applied by the
 * parent so the row shares the same focused-border treatment as other nav slots.
 *
 * Clicking the row (or pressing Space while it is the highlighted adjustments
 * row) opens the LUT search modal.
 */
export function LutSelectRow({
    selectedLutName,
    focused,
    onClick,
}: {
    selectedLutName: string | null;
    focused: boolean;
    onClick: () => void;
}) {
    return (
        <div
            className={s.lutSelectRow}
            data-focused={focused}
            onClick={onClick}
            style={{ cursor: "pointer" }}
        >
            {selectedLutName ?? "Select LUT…"}
        </div>
    );
}