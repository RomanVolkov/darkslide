import { useAppState } from "../state/appState";
import { Panel } from "./constants/index.ts";
import { ImagePane } from "./ImagePane/ImagePane.tsx";
import { HistogramView } from "./Histogram/Histogram.tsx";
import { AdjustmentPanel } from "./AdjustmentPanel/AdjustmentPanel.tsx";
import { Filmstrip } from "./Filmstrip/Filmstrip.tsx";
import { HelpModal } from "./HelpModal/HelpModal.tsx";
import { ExportModal } from "./ExportModal/ExportModal.tsx";
import { EraseConfirmModal } from "./EraseConfirmModal/EraseConfirmModal.tsx";
import { SessionModal } from "./SessionModal/SessionModal.tsx";
import { Toast } from "./Toast/Toast.tsx";
import { Progress } from "./Progress/Progress.tsx";
import s from "../App.module.css";
import { ImageProcessor } from "../services/ImageProcessor.ts";
import { loadImages } from "../services/FileHandlers.ts";
import { ActionService } from "../services/ActionService.ts";

export function AppLayout({ processor }: { processor: ImageProcessor }) {
    const images = useAppState(s => s.images);
    const focusPanel = useAppState(s => s.focusPanel);
    const hasImages = useAppState(s => s.images.length > 0);
    const loadProgress = useAppState(s => s.loadProgress);
    const exportProgress = useAppState(s => s.exportProgress);
    const showOriginal = useAppState(s => s.showOriginal);
    const showExport = useAppState(s => s.showExport);
    const showKeymap = useAppState(s => s.showKeymap);
    const showEraseConfirm = useAppState(s => s.showEraseConfirm);
    const showSessions = useAppState(s => s.showSessions);
    const filmstripView = useAppState(s => s.filmstripView);
    const store = useAppState;

    const setShowKeymap = (v: boolean) => store.getState().setShowKeymap(v);
    const setShowExport = (v: boolean) => store.getState().setShowExport(v);
    const setShowEraseConfirm = (v: boolean) => store.getState().setShowEraseConfirm(v);

    return (
        <>
            <div className={s.mobileWall}>
                <div className={s.mobileWallCard}>
                    <span className={s.mobileWallDot} />
                    <h1 className={s.mobileWallTitle}>Darkslide</h1>
                    <p className={s.mobileWallMsg}>A desktop editing tool.</p>
                    <p className={s.mobileWallSub}>Open on a laptop or desktop browser.</p>
                </div>
            </div>
            <div className={s.layout}>
                <div className={`${s.contentArea}${!hasImages ? ` ${s.contentAreaEmpty}` : ""}`}>
                    <div className={s.imageArea}>
                        <ImagePane />

                        {showOriginal && filmstripView !== "grid" && (
                            <div className={s.originalBadge}>ORIGINAL</div>
                        )}

                        {loadProgress ? (
                            <div className={s.fileOpenOverlay}>
                                <div className={s.spinner} />
                            </div>
                        ) : images.length === 0 ? (
                            <div className={s.fileOpenOverlay}>
                                <div className={s.emptyActions}>
                                    <button
                                        className={s.emptyBtn}
                                        onClick={() => loadImages(null, store, processor, false, true)}
                                        data-testid="empty-open-images-btn"
                                    >
                                        <span>Open Images</span>
                                        <span className={s.kbdHint}>o</span>
                                    </button>
                                    <button
                                        className={s.emptyBtn}
                                        onClick={() => ActionService.openSessions()}
                                        data-testid="empty-open-sessions-btn"
                                    >
                                        <span>Sessions</span>
                                        <span className={s.kbdHint}>s</span>
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {
                            images.length > 0 && filmstripView !== "grid" ?
                                <HistogramView className={`${s.histogram} ${s.histogramTl}`} />
                                : null
                        }

                        <button
                            className={s.helpToggleBtn}
                            onClick={() => setShowKeymap(!showKeymap)}
                            aria-label="Toggle keyboard shortcuts"
                            data-testid="help-toggle-btn"
                        >
                            ?
                        </button>

                        <Toast />

                        {loadProgress && (
                            <Progress title="Loading..." progress={loadProgress} />
                        )}

                        {exportProgress && (
                            <Progress title="Exporting..." progress={exportProgress} />
                        )}

                    </div>

                    {hasImages && (
                        <Filmstrip
                            focused={focusPanel === Panel.Filmstrip}
                        />
                    )}
                </div>

                <AdjustmentPanel
                    focused={focusPanel === Panel.Adjustments}
                />
            </div>
            {showKeymap && <HelpModal onClose={() => setShowKeymap(false)} />}
            {showExport && <ExportModal onExport={
                (options) => {
                    store.getState().exportImages(
                        processor,
                        options.format,
                        options.quality,
                        options.pngCompression,
                        store.getState().showToast,
                    );
                    return true;
                }
            } onClose={() => setShowExport(false)} />}
            {showEraseConfirm && (
                <EraseConfirmModal
                    onClose={() => setShowEraseConfirm(false)}
                    onConfirm={() => {
                        setShowEraseConfirm(false);
                        store.getState().eraseAllAdjustments();
                    }}
                />
            )}
            {showSessions && (
                <SessionModal
                    processor={processor}
                    onClose={() => store.getState().setShowSessions(false)}
                />
            )}
        </>
    );
}
