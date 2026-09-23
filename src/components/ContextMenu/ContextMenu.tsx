import { memo, useEffect, useRef, useState, useLayoutEffect } from "react";
import { Key } from "../constants/index.ts";
import s from "./ContextMenu.module.css";

export interface ContextMenuItem {
    id: string;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    destructive?: boolean;
    separator?: boolean;
    onClick?: () => void;
}

export interface ContextMenuProps {
    items: ContextMenuItem[];
    x: number;
    y: number;
    onClose: () => void;
}

export const ContextMenu = memo(({ items, x, y, onClose }: ContextMenuProps) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    const [pos, setPos] = useState({ x, y });

    // Clamp coordinates to screen viewport once rendered
    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;

        let nx = x;
        let ny = y;

        if (nx + rect.width > vw - 8) {
            nx = Math.max(8, vw - rect.width - 8);
        }
        if (ny + rect.height > vh - 8) {
            ny = Math.max(8, vh - rect.height - 8);
        }

        setPos({ x: nx, y: ny });
    }, [x, y]);

    // Handle outside clicks
    useEffect(() => {
        const handlePointerDown = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        const handleContextMenu = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("contextmenu", handleContextMenu, true);
        return () => {
            window.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("contextmenu", handleContextMenu, true);
        };
    }, [onClose]);

    // Handle keyboard navigation
    useEffect(() => {
        const actionableIndices = items
            .map((it, idx) => (!it.separator && !it.disabled ? idx : -1))
            .filter((idx) => idx !== -1);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === Key.Escape) {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }

            if (e.key === Key.ArrowDown) {
                e.preventDefault();
                e.stopPropagation();
                setFocusedIndex((prev) => {
                    const currPos = actionableIndices.indexOf(prev);
                    if (currPos === -1 || currPos === actionableIndices.length - 1) {
                        return actionableIndices[0] ?? -1;
                    }
                    return actionableIndices[currPos + 1] ?? -1;
                });
                return;
            }

            if (e.key === Key.ArrowUp) {
                e.preventDefault();
                e.stopPropagation();
                setFocusedIndex((prev) => {
                    const currPos = actionableIndices.indexOf(prev);
                    if (currPos <= 0) {
                        return actionableIndices[actionableIndices.length - 1] ?? -1;
                    }
                    return actionableIndices[currPos - 1] ?? -1;
                });
                return;
            }

            if (e.key === Key.Enter || e.key === Key.Space) {
                if (focusedIndex >= 0 && focusedIndex < items.length) {
                    const item = items[focusedIndex];
                    if (item && !item.disabled && !item.separator && item.onClick) {
                        e.preventDefault();
                        e.stopPropagation();
                        item.onClick();
                        onClose();
                    }
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [items, focusedIndex, onClose]);

    return (
        <div
            ref={menuRef}
            className={s.menu}
            style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            role="menu"
            data-testid="context-menu"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            {items.map((item, index) => {
                if (item.separator) {
                    return <div key={item.id || `sep-${index}`} className={s.separator} role="separator" />;
                }

                const isFocused = focusedIndex === index;

                return (
                    <button
                        key={item.id}
                        type="button"
                        className={`${s.item}${item.destructive ? ` ${s.destructive}` : ""}${isFocused ? ` ${s.focused}` : ""}`}
                        disabled={item.disabled}
                        role="menuitem"
                        onClick={() => {
                            if (!item.disabled && item.onClick) {
                                item.onClick();
                                onClose();
                            }
                        }}
                        onMouseEnter={() => setFocusedIndex(index)}
                    >
                        <span className={s.label}>{item.label}</span>
                        {item.shortcut && <span className={s.shortcut}>{item.shortcut}</span>}
                    </button>
                );
            })}
        </div>
    );
});
