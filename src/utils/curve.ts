import type { CurvePoint } from "../backend/types.ts";

// Mirrors the Rust Fritsch-Carlson monotone cubic used for the LUT.
export function evaluateCurve(curve: CurvePoint[], x: number): number {
    if (curve.length === 0) return x;
    const pts = [...curve].sort((a, b) => a.x - b.x);
    const n = pts.length;

    const first = pts[0];
    const last = pts[n - 1];
    if (first === undefined || last === undefined) return x;
    if (x <= first.x) return first.y;
    if (x >= last.x) return last.y;

    if (n === 2) {
        const t = (x - first.x) / (last.x - first.x);
        return first.y + t * (last.y - first.y);
    }

    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a === undefined || b === undefined) return x;
        d.push((b.y - a.y) / (b.x - a.x));
    }

    const m: number[] = new Array(n);
    const d0 = d[0];
    const dn = d[n - 2];
    if (d0 === undefined || dn === undefined) return x;
    m[0] = d0;
    m[n - 1] = dn;
    for (let i = 1; i < n - 1; i++) {
        const dl = d[i - 1];
        const dr = d[i];
        if (dl === undefined || dr === undefined) return x;
        m[i] = (dl + dr) / 2;
    }

    for (let i = 0; i < n - 1; i++) {
        const di = d[i];
        const mi = m[i];
        const mi1 = m[i + 1];
        if (di === undefined || mi === undefined || mi1 === undefined) return x;
        if (Math.abs(di) < 1e-12) { m[i] = 0; m[i + 1] = 0; }
        else {
            const alpha = mi / di, beta = mi1 / di;
            const h = Math.sqrt(alpha * alpha + beta * beta);
            if (h > 3) { m[i] = 3 * di * alpha / h; m[i + 1] = 3 * di * beta / h; }
        }
    }

    let lo = 0, hi = n - 2;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const midPt = pts[mid + 1];
        if (midPt === undefined) return x;
        if (midPt.x < x) lo = mid + 1; else hi = mid;
    }

    const i = lo;
    const pa = pts[i];
    const pb = pts[i + 1];
    const ma = m[i];
    const mb = m[i + 1];
    if (pa === undefined || pb === undefined || ma === undefined || mb === undefined) return x;
    const h = pb.x - pa.x;
    const t = (x - pa.x) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pa.y + (t3 - 2 * t2 + t) * h * ma
        + (-2 * t3 + 3 * t2) * pb.y + (t3 - t2) * h * mb;
}
