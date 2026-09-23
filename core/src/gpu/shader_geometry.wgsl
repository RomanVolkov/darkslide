// Inverse-affine crop/straighten pass.
//
// For each output pixel we compute the source coordinate by undoing the crop
// (output pixel -> straightened space), undoing the rotation, and then sampling
// the graded source buffer bilinearly. Fill-mode: at zoom 1 the crop is the
// largest same-aspect rectangle inscribed in the rotated image, so the output
// never contains uncovered (black) pixels.

struct GeoUniforms {
    src_width: u32,
    src_height: u32,
    out_width: u32,
    out_height: u32,
    fit_w: f32,
    fit_h: f32,
    zoom: f32,
    cos_t: f32,
    sin_t: f32,
    offset_x: f32,
    offset_y: f32,
    perspective_v: f32,
    perspective_h: f32,
    distortion: f32,
    _pad0: f32,
    _pad1: f32,
}

@group(0) @binding(0) var<storage, read> src_pixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_pixels: array<u32>;
@group(0) @binding(2) var<uniform> geo: GeoUniforms;

fn geo_unpack(p: u32) -> vec3<f32> {
    return vec3<f32>(
        f32(p & 255u) / 255.0,
        f32((p >> 8u) & 255u) / 255.0,
        f32((p >> 16u) & 255u) / 255.0,
    );
}

fn geo_pack(color: vec3<f32>) -> u32 {
    let r = u32(clamp(color.r * 255.0 + 0.5, 0.0, 255.0));
    let g = u32(clamp(color.g * 255.0 + 0.5, 0.0, 255.0));
    let b = u32(clamp(color.b * 255.0 + 0.5, 0.0, 255.0));
    return r | (g << 8u) | (b << 16u) | 0xFF000000u;
}

fn sample_bilinear(x: f32, y: f32) -> vec3<f32> {
    let max_x = f32(geo.src_width) - 1.0;
    let max_y = f32(geo.src_height) - 1.0;
    let cx = clamp(x, 0.0, max_x);
    let cy = clamp(y, 0.0, max_y);

    let x0 = floor(cx);
    let y0 = floor(cy);
    let x1 = min(x0 + 1.0, max_x);
    let y1 = min(y0 + 1.0, max_y);
    let fx = cx - x0;
    let fy = cy - y0;

    let row0 = u32(y0) * geo.src_width;
    let row1 = u32(y1) * geo.src_width;
    let p00 = geo_unpack(src_pixels[row0 + u32(x0)]);
    let p10 = geo_unpack(src_pixels[row0 + u32(x1)]);
    let p01 = geo_unpack(src_pixels[row1 + u32(x0)]);
    let p11 = geo_unpack(src_pixels[row1 + u32(x1)]);

    let top = mix(p00, p10, fx);
    let bottom = mix(p01, p11, fx);
    return mix(top, bottom, fy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= geo.out_width * geo.out_height) {
        return;
    }
    let px = idx % geo.out_width;
    let py = idx / geo.out_width;

    // Output pixel -> crop-local coordinates in straightened space.
    let scale_x = geo.fit_w / (geo.zoom * f32(geo.out_width));
    let scale_y = geo.fit_h / (geo.zoom * f32(geo.out_height));
    let cx = (f32(px) + 0.5 - f32(geo.out_width) * 0.5) * scale_x + geo.offset_x;
    let cy = (f32(py) + 0.5 - f32(geo.out_height) * 0.5) * scale_y + geo.offset_y;

    // Projective perspective transform (homography) in normalized centered space [-1, 1].
    let half_w = max(geo.fit_w * 0.5, 1.0);
    let half_h = max(geo.fit_h * 0.5, 1.0);
    let nx = cx / half_w;
    let ny = cy / half_h;

    // Perspective pitch (v) and yaw (h). Range [-100, 100] mapped to [-0.5, 0.5].
    let pv = geo.perspective_v * 0.005;
    let ph = geo.perspective_h * 0.005;
    let w_proj = max(0.1, 1.0 + ph * nx + pv * ny);
    let cx2 = (nx / w_proj) * half_w;
    let cy2 = (ny / w_proj) * half_h;

    // Undo the rotation to get centered source coordinates.
    let u = cx2 * geo.cos_t + cy2 * geo.sin_t;
    let v = -cx2 * geo.sin_t + cy2 * geo.cos_t;

    // Radial lens distortion model: r' = r * (1 + k * (r/r_max)^2).
    let half_src_w = f32(geo.src_width) * 0.5;
    let half_src_h = f32(geo.src_height) * 0.5;
    let diag2 = max(half_src_w * half_src_w + half_src_h * half_src_h, 1.0);
    let r2 = (u * u + v * v) / diag2;
    let k = geo.distortion * 0.003;
    let dist_factor = 1.0 + k * r2;

    let sx = u * dist_factor + half_src_w;
    let sy = v * dist_factor + half_src_h;

    out_pixels[idx] = geo_pack(sample_bilinear(sx, sy));
}
