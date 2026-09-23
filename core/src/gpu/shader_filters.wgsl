struct BlurUniforms {
    width: u32,
    height: u32,
    radius: u32,
    strength: f32,
}

@group(0) @binding(0) var<storage, read> in_pixels: array<u32>;
@group(0) @binding(1) var<storage, read> orig_pixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> out_pixels: array<u32>;
@group(0) @binding(3) var<uniform> blur_params: BlurUniforms;

@compute @workgroup_size(16, 16)
fn blur_horizontal(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= blur_params.width || y >= blur_params.height) {
        return;
    }

    let r = i32(blur_params.radius);
    let left = max(0, i32(x) - r);
    let right = min(i32(blur_params.width) - 1, i32(x) + r);
    let count = f32(right - left + 1);

    var sum_r = 0.0;
    var sum_g = 0.0;
    var sum_b = 0.0;
    let row_offset = y * blur_params.width;

    for (var k = left; k <= right; k = k + 1) {
        let p = in_pixels[row_offset + u32(k)];
        sum_r = sum_r + f32(p & 255u);
        sum_g = sum_g + f32((p >> 8u) & 255u);
        sum_b = sum_b + f32((p >> 16u) & 255u);
    }

    let orig_p = in_pixels[row_offset + x];
    let a = orig_p & 0xFF000000u;
    let out_r = u32(floor(sum_r / count));
    let out_g = u32(floor(sum_g / count));
    let out_b = u32(floor(sum_b / count));

    out_pixels[row_offset + x] = out_r | (out_g << 8u) | (out_b << 16u) | a;
}

@compute @workgroup_size(16, 16)
fn blur_vertical_unsharp(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= blur_params.width || y >= blur_params.height) {
        return;
    }

    let r = i32(blur_params.radius);
    let top = max(0, i32(y) - r);
    let bottom = min(i32(blur_params.height) - 1, i32(y) + r);
    let count = f32(bottom - top + 1);

    var sum_r = 0.0;
    var sum_g = 0.0;
    var sum_b = 0.0;
    let w = blur_params.width;

    for (var k = top; k <= bottom; k = k + 1) {
        let p = in_pixels[u32(k) * w + x];
        sum_r = sum_r + f32(p & 255u);
        sum_g = sum_g + f32((p >> 8u) & 255u);
        sum_b = sum_b + f32((p >> 16u) & 255u);
    }

    let blurred_r = floor(sum_r / count);
    let blurred_g = floor(sum_g / count);
    let blurred_b = floor(sum_b / count);

    let orig_p = orig_pixels[y * w + x];
    let orig_r = f32(orig_p & 255u);
    let orig_g = f32((orig_p >> 8u) & 255u);
    let orig_b = f32((orig_p >> 16u) & 255u);
    let a = orig_p & 0xFF000000u;

    let s = blur_params.strength;
    let final_r = u32(clamp(round(orig_r + s * (orig_r - blurred_r)), 0.0, 255.0));
    let final_g = u32(clamp(round(orig_g + s * (orig_g - blurred_g)), 0.0, 255.0));
    let final_b = u32(clamp(round(orig_b + s * (orig_b - blurred_b)), 0.0, 255.0));

    out_pixels[y * w + x] = final_r | (final_g << 8u) | (final_b << 16u) | a;
}

// ---------------------------------------------------------------------------
// Edge-preserving denoise (separable bilateral)
//
// `radius` is the spatial window (in pixels) and `strength` is the range sigma
// in normalized 0..1 color space. Range weights suppress contributions from
// neighbors whose color differs from the center, so flat areas are smoothed
// while edges are preserved.
// ---------------------------------------------------------------------------

fn b_unpack(p: u32) -> vec3<f32> {
    return vec3<f32>(
        f32(p & 255u) / 255.0,
        f32((p >> 8u) & 255u) / 255.0,
        f32((p >> 16u) & 255u) / 255.0,
    );
}

fn b_pack(rgb: vec3<f32>, alpha: u32) -> u32 {
    let r = u32(clamp(rgb.r * 255.0 + 0.5, 0.0, 255.0));
    let g = u32(clamp(rgb.g * 255.0 + 0.5, 0.0, 255.0));
    let b = u32(clamp(rgb.b * 255.0 + 0.5, 0.0, 255.0));
    return r | (g << 8u) | (b << 16u) | alpha;
}

fn range_weight(center: vec3<f32>, sample_color: vec3<f32>, sigma: f32) -> f32 {
    let d = sample_color - center;
    return exp(-dot(d, d) / (2.0 * sigma * sigma));
}

@compute @workgroup_size(16, 16)
fn bilateral_horizontal(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= blur_params.width || y >= blur_params.height) {
        return;
    }

    let r = i32(blur_params.radius);
    let left = max(0, i32(x) - r);
    let right = min(i32(blur_params.width) - 1, i32(x) + r);
    let row_offset = y * blur_params.width;

    let center = b_unpack(in_pixels[row_offset + x]);
    let alpha = in_pixels[row_offset + x] & 0xFF000000u;
    let sigma = max(blur_params.strength, 1e-4);

    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var k = left; k <= right; k = k + 1) {
        let s = b_unpack(in_pixels[row_offset + u32(k)]);
        let weight = range_weight(center, s, sigma);
        sum = sum + s * weight;
        wsum = wsum + weight;
    }

    out_pixels[row_offset + x] = b_pack(sum / max(wsum, 1e-6), alpha);
}

@compute @workgroup_size(16, 16)
fn bilateral_vertical(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= blur_params.width || y >= blur_params.height) {
        return;
    }

    let r = i32(blur_params.radius);
    let top = max(0, i32(y) - r);
    let bottom = min(i32(blur_params.height) - 1, i32(y) + r);
    let w = blur_params.width;

    let center = b_unpack(in_pixels[u32(y) * w + x]);
    let alpha = in_pixels[u32(y) * w + x] & 0xFF000000u;
    let sigma = max(blur_params.strength, 1e-4);

    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var k = top; k <= bottom; k = k + 1) {
        let s = b_unpack(in_pixels[u32(k) * w + x]);
        let weight = range_weight(center, s, sigma);
        sum = sum + s * weight;
        wsum = wsum + weight;
    }

    out_pixels[u32(y) * w + x] = b_pack(sum / max(wsum, 1e-6), alpha);
}
