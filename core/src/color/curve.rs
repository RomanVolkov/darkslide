use crate::types;

/// True when the curve is the identity (no effect needed).
pub fn is_linear_curve(curve: &[types::CurvePoint]) -> bool {
    curve.iter().all(|p| (p.x - p.y).abs() < 0.5)
}

/// Build a 256-entry LUT from control points using Fritsch-Carlson
/// monotone cubic interpolation.
pub fn build_curve_lut(curve: &[types::CurvePoint]) -> [u8; 256] {
    let mut lut = [0u8; 256];

    if curve.is_empty() {
        for i in 0..256 {
            lut[i] = i as u8;
        }
        return lut;
    }

    // Sort by x, deduplicate adjacent x values.
    let mut pts: Vec<(f64, f64)> = curve.iter().map(|p| (p.x, p.y)).collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 0.5);
    let n = pts.len();

    if n == 1 {
        let v = pts[0].1.round().clamp(0.0, 255.0) as u8;
        lut.fill(v);
        return lut;
    }

    // Secant slopes.
    let d: Vec<f64> = (0..n - 1)
        .map(|i| (pts[i + 1].1 - pts[i].1) / (pts[i + 1].0 - pts[i].0))
        .collect();

    // Initial tangents (Catmull-Rom start/end, average interior).
    let mut m = vec![0f64; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = (d[i - 1] + d[i]) / 2.0;
    }

    // Fritsch-Carlson monotonicity adjustment.
    for i in 0..n - 1 {
        if d[i].abs() < 1e-12 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let alpha = m[i] / d[i];
            let beta = m[i + 1] / d[i];
            let h = (alpha * alpha + beta * beta).sqrt();
            if h > 3.0 {
                m[i] = 3.0 * d[i] * alpha / h;
                m[i + 1] = 3.0 * d[i] * beta / h;
            }
        }
    }

    // Evaluate at each integer 0..=255.
    for xi in 0usize..256 {
        let x = xi as f64;
        let y = if x <= pts[0].0 {
            pts[0].1
        } else if x >= pts[n - 1].0 {
            pts[n - 1].1
        } else {
            // Binary-search for the containing segment.
            let mut lo = 0usize;
            let mut hi = n - 2;
            while lo < hi {
                let mid = (lo + hi) / 2;
                if pts[mid + 1].0 < x {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let i = lo;
            let h = pts[i + 1].0 - pts[i].0;
            let t = (x - pts[i].0) / h;
            let t2 = t * t;
            let t3 = t2 * t;
            // Cubic Hermite basis.
            (2.0 * t3 - 3.0 * t2 + 1.0) * pts[i].1
                + (t3 - 2.0 * t2 + t) * h * m[i]
                + (-2.0 * t3 + 3.0 * t2) * pts[i + 1].1
                + (t3 - t2) * h * m[i + 1]
        };
        lut[xi] = y.round().clamp(0.0, 255.0) as u8;
    }
    lut
}
