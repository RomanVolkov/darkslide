import { open } from "@tauri-apps/plugin-dialog";

export async function pickLutFile(): Promise<string | null> {
    const result = await open({
        multiple: false,
        filters: [{ name: "LUT", extensions: ["cube"] }],
    });
    return typeof result === "string" ? result : null;
}
