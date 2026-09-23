import { describe, it, expect, vi, beforeEach } from "vitest";
import { pickLutFile } from "./LutImporter.ts";

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";

describe("pickLutFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns the path string when a file is picked", async () => {
        const mockPath = "/Users/test/my-lut.cube";
        vi.mocked(open).mockResolvedValue(mockPath);
        const result = await pickLutFile();
        expect(result).toBe(mockPath);
    });

    it("returns null when the user cancels (null result)", async () => {
        vi.mocked(open).mockResolvedValue(null);
        const result = await pickLutFile();
        expect(result).toBeNull();
    });

    it("returns null when open returns a string array (multiple: false guarantee)", async () => {
        vi.mocked(open).mockResolvedValue(["/a.cube", "/b.cube"]);
        const result = await pickLutFile();
        expect(result).toBeNull();
    });

    it("calls open with multiple: false and .cube filter", async () => {
        vi.mocked(open).mockResolvedValue("/path.cube");
        await pickLutFile();
        expect(open).toHaveBeenCalledWith({
            multiple: false,
            filters: [{ name: "LUT", extensions: ["cube"] }],
        });
    });
});
