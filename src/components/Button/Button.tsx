import type { ReactNode } from "react";
import s from "./Button.module.css";

export function Button({ children, focused, onClick }: {
    children: ReactNode;
    focused?: boolean;
    onClick?: () => void;
}) {
    return (
        <button
            className={`${s.btn}${focused ? ` ${s.btnFocused}` : ""}`}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
