import { describe, expect, it } from "vitest";
import { COMMAND_DEFINITIONS, SECTION_ORDER, getHelpSections } from "./commandDefinitions";

describe("CommandDefinitions consistency", () => {
    it("has unique IDs for every command", () => {
        const ids = new Set<string>();
        for (const cmd of COMMAND_DEFINITIONS) {
            expect(ids.has(cmd.id), `Duplicate command ID: ${cmd.id}`).toBe(false);
            ids.add(cmd.id);
        }
    });

    it("has valid non-empty labels and keys", () => {
        for (const cmd of COMMAND_DEFINITIONS) {
            expect(cmd.label.length, `Empty label for ${cmd.id}`).toBeGreaterThan(0);
            expect(cmd.helpLabel.length, `Empty helpLabel for ${cmd.id}`).toBeGreaterThan(0);
            expect(cmd.keys.length, `Empty keys for ${cmd.id}`).toBeGreaterThan(0);
            expect(SECTION_ORDER).toContain(cmd.helpSection);
        }
    });

    it("groups all help sections in expected canonical order", () => {
        const sections = getHelpSections();
        const titles = sections.map((s) => s.title);
        expect(titles).toEqual(SECTION_ORDER);

        // Every section has at least one entry
        for (const section of sections) {
            expect(section.entries.length, `Section ${section.title} is empty`).toBeGreaterThan(0);
        }
    });

    it("includes valid accelerators for menu commands", () => {
        const menuCmds = COMMAND_DEFINITIONS.filter((c) => c.accelerator !== undefined);
        expect(menuCmds.length).toBeGreaterThan(0);
        for (const cmd of menuCmds) {
            expect(cmd.accelerator).toMatch(/^(CmdOrCtrl|Backspace|Shift|Alt|[a-zA-Z]|Backslash)/);
        }
    });
});
