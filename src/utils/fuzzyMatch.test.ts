import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "./fuzzyMatch.ts";

describe("fuzzyMatch", () => {
    it("returns true for empty query", () => {
        expect(fuzzyMatch("", "anything")).toBe(true);
    });

    it("returns false when target is empty but query is not", () => {
        expect(fuzzyMatch("abc", "")).toBe(false);
    });

    it("returns true for exact match (case-insensitive)", () => {
        expect(fuzzyMatch("kodak portra 400", "Kodak Portra 400")).toBe(true);
    });

    it("returns true for subsequence match", () => {
        expect(fuzzyMatch("kc", "Kodak Cotton")).toBe(true);
    });

    it("returns false when query chars appear in wrong order", () => {
        expect(fuzzyMatch("ck", "Kodak Cotton")).toBe(false);
    });

    it("is case-insensitive", () => {
        expect(fuzzyMatch("Kodak", "KODAK PORTRA 400")).toBe(true);
        expect(fuzzyMatch("KODAK", "Kodak Portra 400")).toBe(true);
    });

    it("returns true for single char match", () => {
        expect(fuzzyMatch("f", "Fuji Velvia 50")).toBe(true);
    });

    it("returns false when query contains chars not in target", () => {
        expect(fuzzyMatch("xyz", "Kodak")).toBe(false);
    });

    it("matches repeated chars", () => {
        expect(fuzzyMatch("oo", "Lomochrome Purple")).toBe(true);
    });
});
