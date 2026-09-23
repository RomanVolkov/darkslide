import { getBackend } from "../backend/index.ts";
import { useAppState } from "../state/appState.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";

/**
 * Estimate the auto white balance for an image and write the resulting relative
 * temperature/tint offsets into its adjustments (which triggers a re-render via
 * the standard store subscription).
 */
export async function applyAutoWhiteBalance(
    imageId: string,
): Promise<{ temperature: number; tint: number }> {
    const image = useAppState.getState().images.find((img) => img.id === imageId);
    const backend = await getBackend();
    const { temperature, tint } = await backend.autoWhiteBalance(
        imageId,
        image?.adjustments ?? DEFAULT_ADJUSTMENTS,
    );

    useAppState.getState().updateImage(imageId, (img) => {
        img.adjustments = {
            ...img.adjustments,
            color: { ...img.adjustments.color, temperature, tint },
        };
    });

    return { temperature, tint };
}
