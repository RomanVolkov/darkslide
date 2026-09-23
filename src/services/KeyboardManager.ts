import { Key } from "../components/constants/index.ts";
import { SUPPRESSED_DEFAULT_KEYS } from "../components/constants/index.ts";
import { debug } from "../utils/debug.ts";

export enum KeyboardEventType {
    up = "keyup",
    down = "keydown",
    unsupported = "unsupported",
}

export interface NormalizedKeyEvent {
    origin: KeyboardEvent;
    type: KeyboardEventType,
    key: string;
    count: number;
    shift: boolean;
    meta: boolean;
    alt: boolean;
}


// return true when the event got handled by handler
export type KeyHandler = (e: NormalizedKeyEvent) => boolean;

class Registration {
    handler: KeyHandler | null = null;
    override_global: boolean = false;
}

export enum RegistrationID {
    global = "global",
    export = "export",
    help = "help",
    adjustments = "adjustments",
    filmstrip = "filmstrip",
    curve = "curve",
    colorBalance = "colorBalance",
    selectiveColor = "selectiveColor",
    geometry = "geometry",
    lut = "lut",
    eraseConfirm = "eraseConfirm",
    session = "session",
}

let _countStr = "";
let _activeID: RegistrationID | null = null;
let _previousActiveID: RegistrationID | null = null;

let _registrations: Map<RegistrationID, Registration> = new Map();

function processCount(): number {
    const n = _countStr == "" ? 1 : parseInt(_countStr, 10);
    _countStr = "";
    return n;
}

function normalizeKey(e: KeyboardEvent): string {
    switch (e.key) {
        case Key.Arrow_up: return e.shiftKey ? Key.k.toUpperCase() : Key.k;
        case Key.Arrow_down: return e.shiftKey ? Key.j.toUpperCase() : Key.j;
        case Key.Arrow_left: return e.shiftKey ? Key.h.toUpperCase() : Key.h;
        case Key.Arrow_right: return e.shiftKey ? Key.l.toUpperCase() : Key.l;
        default: return e.key;
    }
}

function register(id: RegistrationID, handler: KeyHandler, override_global: boolean = false) {
    debug.log("keyboardManager::register: " + id);

    let existing = _registrations.get(id);
    if (existing) {
        existing.handler = handler;
        existing.override_global = override_global;
        return;
    }
    _registrations.set(id, { handler: handler, override_global: override_global });
}

function unregister(id: RegistrationID) {
    debug.log("keyboardManager::unregister: " + id);
    _registrations.delete(id);
    if (_activeID === id) {
        if (_previousActiveID && _registrations.has(_previousActiveID)) {
            _activeID = _previousActiveID;
        } else {
            _activeID = RegistrationID.global;
        }
        _previousActiveID = null;
    }
}

function setActive(id: RegistrationID) {
    debug.log("keyboardManager::setActive: " + id);
    let existing = _registrations.get(id);
    if (existing) {
        if (_activeID !== id) {
            _previousActiveID = _activeID;
        }
        _activeID = id;
    } else {
        debug.error("trying to set active " + id + ", but it is not registered");
    }
}

function dispatch(e: KeyboardEvent) {
    const activeIDAtDispatch = _activeID;

    const isTextTarget = (e.target instanceof HTMLInputElement && e.target.type !== "range") ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);

    const isCmdA = (e.metaKey || e.ctrlKey) && (e.key === Key.a || e.key === Key.A);

    // Suppress browser-default behaviours that are never desired app-wide.
    // Applied at this single chokepoint so it covers handled, unhandled, and
    // not-yet-registered paths alike.
    //
    // - Tab: focus-traversal — repurposed for panel cycling / modal mode
    //   toggling. Suppress even inside text inputs (no native caret-move use
    //   case here).
    // - Space / Enter: would activate a mouse-focused native control (button,
    //   range, checkbox). Gated by !isTextTarget so typing in the LUTModal
    //   search input is unaffected.
    // - Cmd+A / Ctrl+A: would trigger WebKit's full-document selection highlight.
    //   Gated by !isTextTarget so text inputs preserve native text selection.
    // - F1 / F5 / F11: help / reload / fullscreen — would dump in-memory
    //   state or fight the window manager.
    // - PageUp / PageDown / Home / End: page/scroll-container scroll —
    //   panels are fixed; the app drives its own navigation.
    if (e.type === "keydown") {
        if (e.key === Key.Tab || SUPPRESSED_DEFAULT_KEYS.has(e.key)) {
            e.preventDefault();
        } else if (!isTextTarget && (e.key === Key.Space || e.key === Key.Enter || isCmdA)) {
            e.preventDefault();
        }
    }

    const digitsAsDirectKeys = _activeID === RegistrationID.colorBalance || _activeID === RegistrationID.selectiveColor;

    if (e.type === "keydown" && !isTextTarget && !digitsAsDirectKeys) {
        if (e.key >= Key.One && e.key <= Key.Nine) {
            _countStr += e.key;
            return;
        }
        if (e.key === Key.Zero && _countStr !== "") {
            _countStr += Key.Zero;
            return;
        }
    }

    let keyEventType: KeyboardEventType = KeyboardEventType.unsupported;
    switch (e.type) {
        case "keyup": keyEventType = KeyboardEventType.up; break;
        case "keydown": keyEventType = KeyboardEventType.down; break;
    }

    const value: NormalizedKeyEvent = {
        origin: e,
        type: keyEventType,
        key: normalizeKey(e),
        count: e.type === "keydown" ? processCount() : 1,
        shift: e.shiftKey,
        meta: e.metaKey || e.ctrlKey,
        alt: e.altKey,
    }

    debug.log("_handlers.count: " + _registrations.size);

    if (!activeIDAtDispatch) {
        debug.error("missing _activeID");
        return;
    }

    let activeRegistration = _registrations.get(activeIDAtDispatch);
    if (!activeRegistration) {
        debug.error("missing active registration for: " + _activeID);
        return;
    }
    let activeHandler = activeRegistration.handler;
    if (!activeHandler) {
        debug.error("missing active handler for: " + _activeID);
        return;
    }

    let handle_result = activeHandler(value);
    if (!handle_result && !activeRegistration.override_global) {
        handle_result = _registrations.get(RegistrationID.global)?.handler?.(value) ?? false;
    }

    // Suppress the browser's native scrolling / slider adjustment for arrow
    // keys only when a handler actually consumed the event. Otherwise a
    // focused native input (e.g. <input type="range">) keeps its default
    // behaviour.
    if (e.key.startsWith("Arrow") && handle_result) {
        e.preventDefault();
    }
}

export const keyboardManager = {
    register,
    unregister,
    setActive,
    dispatch,
    /** The registration currently receiving keyboard input (for tests/debug). */
    getActive: (): RegistrationID | null => _activeID,
};
