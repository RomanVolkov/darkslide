import { useState, useEffect } from "react";
import { Key } from "../constants/index.ts";
import m from "../modal.module.css";
import s from "./ExportModal.module.css";
import { Selection } from "../Selection/Selection.tsx";
import { Button } from "../Button/Button.tsx";
import { Slider } from "../Slider/Slider.tsx";
import type { ImageFormat, PngCompression } from "../types.ts";
import { IMAGE_FORMATS, PNG_COMPRESSIONS } from "../types.ts";
import { keyboardManager, NormalizedKeyEvent, KeyboardEventType, RegistrationID } from "../../services/KeyboardManager.ts";
import { debug } from "../../utils/debug.ts";
import { useLatest } from "../../utils/utils.ts";

const RowKey = {
    Format: 'format',
    Quality: 'quality',
    Compression: 'compression',
    Export: 'export',
} as const;
type RowKey = (typeof RowKey)[keyof typeof RowKey];

export class ExportRequestOptions {
    format: ImageFormat = "jpg"
    quality: number | null = null
    pngCompression: PngCompression | null = null
}

export function ExportModal({ onExport, onClose }: { onExport: (options: ExportRequestOptions) => void, onClose: () => void }) {
    const [format, setFormat] = useState<ImageFormat>("jpg");
    const [quality, setQuality] = useState(95);
    const [pngCompression, setPngCompression] = useState<PngCompression>("default");
    const [focusedRow, setFocusedRow] = useState(0);

    const visibleRows: { key: RowKey }[] = [{ key: RowKey.Format }];
    if (format === 'jpg') visibleRows.push({ key: RowKey.Quality });
    if (format === 'png') visibleRows.push({ key: RowKey.Compression });
    visibleRows.push({ key: RowKey.Export });

    const localStateRef = useLatest({
        format, quality, pngCompression, focusedRow, visibleRows
    });

    useEffect(() => {
        setFocusedRow(r => Math.min(r, visibleRows.length - 1));
    }, [visibleRows.length]);

    const focusedRowKey = visibleRows[focusedRow]?.key;

    function setFocusedRowByKey(key: RowKey) {
        const idx = visibleRows.findIndex(r => r.key === key);
        if (idx !== -1) setFocusedRow(idx);
    }

    useEffect(() => {
        keyboardManager.register(RegistrationID.export, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;
            debug.log("export" + e.key + " " + e.type + " ");
            const curKey = () => localStateRef.current.visibleRows[localStateRef.current.focusedRow]?.key;

            switch (e.key) {
                case Key.Escape:
                    onClose();
                    return true;
                case Key.j:
                    setFocusedRow((r) => Math.min(r + 1, localStateRef.current.visibleRows.length - 1));
                    return true;
                case Key.k:
                    setFocusedRow((r) => Math.max(r - 1, 0));
                    return true;
                case Key.h: {
                    const cur = curKey();
                    if (cur === RowKey.Format) {
                        const next = IMAGE_FORMATS[Math.max(0, IMAGE_FORMATS.indexOf(localStateRef.current.format) - 1)] ?? localStateRef.current.format;
                        setFormat(next);
                        if (next === "png") setPngCompression("default");
                    } else if (cur === RowKey.Quality)
                        setQuality((q) => Math.max(0, q - 1));
                    else if (cur === RowKey.Compression)
                        setPngCompression((c) => PNG_COMPRESSIONS[Math.max(0, PNG_COMPRESSIONS.indexOf(c) - 1)] ?? c);
                    return true;
                }
                case Key.h.toUpperCase(): {
                    if (curKey() === RowKey.Quality)
                        setQuality((q) => Math.max(0, q - 10));
                    return true;
                }
                case Key.l: {
                    const cur = curKey();
                    if (cur === RowKey.Format) {
                        const next = IMAGE_FORMATS[Math.min(IMAGE_FORMATS.length - 1, IMAGE_FORMATS.indexOf(localStateRef.current.format) + 1)] ?? localStateRef.current.format;
                        setFormat(next);
                        if (next === "png") setPngCompression("default");
                    } else if (cur === RowKey.Quality)
                        setQuality((q) => Math.min(100, q + 1));
                    else if (cur === RowKey.Compression)
                        setPngCompression((c) => PNG_COMPRESSIONS[Math.min(PNG_COMPRESSIONS.length - 1, PNG_COMPRESSIONS.indexOf(c) + 1)] ?? c);
                    return true;
                }
                case Key.l.toUpperCase(): {
                    if (curKey() === RowKey.Quality)
                        setQuality((q) => Math.min(100, q + 10));
                    return true;
                }
                case Key.Enter: {
                    if (e.shift || curKey() === RowKey.Export) {
                        onExport({
                            format: localStateRef.current.format,
                            pngCompression: localStateRef.current.pngCompression,
                            quality: localStateRef.current.quality
                        });
                        onClose();
                    }
                    return true;
                }
            }
            return false;
        }, true);

        return () => { keyboardManager.unregister(RegistrationID.export) };
    }, []);

    useEffect(() => {
        keyboardManager.setActive(RegistrationID.export);
    }, []);

    return (
        <div className={m.overlay} onClick={onClose}>
            <div className={m.modal} onClick={(e) => e.stopPropagation()}>
                <h1 className={m.title}>Export</h1>

                <div className={m.section} onClick={() => setFocusedRowByKey(RowKey.Format)}>
                    <div className={m.groupTitle}>Format</div>
                    <Selection
                        options={IMAGE_FORMATS}
                        value={format}
                        onChange={setFormat}
                        renderLabel={(f) => f.toUpperCase()}
                        focused={focusedRowKey === RowKey.Format}
                    />
                </div>

                {format === 'jpg' && (
                    <div className={m.section} onClick={() => setFocusedRowByKey(RowKey.Quality)}>
                        <Slider
                            label="Quality"
                            value={quality}
                            focused={focusedRowKey === RowKey.Quality}
                            onChange={setQuality}
                            min={0}
                            max={100}
                            step={1}
                            format={(v) => `${v}%`}
                        />
                    </div>
                )}

                {format === 'png' && (
                    <div className={m.section} onClick={() => setFocusedRowByKey(RowKey.Compression)}>
                        <div className={m.groupTitle}>Compression</div>
                        <Selection
                            options={PNG_COMPRESSIONS}
                            value={pngCompression}
                            onChange={setPngCompression}
                            renderLabel={(c) => c.charAt(0).toUpperCase() + c.slice(1)}
                            focused={focusedRowKey === RowKey.Compression}
                        />
                    </div>
                )}

                <div className={s.exportRow} onClick={() => setFocusedRowByKey(RowKey.Export)}>
                    <Button focused={focusedRowKey === RowKey.Export} onClick={() => {
                        onExport({
                            format: localStateRef.current.format,
                            pngCompression: localStateRef.current.pngCompression,
                            quality: localStateRef.current.quality
                        });
                        onClose();
                    }}>
                        Export
                    </Button>
                </div>
            </div>
        </div>
    );
}
