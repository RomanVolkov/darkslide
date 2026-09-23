import { useEffect, useState, Component, ErrorInfo, ReactNode, } from "react";
import { getBackend } from "./backend";
import "./App.css";
import s from "./App.module.css";
import { ImageProcessor } from "./services/ImageProcessor.ts";
import { AppEffects } from "./effects/AppEffects.tsx";
import { AppLayout } from "./components/AppLayout.tsx";

function AppInner() {
    const [imageProcessor, setImageProcessor] = useState<ImageProcessor | null>(null);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let alive = true;
        getBackend()
            .then(b => new ImageProcessor(b))
            .then(p => { if (alive) setImageProcessor(p); })
            .catch(e => { if (alive) setError(e); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!imageProcessor) return;
        // Double rAF ensures the layout has mounted, calculated dimensions, and completed first paint
        requestAnimationFrame(() => {
            requestAnimationFrame(async () => {
                try {
                    const { getCurrentWindow } = await import("@tauri-apps/api/window");
                    const win = getCurrentWindow();
                    await win.show();
                    await win.setFocus();
                } catch {
                    // Safe fallback in test or non-Tauri environments
                }
            });
        });
    }, [imageProcessor]);

    if (error) throw error;
    if (!imageProcessor) return <LoadingScreen />;

    return (
        <>
            <AppEffects processor={imageProcessor} />
            <AppLayout processor={imageProcessor} />
        </>
    );
}

export function LoadingScreen() {
    return (
        <div className={s.layout}>
            <div className={s.contentArea}>
                <div className={s.loadingScreen}>
                    <p className={s.loadingLabel}>Loading…</p>
                    <div className={s.loadingBarTrack}>
                        <div className={s.loadingBarFill} />
                    </div>
                </div>
            </div>
        </div>
    );
}

class ErrorBoundary extends Component<
    { children: ReactNode },
    { error: Error | null }
> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Darkslide fatal error", error, info);
        import("@tauri-apps/api/window")
            .then(({ getCurrentWindow }) => getCurrentWindow().show())
            .catch(() => {});
    }

    render() {
        if (this.state.error) {
            return (
                <div className={s.layout}>
                    <div className={s.contentArea}>
                        <div className={s.loadingScreen}>
                            <p className={s.loadingLabel}>Failed to start backend</p>
                            <p style={{ opacity: 0.6, fontFamily: "var(--mono)", marginTop: 12 }}>
                                {this.state.error.message}
                            </p>
                        </div>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function App() {
    return (
        <ErrorBoundary>
            <AppInner />
        </ErrorBoundary>
    );
}
