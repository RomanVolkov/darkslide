@group(0) @binding(0) var<storage, read> pixels_in: array<u32>;
@group(0) @binding(1) var<storage, read_write> pixels_out: array<u32>;
@group(0) @binding(2) var internal_lut: texture_3d<f32>;
@group(0) @binding(3) var imported_lut: texture_3d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;
@group(0) @binding(5) var<uniform> uniforms: Uniforms;

struct Uniforms {
    internal_lut_intensity: f32, // global intensity for internal 3D lut
    external_lut_intensity: f32, // intensity slider for external lut
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    image_width: u32,
    image_height: u32,
    _padding: u32,
}

fn hash_noise(x: u32, y: u32) -> f32 {
    var h = x * 374761393u + y * 668265263u;
    h = h ^ (h >> 13u);
    h = h * 1274126177u;
    h = h ^ (h >> 16u);
    return (f32(h) / 4294967295.0) * 2.0 - 1.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = pixels_in[gid.x];

    // unpack BGR
    let r = f32(p & 0xffu) / 255.0;
    let g = f32((p >> 8u) & 0xffu) / 255.0;
    let b = f32((p >> 16u) & 0xffu) / 255.0;
    let base_color = vec3<f32>(r, g, b);

    // Sample your dynamically generated internal 3D LUT
    // The base_color acts as the 3D X, Y, Z coordinate inside the color cube.
    let graded_color = textureSampleLevel(internal_lut, lut_sampler, base_color, 0.0).rgb;

    // Apply the master intensity.
    // Since you are passing 1.0, mix() will output exactly 100% of the graded_color.
    // Basically mixing the original color and the one after 3D lut
    let color_after_internal = mix(base_color, graded_color, uniforms.internal_lut_intensity);

    // 1. Query the dynamic size of the imported LUT (returns vec3<u32>)
    let dynamic_size = vec3<f32>(textureDimensions(imported_lut, 0));
    
    // 2. Apply the half-texel correction using the true size
    let external_uvw = (color_after_internal * (dynamic_size - 1.0) + 0.5) / dynamic_size;

    // apply imported lut
    let external_graded = textureSampleLevel(imported_lut, lut_sampler, external_uvw, 0.0).rgb;
    let final_color = mix(color_after_internal, external_graded, uniforms.external_lut_intensity);

    var color = final_color;
    if (uniforms.grain_amount > 0.0 && uniforms.image_width > 0u) {
        let block = u32((uniforms.grain_size / 100.0) * 7.0 + 1.0);
        let px = (gid.x % uniforms.image_width) / block;
        let py = (gid.x / uniforms.image_width) / block;
        let n_raw = hash_noise(px, py);
        let rough_exp = 1.0 - (uniforms.grain_roughness / 100.0) * 0.85;
        let n = select(sign(n_raw) * pow(abs(n_raw), rough_exp), n_raw, uniforms.grain_roughness == 0.0);
        let strength = uniforms.grain_amount / 100.0 * 30.0 / 255.0;
        let delta = strength * n;
        color = clamp(color + vec3<f32>(delta), vec3<f32>(0.0), vec3<f32>(1.0));
    }

    // Pack
    let out_r = u32(clamp(color.r * 255.0, 0.0, 255.0));
    let out_g = u32(clamp(color.g * 255.0, 0.0, 255.0));
    let out_b = u32(clamp(color.b * 255.0, 0.0, 255.0));
    let alpha = 0xFF000000u;  // force 255 as alpha (e.g., for JPEG)
    // let alpha = p & 0xff000000u; // original alpha channel

    pixels_out[gid.x] = out_r | (out_g << 8u) | (out_b << 16u) | alpha;
}
