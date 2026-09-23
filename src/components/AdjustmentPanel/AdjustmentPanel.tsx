import React, { memo, useRef, useEffect, useMemo, useState } from "react";
import type { AdjustmentKey } from "../../types/index.ts";
import { useLatest } from "../../utils/utils.ts";
import { ADJ_GET, ADJ_SET, DEFAULT_ADJUSTMENTS, normalizeAdjustments } from "../../types/adjustments.ts";
import { keyboardManager, NormalizedKeyEvent, KeyboardEventType, RegistrationID } from "../../services/KeyboardManager.ts";
import { Adjustments } from "../../backend/types.ts";
import { Key } from "../constants/index.ts";
import { Panel } from "../constants/index.ts";
import { SliderDirection, SliderStep } from "../../state/appState.ts";
import {
    SECTIONS,
    NAV_SLOTS,
    CURVE_NAV_INDEX,
    GEOMETRY_NAV_INDEX,
    AUTO_WB_NAV_INDEX,
    LUT_NAV_INDEX,
    COLOR_BALANCE_NAV_INDEX,
    SELECTIVE_COLOR_NAV_INDEX,
    SLIDER_LABELS,
    SLIDER_MIN,
    SLIDER_MAX,
    SLIDER_STEP,
    SLIDER_FORMAT,
    SLIDER_GRADIENTS,
} from "../Slider/sliderConfig.ts";
import { Slider } from "../Slider/Slider.tsx";
import { CurveEditor } from "../CurveEditor/CurveEditor.tsx";
import { ColorWheel } from "../ColorWheel/ColorWheel.tsx";
import { SelectiveColorPanel } from "../SelectiveColor/SelectiveColorPanel.tsx";
import { LutSelectRow } from "../LutSelectRow/LutSelectRow.tsx";
import { GeometryRow } from "../GeometryRow/GeometryRow.tsx";
import { LUTModal } from "../LUTModal/LUTModal.tsx";
import s from "./AdjustmentPanel.module.css";
import { useAppState } from "../../state/appState.ts";
import { lutState } from "../../state/lutState.ts";
import { applyAutoWhiteBalance } from "../../services/autoWhiteBalance.ts";
import { setActivePanel } from "../../services/PanelManager.ts";

