/// <reference types="vite/client" />

declare const __PROFILING__: boolean;

interface ImportMetaEnv {
    /** Enables profiling/screenshot dev code paths (mirrors `__PROFILING__`). */
    readonly VITE_PROFILING?: string;
    /** Screenshot scenario shot id; only set for local capture runs. */
    readonly VITE_SCREENSHOT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
