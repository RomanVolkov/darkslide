import s from "./GeometryRow.module.css";

/**
 * Clickable row in the adjustments sidebar summarizing the crop/straighten
 * geometry. Clicking it (or pressing Enter while highlighted) enters geometry
 * edit mode.
 */
export function GeometryRow({
    straighten,
    zoom,
    cropX,
    cropY,
    distortion = 0,
    perspectiveV = 0,
    perspectiveH = 0,
    focused,
    onClick,
}: {
    straighten: number;
    zoom: number;
    cropX: number;
    cropY: number;
    distortion?: number;
    perspectiveV?: number;
    perspectiveH?: number;
    focused: boolean;
    onClick: () => void;
}) {
    const cropEdited = straighten !== 0 || zoom !== 1 || cropX !== 0 || cropY !== 0;
    const parts: string[] = [];
    if (cropEdited) {
        parts.push(`${straighten.toFixed(1)}°  ${zoom.toFixed(2)}×  (${cropX.toFixed(2)}, ${cropY.toFixed(2)})`);
    }
    if (distortion !== 0) parts.push(`Dist: ${distortion > 0 ? `+${distortion}` : distortion}`);
    if (perspectiveV !== 0) parts.push(`V: ${perspectiveV > 0 ? `+${perspectiveV}` : perspectiveV}`);
    if (perspectiveH !== 0) parts.push(`H: ${perspectiveH > 0 ? `+${perspectiveH}` : perspectiveH}`);

    const edited = parts.length > 0;
    return (
        <div
            className={s.row}
            data-focused={focused}
            data-row-type="geometry"
            onClick={onClick}
            style={{ cursor: "pointer" }}
        >
            {edited ? parts.join("  ") : "Crop & Straighten…"}
        </div>
    );
}