export const AdjustmentPanel = memo(({ focused }: { focused: boolean }) => {
    const images = useAppState(s => s.images);
    const activeIndex = useAppState(s => s.activeIndex);
    const count = images.length;
    // Never lose the panel: fall back to the first image if activeIndex is
    // stale/out of range.
    const activeEntry = images[activeIndex] ?? images[0];
    const activeID = activeEntry?.id;
    const rawAdjustments = activeEntry?.adjustments ?? DEFAULT_ADJUSTMENTS;
    // Normalize so a legacy/partial adjustment object can never crash render.
    const adjustments = useMemo(() => normalizeAdjustments(rawAdjustments), [rawAdjustments]);
    const updateImage = useAppState(s => s.updateImage);
    const asideRef = useRef<HTMLElement>(null);

    // local state
    const [focusedEditingControlIndex, setFocusedEditingControlIndex] = useState(0);
    const [curvePointIndex, setCurvePointIndex] = useState(0);
    const [curveActive, setCurveActive] = useState(false);
    const [colorBalanceActive, setColorBalanceActive] = useState(false);
    const [selectiveColorActive, setSelectiveColorActive] = useState(false);

    const [showLut, setShowLut] = useState(false);

    const localStateRef = useLatest({
        focusedEditingControlIndex,
        curvePointIndex,
        curveActive,
        colorBalanceActive,
        selectiveColorActive,
        showLut,
    });

    // LUTs 
    const getLUTNameById = lutState(s => s.getNameBy);
    const deleteLUT = lutState(s => s.deleteItem);
    const importLut = lutState(s => s.importItem);
    const selectedLutName = getLUTNameById(adjustments.lut_id);
    const luts = lutState(s => s.items);
    const selectLUT = (id: number) => {
        const { activeIndex, images, updateImage } = useAppState.getState();
        const activeImage = images[activeIndex];
        if (!activeImage) return;
        const prevLutId = activeImage.adjustments.lut_id;
        const newAdj: Adjustments = prevLutId == null
            ? { ...activeImage.adjustments, lut_id: id, lut_intensity: 100 }
            : { ...activeImage.adjustments, lut_id: id };
        updateImage(activeImage.id, (img) => {
            img.adjustments = newAdj;
        });
    };
    const lutSliderDisabled = (key: AdjustmentKey | null) =>
        key === "lut_intensity" && !useAppState.getState().images[useAppState.getState().activeIndex]?.adjustments.lut_id;

    useEffect(() => {
        // exit Curve, Color Balance, and Selective Color editing when focus moved away from adjustments
        if (!focused) {
            setCurveActive(false);
            setColorBalanceActive(false);
            setSelectiveColorActive(false);
        }
    }, [focused]);

    const setAction = (key: AdjustmentKey) => (v: number) => {
        if (!activeID) return;
        updateImage(activeID, (img) => { img.adjustments = ADJ_SET[key](normalizeAdjustments(img.adjustments), v) });
    };

    const runAutoWhiteBalance = () => {
        const { images, activeIndex, showToast } = useAppState.getState();
        const img = images[activeIndex];
        if (!img) return;
        applyAutoWhiteBalance(img.id)
            .then(({ temperature, tint }) => {
                const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
                showToast(`Auto WB  temp ${fmt(temperature)}  tint ${fmt(tint)}`);
            })
            .catch(() => showToast("Auto WB failed"));
    };

    const enterGeometryMode = () => {
        setFocusedEditingControlIndex(GEOMETRY_NAV_INDEX);
        useAppState.getState().setGeometryEdit(true);
        keyboardManager.setActive(RegistrationID.geometry);
    };

    const activateCurve = () => {
        setFocusedEditingControlIndex(CURVE_NAV_INDEX);
        setCurveActive(true);
        setCurvePointIndex(0);
        keyboardManager.setActive(RegistrationID.curve);
    };

    const activateColorBalance = () => {
        setFocusedEditingControlIndex(COLOR_BALANCE_NAV_INDEX);
        setColorBalanceActive(true);
    };

    const deactivateColorBalance = () => {
        setColorBalanceActive(false);
        keyboardManager.setActive(RegistrationID.adjustments);
    };

    const activateSelectiveColor = () => {
        setFocusedEditingControlIndex(SELECTIVE_COLOR_NAV_INDEX);
        setSelectiveColorActive(true);
    };

    const deactivateSelectiveColor = () => {
        setSelectiveColorActive(false);
        keyboardManager.setActive(RegistrationID.adjustments);
    };

    useEffect(() => {
        const aside = asideRef.current;
        if (!aside) return;

        // First row: scroll all the way to the top so the "Light" header + padding are visible.
        if (focusedEditingControlIndex === 0) {
            aside.scrollTo({ top: 0, behavior: "smooth" });
            return;
        }

        // Last row (curve or last slider): scroll all the way to the bottom so the bottom padding is visible.
        if (focusedEditingControlIndex === NAV_SLOTS.length - 1) {
            aside.scrollTo({ top: aside.scrollHeight, behavior: "smooth" });
            return;
        }

        // Middle rows: if the focused element is the first in its section, scroll the h2
        // above it into view too so the section title is never clipped.
        const el = aside.querySelector('[data-focused="true"]') as HTMLElement | null;
        if (!el) return;
        const prev = el.previousElementSibling;
        const anchor = (prev instanceof HTMLElement && prev.tagName === "H2") ? prev : el;

        // Curve row is tall (CURVE_CANVAS_SIZE px canvas). Ensure the whole section fits by checking
        // whether the bottom of the curve row is within the sidebar viewport.
        if (el.dataset.rowType === "curve") {
            const sidebarRect = aside.getBoundingClientRect();
            const elBottom = el.getBoundingClientRect().bottom;
            if (elBottom > sidebarRect.bottom) {
                // Not fully visible — scroll h2 to the top so the canvas is shown below it.
                anchor.scrollIntoView({ behavior: "smooth", block: "start" });
                return;
            }
        }

        // LUT select row, Color Balance, Selective Color — scroll the focused element itself (not the h2 anchor) so the whole
        // row is guaranteed visible even when arriving from below.
        if (el.dataset.rowType === "lut" || el.dataset.rowType === "color_balance" || el.dataset.rowType === "selective_color") {
            el.scrollIntoView({ behavior: "smooth", block: "nearest" });
            return;
        }

        anchor.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, [focusedEditingControlIndex]);

    useEffect(() => {
        keyboardManager.register(RegistrationID.adjustments, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;

            function getActiveSliderKey(focusedEditingControlIndex: number): AdjustmentKey | null {
                const slot = NAV_SLOTS[focusedEditingControlIndex];
                if (
                    focusedEditingControlIndex === CURVE_NAV_INDEX ||
                    focusedEditingControlIndex === GEOMETRY_NAV_INDEX ||
                    focusedEditingControlIndex === AUTO_WB_NAV_INDEX ||
                    focusedEditingControlIndex === LUT_NAV_INDEX ||
                    focusedEditingControlIndex === COLOR_BALANCE_NAV_INDEX ||
                    focusedEditingControlIndex === SELECTIVE_COLOR_NAV_INDEX
                ) return null;
                return slot as AdjustmentKey;
            }
            const { adjustSlider } = useAppState.getState();
            const key = getActiveSliderKey(localStateRef.current.focusedEditingControlIndex);

            const TOTAL_ROWS = NAV_SLOTS.length;
            const count = e.count;
            switch (e.key) {
                case Key.j:
                    setFocusedEditingControlIndex(
                        (localStateRef.current.focusedEditingControlIndex + count) % TOTAL_ROWS
                    );
                    return true;
                case Key.k:
                    setFocusedEditingControlIndex(
                        ((localStateRef.current.focusedEditingControlIndex - count) % TOTAL_ROWS + TOTAL_ROWS) % TOTAL_ROWS
                    );
                    return true;
                case Key.Enter:
                    if (localStateRef.current.focusedEditingControlIndex === CURVE_NAV_INDEX) {
                        e.origin.preventDefault();
                        setCurveActive(true);
                        setCurvePointIndex(0);
                        keyboardManager.setActive(RegistrationID.curve);
                    } else if (localStateRef.current.focusedEditingControlIndex === LUT_NAV_INDEX) {
                        e.origin.preventDefault();
                        setShowLut(true);
                    } else if (localStateRef.current.focusedEditingControlIndex === GEOMETRY_NAV_INDEX) {
                        e.origin.preventDefault();
                        enterGeometryMode();
                    } else if (localStateRef.current.focusedEditingControlIndex === AUTO_WB_NAV_INDEX) {
                        e.origin.preventDefault();
                        runAutoWhiteBalance();
                    } else if (localStateRef.current.focusedEditingControlIndex === COLOR_BALANCE_NAV_INDEX) {
                        e.origin.preventDefault();
                        activateColorBalance();
                    } else if (localStateRef.current.focusedEditingControlIndex === SELECTIVE_COLOR_NAV_INDEX) {
                        e.origin.preventDefault();
                        activateSelectiveColor();
                    }
                    return true;
                case Key.l:
                    if (!key || lutSliderDisabled(key)) return false;
                    adjustSlider(key, SliderDirection.Increase, SliderStep.Normal, count);
                    return true;
                case Key.l.toUpperCase():
                    if (!key || lutSliderDisabled(key)) return false;
                    adjustSlider(key, SliderDirection.Increase, SliderStep.Big, count);
                    return true;
                case Key.h:
                    if (!key || lutSliderDisabled(key)) return false;
                    adjustSlider(key, SliderDirection.Decrease, SliderStep.Normal, count);
                    return true;
                case Key.h.toUpperCase():
                    if (!key || lutSliderDisabled(key)) return false;
                    adjustSlider(key, SliderDirection.Decrease, SliderStep.Big, count);
                    return true;
                case Key.x: {
                    if (localStateRef.current.focusedEditingControlIndex === GEOMETRY_NAV_INDEX) {
                        const { images, activeIndex, updateImage, showToast } = useAppState.getState();
                        const img = images[activeIndex];
                        if (img) {
                            updateImage(img.id, (entry) => {
                                entry.adjustments = { ...entry.adjustments, geometry: { ...DEFAULT_ADJUSTMENTS.geometry } };
                            });
                        }
                        showToast("Geometry reset");
                        return true;
                    }
                    if (localStateRef.current.focusedEditingControlIndex === LUT_NAV_INDEX) {
                        const store = useAppState.getState();
                        const img = store.images[store.activeIndex];
                        if (img) {
                            store.updateImage(img.id, (entry) => {
                                entry.adjustments = { ...entry.adjustments, lut_id: null, lut_intensity: 0 };
                            });
                        }
                        useAppState.getState().showToast("LUT cleared");
                        return true;
                    }
                    if (localStateRef.current.focusedEditingControlIndex === COLOR_BALANCE_NAV_INDEX) {
                        const { images, activeIndex, updateImage, showToast } = useAppState.getState();
                        const img = images[activeIndex];
                        if (img) {
                            updateImage(img.id, (entry) => {
                                entry.adjustments = {
                                    ...entry.adjustments,
                                    color_balance: {
                                        shadows: { hue: 0, saturation: 0, luminance: 0 },
                                        midtones: { hue: 0, saturation: 0, luminance: 0 },
                                        highlights: { hue: 0, saturation: 0, luminance: 0 },
                                    },
                                };
                            });
                        }
                        showToast("Color Balance reset");
                        return true;
                    }
                    if (localStateRef.current.focusedEditingControlIndex === SELECTIVE_COLOR_NAV_INDEX) {
                        const { images, activeIndex, updateImage, showToast } = useAppState.getState();
                        const img = images[activeIndex];
                        if (img) {
                            updateImage(img.id, (entry) => {
                                entry.adjustments = {
                                    ...entry.adjustments,
                                    selective_color: {
                                        red: { hue: 0, saturation: 0, luminance: 0 },
                                        orange: { hue: 0, saturation: 0, luminance: 0 },
                                        yellow: { hue: 0, saturation: 0, luminance: 0 },
                                        green: { hue: 0, saturation: 0, luminance: 0 },
                                        aqua: { hue: 0, saturation: 0, luminance: 0 },
                                        blue: { hue: 0, saturation: 0, luminance: 0 },
                                        purple: { hue: 0, saturation: 0, luminance: 0 },
                                        magenta: { hue: 0, saturation: 0, luminance: 0 },
                                    },
                                };
                            });
                        }
                        showToast("Selective Color reset");
                        return true;
                    }
                    if (!key || lutSliderDisabled(key)) return false;
                    useAppState.getState().showToast(`${SLIDER_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)} cleared`);
                    useAppState.getState().resetSlider(key);
                    return true;
                }
                case Key.x.toUpperCase(): {
                    useAppState.getState().showToast("reset all");
                    useAppState.getState().resetAdjustments();
                    return true;
                }
                case Key.y:
                case Key.c:
                case Key.C: {
                    if ((e.key === Key.c || e.key === Key.C) && !e.meta) return false;
                    useAppState.getState().yankAdjustments();
                    useAppState.getState().showToast("yanked");
                    return true;
                }
                case Key.p:
                case Key.v:
                case Key.V: {
                    if ((e.key === Key.v || e.key === Key.V) && !e.meta) return false;
                    const { selectedIds, pasteAdjustments, images, activeIndex, showToast } = useAppState.getState();
                    const targetIds = selectedIds.size > 0
                        ? selectedIds
                        : (images[activeIndex] ? new Set([images[activeIndex].id]) : new Set<string>());
                    if (targetIds.size > 0) {
                        pasteAdjustments(targetIds);
                        showToast(targetIds.size > 1 ? `pasted to ${targetIds.size} images` : "pasted");
                    }
                    return true;
                }
                case Key.w:
                    runAutoWhiteBalance();
                    return true;
                case Key.g: {
                    e.origin.preventDefault();
                    useAppState.getState().setGeometryEdit(true);
                    keyboardManager.setActive(RegistrationID.geometry);
                    return true;
                }
                default:
                    return false;
            }
        }, false);
        return () => {
            keyboardManager.unregister(RegistrationID.adjustments);
        }
    }, []);

    const curveFocused = focusedEditingControlIndex === CURVE_NAV_INDEX;
    const lutFocused = focusedEditingControlIndex === LUT_NAV_INDEX;
    const geometryFocused = focusedEditingControlIndex === GEOMETRY_NAV_INDEX;
    const autoWbFocused = focusedEditingControlIndex === AUTO_WB_NAV_INDEX;
    const colorBalanceFocused = focusedEditingControlIndex === COLOR_BALANCE_NAV_INDEX;
    const selectiveColorFocused = focusedEditingControlIndex === SELECTIVE_COLOR_NAV_INDEX;

    // Guard against partial/legacy adjustment objects so the panel can never
    // crash the whole app on a missing sub-object (normalizeAdjustments above
    // guarantees these exist).
    const curves = adjustments.curves;
    const geometry = adjustments.geometry;

    if (!activeID || count == 0)
        return null;

    return (
        <aside
            ref={asideRef}
            data-testid="adjustments-panel"
            className={`${s.sidebar}${focused || curveActive || colorBalanceActive || selectiveColorActive ? ` ${s.sidebarFocused}` : ""}`}
            onPointerDown={() => {
                const store = useAppState.getState();
                // Clicking the panel leaves geometry mode (the overlay owns the
                // image pane while active) and always routes the keyboard here.
                if (store.geometryEdit) store.setGeometryEdit(false);
                setActivePanel(Panel.Adjustments);
            }}
        >
            {SECTIONS.map((section) => (
                <React.Fragment key={section.label}>
                    <h2>{section.label}</h2>
                    {section.label === "LUT" && (
                        <div className={`${s.lutSelectRow}${lutFocused ? ` ${s.lutSelectRowFocused}` : ""}`}
                            data-focused={lutFocused}
                            data-row-type="lut">
                            <LutSelectRow
                                selectedLutName={selectedLutName}
                                focused={lutFocused}
                                onClick={() => !showLut && setShowLut(true)}
                            />
                        </div>
                    )}
                    {section.label === "Curve" ? (
                        <CurveEditor
                            curves={curves}
                            active={curveActive}
                            focused={curveFocused}
                            selectedPoint={curvePointIndex}
                            setSelectedPoint={setCurvePointIndex}
                            setCurveActive={setCurveActive}
                            onActivate={activateCurve}
                        />
                    ) : section.label === "Geometry" ? (
                        <div className={`${s.lutSelectRow}${geometryFocused ? ` ${s.lutSelectRowFocused}` : ""}`}
                            data-focused={geometryFocused}
                            data-row-type="geometry">
                            <GeometryRow
                                straighten={geometry.straighten}
                                zoom={geometry.zoom}
                                cropX={geometry.crop_x}
                                cropY={geometry.crop_y}
                                distortion={geometry.distortion}
                                perspectiveV={geometry.perspective_v}
                                perspectiveH={geometry.perspective_h}
                                focused={geometryFocused}
                                onClick={enterGeometryMode}
                            />
                        </div>
                    ) : section.label === "Color Balance" ? (
                        <ColorWheel
                            value={adjustments.color_balance}
                            active={colorBalanceActive}
                            focused={colorBalanceFocused}
                            onActivate={activateColorBalance}
                            onExit={deactivateColorBalance}
                            onChange={(next) => {
                                if (!activeID) return;
                                updateImage(activeID, (img) => {
                                    img.adjustments = { ...img.adjustments, color_balance: next };
                                });
                            }}
                        />
                    ) : section.label === "Selective Color" ? (
                        <SelectiveColorPanel
                            value={adjustments.selective_color}
                            active={selectiveColorActive}
                            focused={selectiveColorFocused}
                            onActivate={activateSelectiveColor}
                            onExit={deactivateSelectiveColor}
                            onChange={(next) => {
                                if (!activeID) return;
                                updateImage(activeID, (img) => {
                                    img.adjustments = { ...img.adjustments, selective_color: next };
                                });
                            }}
                        />
                    ) : (
                        <>
                            {section.keys.map((key) => {
                                const i = NAV_SLOTS.indexOf(key);
                                const isIntensity = key === "lut_intensity";
                                return (
                                    <Slider
                                        key={key}
                                        label={SLIDER_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)}
                                        value={ADJ_GET[key](adjustments)}
                                        focused={focusedEditingControlIndex === i}
                                        disabled={isIntensity && !adjustments.lut_id}
                                        onChange={setAction(key)}
                                        onInteract={() => setFocusedEditingControlIndex(i)}
                                        onReset={() => {
                                            setAction(key)(0);
                                            useAppState.getState().showToast(`${SLIDER_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)} cleared`);
                                        }}
                                        min={SLIDER_MIN[key] ?? -100}
                                        max={SLIDER_MAX[key] ?? 100}
                                        step={SLIDER_STEP[key] ?? 1}
                                        {...(SLIDER_FORMAT[key] ? { format: SLIDER_FORMAT[key] } : {})}
                                        {...(SLIDER_GRADIENTS[key] ? { trackGradient: SLIDER_GRADIENTS[key] } : {})}
                                    />
                                );
                            })}
                            {section.label === "Color" && (
                                <button
                                    type="button"
                                    className={`${s.autoWbButton}${autoWbFocused ? ` ${s.autoWbButtonFocused}` : ""}`}
                                    data-focused={autoWbFocused}
                                    onClick={() => {
                                        setFocusedEditingControlIndex(AUTO_WB_NAV_INDEX);
                                        runAutoWhiteBalance();
                                    }}
                                    title="Auto white balance (w)"
                                >
                                    Auto WB <kbd className={s.autoWbKey}>w</kbd>
                                </button>
                            )}
                        </>
                    )}
                </React.Fragment>
            ))}
            {showLut && (
                <LUTModal
                    luts={luts}
                    // take from app state
                    selectedId={adjustments.lut_id}
                    // write to app state -> refresh preview
                    onSelectLut={(id) => {
                        console.log("select lut", id);
                        selectLUT(id);
                        setShowLut(false);
                    }}
                    onDeleteLut={(id) => {
                        deleteLUT(id)
                            .then(() => useAppState.getState().showToast("LUT deleted"))
                            .catch(() => useAppState.getState().showToast("Delete failed"));
                    }}
                    onImportLut={(path) => {
                        importLut(path)
                            .then(() => useAppState.getState().showToast("LUT imported"))
                            .catch(() => useAppState.getState().showToast("Import failed"));
                    }}
                    onClose={() => setShowLut(false)}
                />
            )}
        </aside>
    );
});
