const isDev = !import.meta.env.PROD;

export const debug = {
    log: (message: string, data?: any) => {
        if (isDev) {
            console.log(`[DEBUG] ${message}`, data);
        }
    },

    error: (message: string, error?: unknown) => {
        if (isDev) {
            console.trace(`[ERROR] ${message}`, error);
        }
    },

    warn: (message: string, data?: any) => {
        if (isDev) {
            console.log(`[WARN] ${message}`, data);
        }
    },

    table: (label: string, data: any) => {
        if (isDev) {
            console.group(`[DEBUG] ${label}`);
            console.table(data);
            console.groupEnd();
        }
    }
};
