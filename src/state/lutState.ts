import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { debug } from "../utils/debug";

export class LutItem {
    id: number;
    name: string;

    constructor(id: number, name: string) {
        this.id = id;
        this.name = name;
    }
}

export interface LUTStorage {
    items: LutItem[];
    isLoading: boolean;
    isMutating: boolean;
    error: string | null;
    loadItems: () => Promise<void>;
    deleteItem: (id: number) => Promise<void>;
    importItem: (filePath: string) => Promise<void>;
    getNameBy: (id: number | null) => string | null;
}

export const lutState = create<LUTStorage>((set, get) => ({
    items: [],
    isLoading: false,
    isMutating: false,
    error: null,

    loadItems: async () => {
        set({ isLoading: true, error: null });
        try {
            const string_values = await invoke<string[]>("load_luts");
            const items: LutItem[] = string_values.flatMap(value => {
                const [idStr, name] = value.split(";");
                if (idStr === undefined || name === undefined) return [];
                return [new LutItem(parseInt(idStr), name)];
            });
            set({ items: items, isLoading: false });
        }
        catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);
            debug.error(errorMessage);
            set({ error: errorMessage, isLoading: false });
        }
    },

    deleteItem: async (id: number) => {
        set({ isMutating: true });
        try {
            await invoke("delete_lut", { id });
            await get().loadItems();
        }
        catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);
            debug.error(errorMessage);
            set({ error: errorMessage });

        }
        finally {
            set({ isMutating: false });
        }
    },
    importItem: async (filePath: string) => {
        set({ isMutating: true });
        try {
            debug.log("calling import_lut");
            await invoke("import_lut", { lutPath: filePath });
            await get().loadItems();
        }
        catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);
            debug.error(errorMessage);
            set({ error: errorMessage });

        }
        finally {
            set({ isMutating: false });
        }
    },
    getNameBy: (id: number | null) => {
        if (!id) return null;
        return get().items.find(t => t.id == id)?.name ?? null;
    },
}));
