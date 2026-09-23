/**
 * Screenshot scenario — dev/profiling-only.
 *
 * Drives the app into a deterministic, presentable state for marketing
 * screenshots, then announces readiness by setting the window title to
 * `shot-ready:<id>`. It never exits the app; the external capture tool watches
 * the title, screenshots the window, and crops detail views.
 *
 * Enabled only when the frontend is built with `VITE_PROFILING=true` and
 * `VITE_SCREENSHOT=<shot-id>` (inlined by Vite). Stripped from production.
 *
 * Shots: `full-editor` (default), `color-balance`, `selective-color`,
 * `geometry`, `sessions`, `batch`.
 */

import type { Adjustments, Curves } from "../backend/types.ts";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments.ts";
import { useAppState } from "../state/appState.ts";
import { keyboardManager, RegistrationID } from "./KeyboardManager.ts";
import { Panel } from "../components/constants/index.ts";
import { lutState, LutItem } from "../state/lutState.ts";
import { invoke } from "@tauri-apps/api/core";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until images are loaded and the first preview has rendered. */
async function waitForImages(store: typeof useAppState, maxWaitMs = 60_000): Promise<boolean> {
    const start = performance.now();
    while (performance.now() - start < maxWaitMs) {
        const state = store.getState();
        if (state.images.length > 0 && state.loadProgress === null && state.renderedImageId) {
            return true;
        }
        await delay(50);
    }
    return false;
}

/** A tasteful, moderately-edited look so screenshots never show a flat image. */
export function curatedLook(base: Adjustments, variant: number): Adjustments {
    const wobble = (value: number, amp: number) => value + ((variant % 3) - 1) * amp;
    const curves: Curves = {
        rgb: [
            { x: 0, y: 0 },
            { x: 64, y: 54 },
            { x: 192, y: 204 },
            { x: 255, y: 255 },
        ],
        red: [
            { x: 0, y: 0 },
            { x: 255, y: 253 },
        ],
        green: [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
        ],
        blue: [
            { x: 0, y: 4 },
            { x: 255, y: 255 },
        ],
    };
    const selectiveColor = base.selective_color ?? DEFAULT_ADJUSTMENTS.selective_color;
    return {
        ...base,
        light: {
            exposure: wobble(0.22, 0.06),
            contrast: 12,
            highlights: -16,
            shadows: 18,
            whites: 6,
            blacks: -5,
            brightness: 2,
        },
        color: { temperature: wobble(8, 3), tint: 3 },
        hsl: { hue: 0, saturation: 6, vibrance: 14 },
        detail: {
            ...base.detail,
            texture: 8,
            clarity: 8,
            sharpen: { amount: 25, radius: 1 },
            grain: { amount: 0, size: 0, roughness: 0 },
            denoise: { strength: 0, preserve: 0 },
        },
        curves,
        rotation: 0,
        geometry: { straighten: 0, zoom: 1, crop_x: 0, crop_y: 0, distortion: 0, perspective_v: 0, perspective_h: 0 },
        color_balance: {
            shadows: { hue: 215, saturation: 10, luminance: -4 },
            midtones: { hue: 0, saturation: 0, luminance: 0 },
            highlights: { hue: 45, saturation: 8, luminance: 4 },
        },
        selective_color: selectiveColor,
        lut_id: null,
        lut_intensity: 0,
    };
}

/** Dispatch a sequence of keydown events through the app's keyboard manager. */
async function press(tokens: string[]): Promise<void> {
    for (const key of tokens) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await delay(60);
    }
}

function focusAdjustments(store: typeof useAppState): void {
    store.getState().setFocusPanel(Panel.Adjustments);
    keyboardManager.setActive(RegistrationID.adjustments);
}

/** Seed a few sessions so the sessions palette looks populated. */
function seedSessions(store: typeof useAppState): void {
    store.getState().setSessions([
        { id: 1, name: "Iceland 2026", image_count: 24, updated_at: "2026-09-20T10:00:00Z" },
        { id: 2, name: "Tokyo Street", image_count: 18, updated_at: "2026-09-18T10:00:00Z" },
        { id: 3, name: "Studio Portraits", image_count: 12, updated_at: "2026-09-15T10:00:00Z" },
    ]);
}

/** Set the native + document title so the capture tool can observe progress. */
async function markTitle(text: string): Promise<void> {
    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(text);
    } catch {
        // Non-Tauri environment.
    }
    document.title = text;
}

/** Seed a few LUTs so the LUT palette looks populated. */
function seedLuts(): void {
    lutState.setState({
        items: [
            new LutItem(1, "M31 - Rec709"),
            new LutItem(2, "Kodak 2383"),
            new LutItem(3, "Fuji Eterna 500T"),
            new LutItem(4, "Teal & Orange"),
            new LutItem(5, "Ilford HP5"),
        ],
    });
}

export async function runScreenshotScenario(shot: string, dir: string, store: typeof useAppState = useAppState): Promise<void> {
    await markTitle(`shot-init:${shot}`);

    try {
        const ready = await waitForImages(store);
        if (!ready) {
            await markTitle("shot-fail:no-images");
            return;
        }

        // Curated edits on the first images so the hero and filmstrip look graded.
        const images = store.getState().images;
        images.slice(0, Math.min(images.length, 12)).forEach((img, i) => {
            store.getState().updateImage(img.id, (entry) => {
                entry.adjustments = curatedLook(entry.adjustments, i);
            });
        });

        store.getState().setFilmstripView("strip");
        store.getState().setActiveImage(0);

        switch (shot) {
            case "color-balance":
                focusAdjustments(store);
                await press(["1", "4", "j", "Enter"]);
                break;
            case "selective-color":
                focusAdjustments(store);
                await press(["1", "5", "j", "Enter"]);
                break;
            case "geometry": {
                const first = store.getState().images[0];
                if (first) {
                    store.getState().updateImage(first.id, (entry) => {
                        entry.adjustments = {
                            ...entry.adjustments,
                            geometry: { ...entry.adjustments.geometry, straighten: 2, perspective_v: 4 },
                        };
                    });
                }
                store.getState().setGeometryEdit(true);
                break;
            }
            case "sessions":
                store.getState().setShowSessions(true);
                // The modal refetches sessions on mount (empty in scenario mode);
                // seed after that so the palette shows a populated list.
                await delay(800);
                seedSessions(store);
                break;
            case "batch":
                store.getState().selectAll();
                store.getState().setFocusPanel(Panel.Filmstrip);
                store.getState().showToast(`pasted to ${store.getState().images.length} images`);
                break;
            case "export":
                store.getState().selectAll();
                store.getState().setShowExport(true);
                break;
            case "filmstrip":
                store.getState().setFilmstripView("grid");
                break;
            case "help":
                store.getState().setShowKeymap(true);
                break;
            case "lut":
                seedLuts();
                focusAdjustments(store);
                // Navigate to the LUT row (slot 25) and open the palette.
                await press(["2", "5", "j", "Enter"]);
                await delay(500);
                break;
            default:
                focusAdjustments(store);
                break;
        }

        // Let adjustments render, then snapshot the webview to a PNG.
        await delay(1600);
        // The help reference is taller than the default window; give it room
        // while keeping the 16:10 aspect ratio used by every shot.
        const [width, height] = shot === "help" ? [2080, 1300] : [1440, 900];
        await invoke("capture_webview", { path: `${dir}/${shot}.png`, width, height });
        await markTitle(`shot-ready:${shot}`);
    } catch (err) {
        await markTitle(`shot-fail:${err instanceof Error ? err.message : String(err)}`);
    }
}
