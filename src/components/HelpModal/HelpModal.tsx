import m from "../modal.module.css";
import s from "./HelpModal.module.css";
import { Key } from "../constants/index.ts"
import { useEffect } from "react";
import {
    NormalizedKeyEvent,
    KeyboardEventType,
    keyboardManager,
    RegistrationID,
} from "../../services/KeyboardManager";

import { getHelpSections, HelpSectionData } from "../../services/commandDefinitions.ts";

export function HelpModal({ onClose }: { onClose: () => void }) {
    const helpSections = getHelpSections();
    useEffect(() => {
        keyboardManager.register(RegistrationID.help, (e: NormalizedKeyEvent): boolean => {
            if (e.type != KeyboardEventType.down) return false;
            if (e.key === Key.Escape || e.key === Key.Question) {
                onClose();
            }
            return true;
        }, true);
        keyboardManager.setActive(RegistrationID.help);
        return () => { keyboardManager.unregister(RegistrationID.help) };
    }, []);

    const renderSection = (section: HelpSectionData) => (
        <div key={section.title} className={`${m.section} ${s.section}`}>
            <div className={m.groupTitle}>{section.title}</div>
            {section.entries.map((entry, i) => (
                <div key={i} className={m.entry}>
                    {entry.keys.map((k) => <kbd key={k}>{k}</kbd>)}
                    <span className={m.entryLabel}>{entry.label}</span>
                </div>
            ))}
        </div>
    );

    return (
        <div className={m.overlay} onClick={onClose}>
            <div className={m.modal} onClick={(e) => e.stopPropagation()}>
                <h1 className={m.title}>Help</h1>
                {/* CSS multi-column balances the two columns by rendered height,
                    so sections with wrapping labels don't leave one side long. */}
                <div className={s.columns}>{helpSections.map(renderSection)}</div>
                <div className={m.footer}>↑ ↓ ← → can be used instead of k j h l</div>
            </div>
        </div>
    );
}
