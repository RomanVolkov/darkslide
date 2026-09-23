import { describe, it, expect, vi, afterEach } from "vitest";
import { keyboardManager, RegistrationID } from "./KeyboardManager.ts";

function getCallArg(fn: ReturnType<typeof vi.fn>, index = 0): unknown {
    return fn.mock.calls[0]![index]!;
}

function makeKeydown(key: string, overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", { key, bubbles: true, ...overrides });
}

function makeInput() {
    const input = document.createElement("input");
    input.type = "text";
    return input;
}

describe("KeyboardManager previousActiveID", () => {
    afterEach(() => {
        try { keyboardManager.unregister(RegistrationID.lut); } catch {}
        try { keyboardManager.unregister(RegistrationID.adjustments); } catch {}
        try { keyboardManager.unregister(RegistrationID.filmstrip); } catch {}
        try { keyboardManager.unregister(RegistrationID.global); } catch {}
    });

    it("restores adjustments after lut unregisters", () => {
        const handler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.adjustments, handler);
        keyboardManager.setActive(RegistrationID.adjustments);

        const lutHandler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.lut, lutHandler);
        keyboardManager.setActive(RegistrationID.lut);

        keyboardManager.unregister(RegistrationID.lut);

        const evt = makeKeydown("j");
        keyboardManager.dispatch(evt);
        expect(handler).toHaveBeenCalled();
        expect((getCallArg(handler) as { key: string }).key).toBe("j");
    });

    it("falls back to global when previous registration no longer exists", () => {
        const globalHandler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.global, globalHandler);
        keyboardManager.setActive(RegistrationID.global);

        const lutHandler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.lut, lutHandler);
        keyboardManager.setActive(RegistrationID.lut);

        keyboardManager.unregister(RegistrationID.lut);

        const evt = makeKeydown("j");
        keyboardManager.dispatch(evt);
        expect(globalHandler).toHaveBeenCalled();
    });

    it("falls back to global when no previous was set", () => {
        const globalHandler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.global, globalHandler);
        keyboardManager.setActive(RegistrationID.global);

        const lutHandler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.lut, lutHandler);
        keyboardManager.setActive(RegistrationID.lut);

        keyboardManager.unregister(RegistrationID.lut);

        const evt = makeKeydown("j");
        keyboardManager.dispatch(evt);
        expect(globalHandler).toHaveBeenCalled();
    });
});

describe("KeyboardManager target-is-input digit passthrough", () => {
    afterEach(() => {
        try { keyboardManager.unregister(RegistrationID.lut); } catch {}
        try { keyboardManager.unregister(RegistrationID.adjustments); } catch {}
    });

    it("passes digit to handler when target is an input (not swallowed into count)", () => {
        const handler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.lut, handler, true);
        keyboardManager.setActive(RegistrationID.lut);

        const input = makeInput();
        const evt = new KeyboardEvent("keydown", { key: "5", bubbles: true });
        Object.defineProperty(evt, "target", { value: input, writable: false });
        keyboardManager.dispatch(evt);

        expect(handler).toHaveBeenCalled();
        expect((getCallArg(handler) as { key: string }).key).toBe("5");
        expect((getCallArg(handler) as { count: number }).count).toBe(1);
    });

    it("accumulates digits with count on non-input target", () => {
        const handler = vi.fn(() => false);
        keyboardManager.register(RegistrationID.adjustments, handler);
        keyboardManager.setActive(RegistrationID.adjustments);

        const body = document.createElement("div");
        const evt5 = new KeyboardEvent("keydown", { key: "5", bubbles: true });
        Object.defineProperty(evt5, "target", { value: body, writable: false });
        keyboardManager.dispatch(evt5);

        expect(handler).not.toHaveBeenCalled();

        const evtJ = new KeyboardEvent("keydown", { key: "j", bubbles: true });
        Object.defineProperty(evtJ, "target", { value: body, writable: false });
        keyboardManager.dispatch(evtJ);

        expect(handler).toHaveBeenCalled();
        expect((getCallArg(handler) as { key: string }).key).toBe("j");
        expect((getCallArg(handler) as { count: number }).count).toBe(5);
    });
});
