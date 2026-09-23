import { useEffect } from "react";
import m from "../modal.module.css";
import s from "./EraseConfirmModal.module.css";
import { Button } from "../Button/Button.tsx";
import { Key } from "../constants/index.ts";
import {
    NormalizedKeyEvent,
    KeyboardEventType,
    keyboardManager,
    RegistrationID,
} from "../../services/KeyboardManager.ts";

export function EraseConfirmModal({
    onConfirm,
    onClose,
}: {
    onConfirm: () => void;
    onClose: () => void;
}) {
    useEffect(() => {
        keyboardManager.register(
            RegistrationID.eraseConfirm,
            (e: NormalizedKeyEvent) => {
                if (e.type !== KeyboardEventType.down) return false;
                if (e.key === Key.o || e.key === Key.Enter) {
                    onConfirm();
                    return true;
                }
                if (e.key === Key.c || e.key === Key.Escape) {
                    onClose();
                    return true;
                }
                return true;
            },
            true
        );
        keyboardManager.setActive(RegistrationID.eraseConfirm);
        return () => {
            keyboardManager.unregister(RegistrationID.eraseConfirm);
        };
    }, [onConfirm, onClose]);

    return (
        <div className={m.overlay} onClick={onClose}>
            <div
                className={m.modal}
                onClick={(e) => e.stopPropagation()}
                style={{ minWidth: 460, maxWidth: 520 }}
            >
                <h1 className={m.title}>Erase All Adjustments</h1>
                <div className={s.confirmStrip}>
                    <span className={s.confirmPrompt}>
                        Erase all adjustments from database?
                    </span>
                    <span className={s.confirmHint}>O=OK C=Cancel</span>
                </div>
                <div className={s.actions}>
                    <Button onClick={onClose}>Cancel (C)</Button>
                    <Button onClick={onConfirm}>Erase (O)</Button>
                </div>
            </div>
        </div>
    );
}
