/**
 * Case-insensitive subsequence matcher — every character of `query` must appear
 * in `target` in order, with any number of characters in between.
 *
 * - Empty query matches any target (returns true).
 * - Non-empty query against empty target returns false.
 * - Uses a single O(n+m) scan — no scoring, no ranking, no allocations beyond
 *   the lowercased strings.
 *
 * Examples:
 *   fuzzyMatch("kc",  "Kodak Cotton")    → true
 *   fuzzyMatch("ck",  "Kodak Cotton")    → false  (wrong order)
 *   fuzzyMatch("xyz", "Kodak")           → false  (missing chars)
 *   fuzzyMatch("",    "anything")        → true
 *   fuzzyMatch("abc", "")                → false
 */
export function fuzzyMatch(query: string, target: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
}
