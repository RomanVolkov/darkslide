import s from "./Toast.module.css";
import { useAppState } from "../../state/appState";

export function Toast() {
    const message = useAppState(s => s.toastMessage);

    return (
        <div className={`${s.toast}${message ? ` ${s.toastVisible}` : ""}`}>
            {message}
        </div>
    )
}
