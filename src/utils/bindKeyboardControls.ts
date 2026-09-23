interface BindKeyboardControlsOptions {
    target: Window;
    onKeyDown: (e: KeyboardEvent) => void;
    onKeyUp: (e: KeyboardEvent) => void;
    onBlur?: (e: FocusEvent) => void;
}

export function bindKeyboardControls({ target, onKeyDown, onKeyUp, onBlur }: BindKeyboardControlsOptions) {
    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    if (onBlur) {
        target.addEventListener("blur", onBlur);
    }
    const destroy = () => {
        target.removeEventListener("keydown", onKeyDown);
        target.removeEventListener("keyup", onKeyUp);
        if (onBlur) {
            target.removeEventListener("blur", onBlur);
        }
    }
    return destroy;
}