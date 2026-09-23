import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("./FileHandlers", () => ({ loadImages: vi.fn(async () => 0) }));

import { invoke } from "@tauri-apps/api/core";
import { loadImages } from "./FileHandlers";
import {
    openPalette,
    openSession,
    renameSession,
    deleteSession,
    exportSession,
} from "./SessionService";
import { useAppState } from "../state/appState";
import { ImageProcessor } from "./ImageProcessor";
import { DEFAULT_ADJUSTMENTS } from "../types/adjustments";
import type { SessionSummary } from "../types";

const mockInvoke = vi.mocked(invoke);
const mockLoadImages = vi.mocked(loadImages);
const processor = {} as ImageProcessor;

function image(id: string) {
    return { id, filename: `${id}.jpg`, adjustments: structuredClone(DEFAULT_ADJUSTMENTS) };
}

function summary(id: number, name: string): SessionSummary {
    return { id, name, image_count: 1, updated_at: "2026-09-16T00:00:00Z" };
}

describe("SessionService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInvoke.mockResolvedValue([] as never);
        mockLoadImages.mockResolvedValue(0);
        useAppState.setState({
            images: [],
            sessionId: null,
            sessions: [],
            showSessions: false,
            selectedIds: new Set(),
            showExport: false,
            toastMessage: "",
        });
    });

    it("openPalette loads sessions and shows the modal", async () => {
        const sessions = [summary(1, "trip")];
        mockInvoke.mockResolvedValueOnce(sessions as never);

        await openPalette();

        expect(mockInvoke).toHaveBeenCalledWith("list_sessions");
        expect(useAppState.getState().sessions).toEqual(sessions);
        expect(useAppState.getState().showSessions).toBe(true);
    });

    it("openPalette keeps the stale list and still opens on failure", async () => {
        const stale = [summary(2, "old")];
        useAppState.setState({ sessions: stale });
        mockInvoke.mockRejectedValueOnce(new Error("boom"));

        await openPalette();

        expect(useAppState.getState().sessions).toEqual(stale);
        expect(useAppState.getState().showSessions).toBe(true);
    });

    it("openSession attaches the session and replaces the view", async () => {
        mockInvoke.mockResolvedValueOnce(["/a/1.jpg", "/a/2.jpg"] as never);
        mockLoadImages.mockResolvedValueOnce(2);

        await openSession(5, processor);

        expect(mockInvoke).toHaveBeenCalledWith("get_session_paths", { id: 5 });
        expect(mockLoadImages).toHaveBeenCalledWith(
            ["/a/1.jpg", "/a/2.jpg"],
            useAppState,
            processor,
            true,
            false,
        );
        expect(useAppState.getState().sessionId).toBe(5);
        expect(useAppState.getState().toastMessage).toBe("");
    });

    it("openSession toasts when only some files could be loaded", async () => {
        mockInvoke.mockResolvedValueOnce(["/a/1.jpg", "/a/2.jpg", "/a/3.jpg"] as never);
        mockLoadImages.mockResolvedValueOnce(1);

        await openSession(5, processor);

        expect(useAppState.getState().sessionId).toBe(5);
        expect(useAppState.getState().toastMessage).toBe("2 of 3 files unavailable");
    });

    it("openSession does not mark the session active when nothing loads", async () => {
        mockInvoke.mockResolvedValueOnce(["/a/1.jpg", "/a/2.jpg"] as never);
        mockLoadImages.mockResolvedValueOnce(0);

        await openSession(5, processor);

        expect(useAppState.getState().sessionId).toBeNull();
        expect(useAppState.getState().toastMessage).toBe("2 of 2 files unavailable");
    });

    it("deleteSession clears the active session when it was deleted", async () => {
        useAppState.setState({ sessionId: 5, sessions: [summary(5, "a"), summary(6, "b")] });
        mockInvoke.mockResolvedValueOnce(undefined as never);

        await deleteSession(5);

        expect(mockInvoke).toHaveBeenCalledWith("delete_session", { id: 5 });
        expect(useAppState.getState().sessionId).toBeNull();
        expect(useAppState.getState().sessions.map((s) => s.id)).toEqual([6]);
    });

    it("renameSession invokes the backend and updates the list", async () => {
        useAppState.setState({ sessions: [summary(5, "old")] });
        mockInvoke.mockResolvedValueOnce(undefined as never);

        await renameSession(5, "new");

        expect(mockInvoke).toHaveBeenCalledWith("rename_session", { id: 5, name: "new" });
        expect(useAppState.getState().sessions[0]!.name).toBe("new");
    });

    it("exportSession opens the session, selects all, and shows the export modal while closing sessions", async () => {
        useAppState.setState({ images: [image("a"), image("b")], showSessions: true });
        mockInvoke.mockResolvedValueOnce(["/a/1.jpg", "/a/2.jpg"] as never);
        mockLoadImages.mockResolvedValueOnce(2);

        await exportSession(5, processor);

        expect(useAppState.getState().selectedIds.size).toBe(2);
        expect(useAppState.getState().showExport).toBe(true);
        expect(useAppState.getState().showSessions).toBe(false);
    });
});
