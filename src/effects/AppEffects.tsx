import { useEffect } from "react";
import { ImageProcessor } from "../services/ImageProcessor";
import { ImageRenderer } from "../services/ImageRenderer";
import { registerGlobalShortcuts } from "../services/globalShortcuts";
import { lutState } from "../state/lutState";
import { loadImages } from "../services/FileHandlers";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppState } from "../state/appState";
import { keyboardManager, RegistrationID } from "../services/KeyboardManager";
import { Panel } from "../components/constants";
import { bindKeyboardControls } from "../utils/bindKeyboardControls";
import { debug } from "../utils/debug";
import { initHistory } from "../services/undoHistory";
import { ActionService, CommandId } from "../services/ActionService";

export function AppEffects({ processor }: { processor: ImageProcessor }) {
    // wire keyboardManager with keyup and keydown events
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            keyboardManager.dispatch(e);
        };
        const onKeyUp = (e: KeyboardEvent) => {
            keyboardManager.dispatch(e);
        };
        const onBlur = () => {
            if (useAppState.getState().showOriginal) {
                ActionService.toggleOriginal(false);
            }
        };
        return bindKeyboardControls({ target: window, onKeyDown, onKeyUp, onBlur });
    }, []);

    // Geometry edit mode owns the keyboard while active: entering focuses the
    // adjustments panel, leaving restores the panel that was focused. This is
    // the single reactive source of truth so panel/filmstrip clicks can never
    // leave the overlay visible with the wrong keyboard registration.
    useEffect(() => {
        let prevGeometryEdit = useAppState.getState().geometryEdit;
        return useAppState.subscribe((state) => {
            if (state.geometryEdit === prevGeometryEdit) return;
            prevGeometryEdit = state.geometryEdit;

            if (state.geometryEdit) {
                state.setFocusPanel(Panel.Adjustments);
                keyboardManager.setActive(RegistrationID.geometry);
            } else {
                const panel = state.focusPanel === Panel.Filmstrip && state.images.length > 0
                    ? RegistrationID.filmstrip
                    : RegistrationID.adjustments;
                keyboardManager.setActive(panel);
            }
        });
    }, []);

    // Sync window title with active session name
    useEffect(() => {
        let prevTitle = "";
        const syncTitle = () => {
            const state = useAppState.getState();
            const activeSession = state.sessions.find(s => s.id === state.sessionId);
            const title = activeSession?.name ? `Darkslide - ${activeSession.name}` : "Darkslide";
            if (title === prevTitle) return;
            prevTitle = title;
            if (typeof document !== "undefined") {
                document.title = title;
            }
            try {
                import("@tauri-apps/api/window")
                    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
                    .catch(() => {});
            } catch {
                // Non-tauri environment
            }
        };

        syncTitle();
        return useAppState.subscribe(syncTitle);
    }, []);

    // start rendering, load luts and subscribe to cli open
    useEffect(() => {
        const renderer = new ImageRenderer(processor);
        renderer.start();

        const unregisterShortcuts = registerGlobalShortcuts(processor);
        keyboardManager.setActive(RegistrationID.global);

        const unregisterHistory = initHistory(useAppState);

        lutState.getState().loadItems()
            .then(() => debug.log("LUTs loaded"))
            .catch((error) => {
                debug.error(error);
                useAppState.getState().showToast("Failed to load LUTs");
            });

        let unlistenCli: (() => void) | undefined;
        let unlistenMenu: (() => void) | undefined;
        const setup = async () => {
            const store = useAppState;
            unlistenCli = await listen<string[]>("cli-open-files", (event) => {
                loadImages(event.payload, store, processor, true, true);
            });

            unlistenMenu = await listen<string>("menu-action", (event) => {
                const active = typeof document !== "undefined" ? document.activeElement : null;
                const isTextTarget = (active instanceof HTMLInputElement && active.type !== "range") ||
                    active instanceof HTMLTextAreaElement ||
                    (active instanceof HTMLElement && active.isContentEditable);
                if (isTextTarget) {
                    if (event.payload === CommandId.EditSelectAll) {
                        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
                            active.select();
                        }
                        return;
                    }
                    const textExempt = new Set<string>([
                        CommandId.FileOpen,
                        CommandId.FileOpenReplace,
                        CommandId.SessionPalette,
                        CommandId.FileExport,
                        CommandId.EditEraseDb,
                    ]);
                    if (!textExempt.has(event.payload)) {
                        return;
                    }
                }
                ActionService.execute(event.payload, processor);
            });

            const pending = await invoke<string[]>("get_pending_files", {});
            if (pending.length > 0) {
                loadImages(pending, store, processor, true, true);
            }

            const profiling =
                (typeof __PROFILING__ !== "undefined" && __PROFILING__) ||
                import.meta.env.VITE_PROFILING === "true";
            if (profiling) {
                const config = await invoke<{ shot: string; dir: string } | null>("screenshot_config", {}).catch(() => null);
                if (config) {
                    const { runScreenshotScenario } = await import("../services/screenshotScenario.ts");
                    runScreenshotScenario(config.shot, config.dir, store).catch((err) => {
                        debug.error("Screenshot scenario error", err);
                    });
                } else {
                    const isScenario = await invoke<boolean>("is_scenario_mode", {}).catch(() => false);
                    if (isScenario) {
                        const { runProfilingScenario } = await import("../services/scenarioRunner.ts");
                        runProfilingScenario(store).catch((err) => {
                            debug.error("Profiling scenario error", err);
                        });
                    }
                }
            }
        };
        setup().catch((error) => debug.error("CLI listener setup failed", error));

        return () => {
            renderer.dispose();
            unregisterShortcuts();
            unregisterHistory();
            unlistenCli?.();
            unlistenMenu?.();
        };
    }, [processor]);

    return null;
}
