import { useEffect, useRef } from "react";

export function useLatest<T>(value: T) {
    const ref = useRef(value);
    useEffect(() => { ref.current = value; }, [value]);
    return ref;
}

export function basename(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] ?? "";
}

