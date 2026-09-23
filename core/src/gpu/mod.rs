const WORKGROUP_SIZE: u32 = 64;

use bytemuck;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use wgpu::util::DeviceExt;
use wgpu::ComputePipeline;

pub struct GpuState {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bgl: wgpu::BindGroupLayout,
    pipeline_blur_h: wgpu::ComputePipeline,
    pipeline_blur_v: wgpu::ComputePipeline,
    pipeline_bilateral_h: wgpu::ComputePipeline,
    pipeline_bilateral_v: wgpu::ComputePipeline,
    filter_bgl: wgpu::BindGroupLayout,
    pipeline_geometry: wgpu::ComputePipeline,
    geometry_bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    lut_texture_cache: Mutex<HashMap<(usize, usize), (Arc<Vec<f32>>, wgpu::TextureView)>>,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct FilterUniforms {
    width: u32,
    height: u32,
    radius: u32,
    strength: f32,
}

/// Which pair of filter pipelines to run for one pass.
#[derive(Clone, Copy)]
enum FilterKind {
    /// Box blur + unsharp mask (texture / clarity / sharpen).
    Unsharp,
    /// Separable bilateral smoothing (denoise).
    Denoise,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
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

/// Largest same-aspect rectangle inscribed in the rotated source (at zoom 1)
/// and the output size at the requested zoom.
#[derive(Clone, Copy, Debug)]
struct GeometryFit {
    fit_w: f32,
    fit_h: f32,
    out_w: u32,
    out_h: u32,
}

/// Compute the fill-mode crop/straighten output geometry for a `w`×`h` source.
fn geometry_fit(w: u32, h: u32, straighten_rad: f32, zoom: f32) -> GeometryFit {
    let wf = w as f32;
    let hf = h as f32;
    let inv_aspect = (hf / wf).max(1e-6); // h = w * inv_aspect for the source aspect
    let c = straighten_rad.cos().abs();
    let s = straighten_rad.sin().abs();
    // Largest axis-aligned rect of the source aspect inscribed in the rotated source.
    let fit_w = (wf / (c + s * inv_aspect)).min(hf / (s + c * inv_aspect));
    let fit_h = fit_w * inv_aspect;
    let z = zoom.max(1.0);
    let out_w = ((fit_w / z).round() as u32).clamp(1, w);
    let out_h = ((fit_h / z).round() as u32).clamp(1, h);
    GeometryFit {
        fit_w,
        fit_h,
        out_w,
        out_h,
    }
}

/// True when the geometry transform is a no-op (identity fast-path).
fn geometry_is_identity(g: &crate::types::Geometry) -> bool {
    g.straighten.abs() < 1e-4
        && (g.zoom - 1.0).abs() < 1e-4
        && g.crop_x.abs() < 1e-4
        && g.crop_y.abs() < 1e-4
        && g.distortion.abs() < 1e-4
        && g.perspective_v.abs() < 1e-4
        && g.perspective_h.abs() < 1e-4
}

/// Output dimensions produced by the crop/straighten pass for a `w`×`h` source.
/// Returns `(w, h)` unchanged for the identity geometry.
pub fn geometry_output_size(w: u32, h: u32, geometry: &crate::types::Geometry) -> (u32, u32) {
    if geometry_is_identity(geometry) {
        return (w, h);
    }
    let fit = geometry_fit(w, h, geometry.straighten.to_radians(), geometry.zoom);
    (fit.out_w, fit.out_h)
}

/// The ordered GPU filter passes (texture, clarity, sharpen, denoise) for a
/// `Detail`. Shared by the single and batch render paths.
fn filter_passes_for(detail: &crate::types::Detail) -> Vec<(FilterKind, u32, f32)> {
    let mut passes = Vec::new();
    if detail.texture != 0 {
        passes.push((FilterKind::Unsharp, 3, detail.texture as f32 / 100.0));
    }
    if detail.clarity != 0 {
        passes.push((FilterKind::Unsharp, 18, detail.clarity as f32 / 100.0));
    }
    if detail.sharpen.amount > 0 {
        let r = ((detail.sharpen.radius as f32 / 100.0) * 2.0 + 1.0).round() as u32;
        passes.push((FilterKind::Unsharp, r, detail.sharpen.amount as f32 / 100.0));
    }
    if detail.denoise.strength > 0 {
        let radius = 1 + ((detail.denoise.strength as f32 / 100.0) * 3.0).round() as u32;
        let sigma = 0.02 + (1.0 - detail.denoise.preserve as f32 / 100.0) * 0.28;
        passes.push((FilterKind::Denoise, radius, sigma));
    }
    passes
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    internal_lut_intensity: f32,
    external_lut_intensity: f32,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    image_width: u32,
    image_height: u32,
    _padding: u32,
}

#[derive(Clone, Debug)]
pub struct Lut3d {
    pub data: Arc<Vec<f32>>,
    pub size: usize,
    // should be in a range of 0.0...1.0
    pub intensity: f32,
}

impl Lut3d {
    pub fn new(data: Vec<f32>, size: usize, intensity: f32) -> Self {
        Self {
            data: Arc::new(data),
            size,
            intensity,
        }
    }

    pub fn from_arc(data: Arc<Vec<f32>>, size: usize, intensity: f32) -> Self {
        Self {
            data,
            size,
            intensity,
        }
    }
}

/// One unit of work for `GpuState::render_batch`.
///
/// The input pixels and LUTs are consumed when the batch is submitted.
/// The raw RGBA result (including any padding) is sent through `result_tx`
/// as soon as the GPU readback completes.
pub struct GpuRenderJob {
    pub input: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub internal_lut: Lut3d,
    pub external_lut: Lut3d,
    pub detail: crate::types::Detail,
    pub geometry: crate::types::Geometry,
    pub result_tx: mpsc::Sender<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpuInitError {
    NoCompatibleAdapter,
    DeviceCreationFailed(String),
}

impl std::fmt::Display for GpuInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoCompatibleAdapter => write!(
                f,
                "No compatible GPU adapter found supporting required graphics APIs (Metal, Vulkan, DX12)"
            ),
            Self::DeviceCreationFailed(msg) => write!(f, "Failed to acquire GPU device: {msg}"),
        }
    }
}

impl std::error::Error for GpuInitError {}

impl GpuState {
    pub fn init() -> Result<Self, GpuInitError> {
        pollster::block_on(async {
            let instance = wgpu::Instance::default();
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: None,
                    force_fallback_adapter: false,
                })
                .await
                .map_err(|_| GpuInitError::NoCompatibleAdapter)?;

            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: None,
                    required_features: wgpu::Features::FLOAT32_FILTERABLE,
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::default(),
                    experimental_features: wgpu::ExperimentalFeatures::default(),
                    trace: wgpu::Trace::Off,
                })
                .await
                .map_err(|e| GpuInitError::DeviceCreationFailed(e.to_string()))?;

            let (pipeline, bgl) = Self::create_3d_lut_pipeline(&device);
            let (
                pipeline_blur_h,
                pipeline_blur_v,
                pipeline_bilateral_h,
                pipeline_bilateral_v,
                filter_bgl,
            ) = Self::create_filter_pipelines(&device);
            let (pipeline_geometry, geometry_bgl) = Self::create_geometry_pipeline(&device);

            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Shared LUT Sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Linear,
                ..Default::default()
            });

            Ok(GpuState {
                device,
                queue,
                pipeline,
                bgl,
                pipeline_blur_h,
                pipeline_blur_v,
                pipeline_bilateral_h,
                pipeline_bilateral_v,
                filter_bgl,
                pipeline_geometry,
                geometry_bgl,
                sampler,
                lut_texture_cache: Mutex::new(HashMap::new()),
            })
        })
    }

    fn create_3d_lut_pipeline(device: &wgpu::Device) -> (ComputePipeline, wgpu::BindGroupLayout) {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("3d_lut"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader_3d_lut.wgsl").into()),
        });

        let storage_ro = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let storage_rw = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: false },
            has_dynamic_offset: false,
            min_binding_size: None,
        };

        let texture = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D3,
            multisampled: false,
        };

        let sampler = wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering);

        let uniform_buffer = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        };

        let vis = wgpu::ShaderStages::COMPUTE;

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Dual 3D LUT Bind Group Layout"),
            entries: &[
                // pixels_in
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: vis,
                    ty: storage_ro,
                    count: None,
                },
                // pixels_out
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: vis,
                    ty: storage_rw,
                    count: None,
                },
                // internal_lut
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: vis,
                    ty: texture,
                    count: None,
                },
                // external_lut
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: vis,
                    ty: texture,
                    count: None,
                },
                // shared sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: vis,
                    ty: sampler,
                    count: None,
                },
                // uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: vis,
                    ty: uniform_buffer,
                    count: None,
                },
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            immediate_size: 0,
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("3D lut"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        (pipeline, bgl)
    }

    fn create_filter_pipelines(
        device: &wgpu::Device,
    ) -> (
        ComputePipeline,
        ComputePipeline,
        ComputePipeline,
        ComputePipeline,
        wgpu::BindGroupLayout,
    ) {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Filters Compute Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader_filters.wgsl").into()),
        });

        let storage_ro = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let storage_rw = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: false },
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let uniform_buffer = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        };

        let vis = wgpu::ShaderStages::COMPUTE;

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Filters Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: vis,
                    ty: storage_ro,
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: vis,
                    ty: storage_ro,
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: vis,
                    ty: storage_rw,
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: vis,
                    ty: uniform_buffer,
                    count: None,
                },
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            immediate_size: 0,
        });

        let pipeline_h = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("blur_horizontal"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("blur_horizontal"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let pipeline_v = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("blur_vertical_unsharp"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("blur_vertical_unsharp"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let pipeline_bilateral_h = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("bilateral_horizontal"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("bilateral_horizontal"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let pipeline_bilateral_v = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("bilateral_vertical"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("bilateral_vertical"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        (pipeline_h, pipeline_v, pipeline_bilateral_h, pipeline_bilateral_v, bgl)
    }

    fn create_geometry_pipeline(
        device: &wgpu::Device,
    ) -> (ComputePipeline, wgpu::BindGroupLayout) {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("geometry"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader_geometry.wgsl").into()),
        });

        let vis = wgpu::ShaderStages::COMPUTE;
        let storage_ro = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let storage_rw = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: false },
            has_dynamic_offset: false,
            min_binding_size: None,
        };
        let uniform = wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        };

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Geometry Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: vis,
                    ty: storage_ro,
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: vis,
                    ty: storage_rw,
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: vis,
                    ty: uniform,
                    count: None,
                },
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            immediate_size: 0,
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("geometry"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        (pipeline, bgl)
    }

    /// Record the inverse-affine geometry pass from `src_buf` (a `src_w`×`src_h`
    /// graded buffer) into a freshly allocated output buffer. Returns the output
    /// buffer and its padded byte size.
    fn encode_geometry(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        src_buf: &wgpu::Buffer,
        src_w: u32,
        src_h: u32,
        geometry: &crate::types::Geometry,
        fit: &GeometryFit,
    ) -> (wgpu::Buffer, u64) {
        let z = geometry.zoom.max(1.0);
        let theta = geometry.straighten.to_radians();
        let offset_x = geometry.crop_x * fit.fit_w * (1.0 - 1.0 / z) * 0.5;
        let offset_y = geometry.crop_y * fit.fit_h * (1.0 - 1.0 / z) * 0.5;

        let uniforms = GeoUniforms {
            src_width: src_w,
            src_height: src_h,
            out_width: fit.out_w,
            out_height: fit.out_h,
            fit_w: fit.fit_w,
            fit_h: fit.fit_h,
            zoom: z,
            cos_t: theta.cos(),
            sin_t: theta.sin(),
            offset_x,
            offset_y,
            perspective_v: geometry.perspective_v,
            perspective_h: geometry.perspective_h,
            distortion: geometry.distortion,
            _pad0: 0.0,
            _pad1: 0.0,
        };

        let uniform_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("geometry uniform"),
                contents: bytemuck::bytes_of(&uniforms),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let out_pixels = (fit.out_w * fit.out_h) as u32;
        let out_padded = out_pixels.div_ceil(WORKGROUP_SIZE) * WORKGROUP_SIZE;
        let out_bytes = (out_padded * 4) as u64;

        let out_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("geometry output"),
            size: out_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("geometry bind group"),
            layout: &self.geometry_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: src_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: out_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("geometry pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline_geometry);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(out_padded / WORKGROUP_SIZE, 1, 1);
        }

        (out_buf, out_bytes)
    }

    pub fn render_single(
        &self,
        input: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        internal_lut: Lut3d,
        external_lut: Lut3d,
        detail: &crate::types::Detail,
        geometry: &crate::types::Geometry,
    ) -> Vec<u8> {
        let pixel_count = (width * height) as usize;
        let padded = (pixel_count as u32).div_ceil(WORKGROUP_SIZE) * WORKGROUP_SIZE;
        let padded_bytes = (padded * 4) as u64;
        let input_len = input.len();

        let geo_fit = geometry_fit(width, height, geometry.straighten.to_radians(), geometry.zoom);
        let geo_active = !geometry_is_identity(geometry);
        let (staging_bytes, readback_len) = if geo_active {
            let out_pixels = geo_fit.out_w * geo_fit.out_h;
            let out_padded = out_pixels.div_ceil(WORKGROUP_SIZE) * WORKGROUP_SIZE;
            ((out_padded * 4) as u64, (out_pixels * 4) as usize)
        } else {
            (padded_bytes, input_len)
        };

        let input_buf = if input_len == padded_bytes as usize {
            self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pixels in"),
                contents: &input,
                usage: wgpu::BufferUsages::STORAGE,
            })
        } else {
            let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pixels in padded"),
                size: padded_bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.queue.write_buffer(&buf, 0, &input);
            buf
        };

        let output_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pixels output"),
            size: padded_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let internal_3d_lut_view =
            self.get_or_create_3d_texture(&internal_lut.data, internal_lut.size, "internal 3d lut texture");
        let external_3d_lut_view =
            self.get_or_create_3d_texture(&external_lut.data, external_lut.size, "external 3d lut texture");

        let uniforms = Uniforms {
            internal_lut_intensity: internal_lut.intensity,
            external_lut_intensity: external_lut.intensity,
            grain_amount: detail.grain.amount as f32,
            grain_size: detail.grain.size as f32,
            grain_roughness: detail.grain.roughness as f32,
            image_width: width,
            image_height: height,
            _padding: 0,
        };

        let uniform_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("lut intensity uniform"),
                contents: bytemuck::bytes_of(&uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Dual LUT Bind Group"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: input_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&internal_3d_lut_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&external_3d_lut_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("3d lut staging buffer"),
            size: staging_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("compute pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(&self.pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            compute_pass.dispatch_workgroups(padded / WORKGROUP_SIZE, 1, 1);
        }

        let filter_passes = filter_passes_for(detail);

        if !filter_passes.is_empty() {
            let buf_b = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pixels output B"),
                size: padded_bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let buf_scratch = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pixels scratch"),
                size: padded_bytes,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });

            let mut cur_is_a = true;
            let x_groups = (width + 15) / 16;
            let y_groups = (height + 15) / 16;

            for (kind, radius, strength) in filter_passes {
                let (pipe_h, pipe_v) = match kind {
                    FilterKind::Unsharp => (&self.pipeline_blur_h, &self.pipeline_blur_v),
                    FilterKind::Denoise => (&self.pipeline_bilateral_h, &self.pipeline_bilateral_v),
                };
                let filter_uniforms = FilterUniforms {
                    width,
                    height,
                    radius,
                    strength,
                };
                let filter_uniform_buf = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("filter uniform"),
                        contents: bytemuck::bytes_of(&filter_uniforms),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });

                let (cur_buf, next_buf) = if cur_is_a {
                    (&output_buf, &buf_b)
                } else {
                    (&buf_b, &output_buf)
                };

                let bind_group_h = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("filter h bind group"),
                    layout: &self.filter_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: cur_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: cur_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: buf_scratch.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: filter_uniform_buf.as_entire_binding(),
                        },
                    ],
                });

                {
                    let mut pass_h = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                        label: Some("filter h pass"),
                        timestamp_writes: None,
                    });
                    pass_h.set_pipeline(pipe_h);
                    pass_h.set_bind_group(0, &bind_group_h, &[]);
                    pass_h.dispatch_workgroups(x_groups, y_groups, 1);
                }

                let bind_group_v = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("filter v bind group"),
                    layout: &self.filter_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: buf_scratch.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: cur_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: next_buf.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: filter_uniform_buf.as_entire_binding(),
                        },
                    ],
                });

                {
                    let mut pass_v = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                        label: Some("filter v pass"),
                        timestamp_writes: None,
                    });
                    pass_v.set_pipeline(pipe_v);
                    pass_v.set_bind_group(0, &bind_group_v, &[]);
                    pass_v.dispatch_workgroups(x_groups, y_groups, 1);
                }

                cur_is_a = !cur_is_a;
            }

            let final_buf = if cur_is_a { &output_buf } else { &buf_b };
            if geo_active {
                let (geo_buf, geo_bytes) =
                    self.encode_geometry(&mut encoder, final_buf, width, height, geometry, &geo_fit);
                encoder.copy_buffer_to_buffer(&geo_buf, 0, &staging, 0, geo_bytes);
            } else {
                encoder.copy_buffer_to_buffer(final_buf, 0, &staging, 0, padded_bytes);
            }
        } else if geo_active {
            let (geo_buf, geo_bytes) =
                self.encode_geometry(&mut encoder, &output_buf, width, height, geometry, &geo_fit);
            encoder.copy_buffer_to_buffer(&geo_buf, 0, &staging, 0, geo_bytes);
        } else {
            encoder.copy_buffer_to_buffer(&output_buf, 0, &staging, 0, padded_bytes);
        }

        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        self.device.poll(wgpu::PollType::wait_indefinitely()).ok();

        if let Ok(Ok(())) = rx.recv() {
            let mapped = slice.get_mapped_range();
            let data = mapped[..readback_len].to_vec();
            drop(mapped);
            staging.unmap();
            data
        } else {
            vec![]
        }
    }

    /// Synchronous single-image render. Kept for backward compatibility with
    /// synchronous callers such as the standalone CLI.
    pub fn apply_3d_luts(
        &self,
        pixels: &[u8],
        width: u32,
        height: u32,
        external_lut: Lut3d,
        internal_lut: Lut3d,
    ) -> Vec<u8> {
        self.render_single(
            Arc::new(pixels.to_vec()),
            width,
            height,
            internal_lut,
            external_lut,
            &crate::types::Detail::default(),
            &crate::types::Geometry::default(),
        )
    }

    /// Submit a batch of LUT renders to the GPU and return results asynchronously.
    ///
    /// All jobs are recorded into a single command encoder and submitted together.
    /// Each job's staging buffer is mapped after submission; as soon as a readback
    /// completes the raw pixel buffer is sent through `job.result_tx`. A background
    /// thread polls the device until every mapping has completed.
    pub fn render_batch(&self, jobs: Vec<GpuRenderJob>) {
        if jobs.is_empty() {
            return;
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());

        struct Pending {
            staging: wgpu::Buffer,
            input_len: usize,
            result_tx: mpsc::Sender<Vec<u8>>,
        }

        let total = jobs.len();
        let completed = Arc::new(AtomicUsize::new(0));
        let mut pending = Vec::with_capacity(total);

        for job in jobs {
            let pixel_count = (job.width * job.height) as u32;
            let padded = pixel_count.div_ceil(WORKGROUP_SIZE) * WORKGROUP_SIZE;
            let padded_bytes = (padded * 4) as u64;
            let input_len = job.input.len();

            let geo_fit = geometry_fit(
                job.width,
                job.height,
                job.geometry.straighten.to_radians(),
                job.geometry.zoom,
            );
            let geo_active = !geometry_is_identity(&job.geometry);
            let (staging_bytes, readback_len) = if geo_active {
                let out_pixels = geo_fit.out_w * geo_fit.out_h;
                let out_padded = out_pixels.div_ceil(WORKGROUP_SIZE) * WORKGROUP_SIZE;
                ((out_padded * 4) as u64, (out_pixels * 4) as usize)
            } else {
                (padded_bytes, input_len)
            };

            let input_buf = if input_len == padded_bytes as usize {
                self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("pixels in"),
                    contents: &job.input,
                    usage: wgpu::BufferUsages::STORAGE,
                })
            } else {
                // Avoid a CPU-side clone+resize: create a zero-padded GPU buffer
                // and upload only the actual pixel bytes. The uninitialized tail
                // is already zero-filled by create_buffer.
                let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pixels in padded"),
                    size: padded_bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.queue.write_buffer(&buf, 0, &job.input);
                buf
            };

            let output_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("pixels output"),
                size: padded_bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });

            let internal_3d_lut_view =
                self.get_or_create_3d_texture(&job.internal_lut.data, job.internal_lut.size, "internal 3d lut texture");
            let external_3d_lut_view =
                self.get_or_create_3d_texture(&job.external_lut.data, job.external_lut.size, "external 3d lut texture");

            let uniforms = Uniforms {
                internal_lut_intensity: job.internal_lut.intensity,
                external_lut_intensity: job.external_lut.intensity,
                grain_amount: job.detail.grain.amount as f32,
                grain_size: job.detail.grain.size as f32,
                grain_roughness: job.detail.grain.roughness as f32,
                image_width: job.width,
                image_height: job.height,
                _padding: 0,
            };

            let uniform_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("lut intensity uniform"),
                    contents: bytemuck::bytes_of(&uniforms),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Dual LUT Bind Group"),
                layout: &self.bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: input_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: output_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&internal_3d_lut_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&external_3d_lut_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: uniform_buf.as_entire_binding(),
                    },
                ],
            });

            {
                let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("compute pass"),
                    timestamp_writes: None,
                });
                compute_pass.set_pipeline(&self.pipeline);
                compute_pass.set_bind_group(0, &bind_group, &[]);
                compute_pass.dispatch_workgroups(padded / WORKGROUP_SIZE, 1, 1);
            }

            let filter_passes = filter_passes_for(&job.detail);

            let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("3d lut staging buffer"),
                size: staging_bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            if !filter_passes.is_empty() {
                let buf_b = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pixels output B"),
                    size: padded_bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                let buf_scratch = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pixels scratch"),
                    size: padded_bytes,
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                });

                let mut cur_is_a = true;
                let x_groups = (job.width + 15) / 16;
                let y_groups = (job.height + 15) / 16;

                for (kind, radius, strength) in filter_passes {
                    let (pipe_h, pipe_v) = match kind {
                        FilterKind::Unsharp => (&self.pipeline_blur_h, &self.pipeline_blur_v),
                        FilterKind::Denoise => (&self.pipeline_bilateral_h, &self.pipeline_bilateral_v),
                    };
                    let filter_uniforms = FilterUniforms {
                        width: job.width,
                        height: job.height,
                        radius,
                        strength,
                    };
                    let filter_uniform_buf = self
                        .device
                        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("filter uniform"),
                            contents: bytemuck::bytes_of(&filter_uniforms),
                            usage: wgpu::BufferUsages::UNIFORM,
                        });

                    let (cur_buf, next_buf) = if cur_is_a {
                        (&output_buf, &buf_b)
                    } else {
                        (&buf_b, &output_buf)
                    };

                    let bind_group_h = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("filter h bind group"),
                        layout: &self.filter_bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: cur_buf.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: cur_buf.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: buf_scratch.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 3,
                                resource: filter_uniform_buf.as_entire_binding(),
                            },
                        ],
                    });

                    {
                        let mut pass_h = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                            label: Some("filter h pass"),
                            timestamp_writes: None,
                        });
                        pass_h.set_pipeline(pipe_h);
                        pass_h.set_bind_group(0, &bind_group_h, &[]);
                        pass_h.dispatch_workgroups(x_groups, y_groups, 1);
                    }

                    let bind_group_v = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("filter v bind group"),
                        layout: &self.filter_bgl,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: buf_scratch.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: cur_buf.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: next_buf.as_entire_binding(),
                            },
                            wgpu::BindGroupEntry {
                                binding: 3,
                                resource: filter_uniform_buf.as_entire_binding(),
                            },
                        ],
                    });

                    {
                        let mut pass_v = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                            label: Some("filter v pass"),
                            timestamp_writes: None,
                        });
                        pass_v.set_pipeline(pipe_v);
                        pass_v.set_bind_group(0, &bind_group_v, &[]);
                        pass_v.dispatch_workgroups(x_groups, y_groups, 1);
                    }

                    cur_is_a = !cur_is_a;
                }

                let final_buf = if cur_is_a { &output_buf } else { &buf_b };
                if geo_active {
                    let (geo_buf, geo_bytes) = self.encode_geometry(
                        &mut encoder,
                        final_buf,
                        job.width,
                        job.height,
                        &job.geometry,
                        &geo_fit,
                    );
                    encoder.copy_buffer_to_buffer(&geo_buf, 0, &staging, 0, geo_bytes);
                } else {
                    encoder.copy_buffer_to_buffer(final_buf, 0, &staging, 0, padded_bytes);
                }
            } else if geo_active {
                let (geo_buf, geo_bytes) = self.encode_geometry(
                    &mut encoder,
                    &output_buf,
                    job.width,
                    job.height,
                    &job.geometry,
                    &geo_fit,
                );
                encoder.copy_buffer_to_buffer(&geo_buf, 0, &staging, 0, geo_bytes);
            } else {
                encoder.copy_buffer_to_buffer(&output_buf, 0, &staging, 0, padded_bytes);
            }

            pending.push(Pending {
                staging,
                input_len: readback_len,
                result_tx: job.result_tx,
            });
        }

        // Submit before mapping so the staging buffers are not considered mapped
        // while the command encoder still references them.
        self.queue.submit(std::iter::once(encoder.finish()));

        for pending in pending {
            let staging = pending.staging;
            let staging_for_callback = staging.clone();
            let completed = completed.clone();
            let result_tx = pending.result_tx;
            let input_len = pending.input_len;
            staging.slice(..).map_async(wgpu::MapMode::Read, move |result| {
                match result {
                    Ok(()) => {
                        let mapped = staging_for_callback.slice(..).get_mapped_range();
                        let data = mapped[..input_len].to_vec();
                        drop(mapped);
                        staging_for_callback.unmap();
                        let _ = result_tx.send(data);
                    }
                    Err(_) => {
                        let _ = result_tx.send(vec![]);
                    }
                }
                completed.fetch_add(1, Ordering::Relaxed);
            });
        }

        while completed.load(Ordering::Relaxed) < total {
            self.device.poll(wgpu::PollType::wait_indefinitely()).ok();
        }
    }

    fn get_or_create_3d_texture(
        &self,
        data: &Arc<Vec<f32>>,
        size: usize,
        label: &str,
    ) -> wgpu::TextureView {
        let key = (Arc::as_ptr(data) as usize, data.len());
        {
            let cache = self.lut_texture_cache.lock().unwrap();
            if let Some((cached_data, view)) = cache.get(&key) {
                // The pointer key alone is not enough after the original Arc is dropped,
                // so keep the Arc alive in the cache entry and verify identity by pointer.
                if Arc::as_ptr(cached_data) == Arc::as_ptr(data) {
                    return view.clone();
                }
            }
        }

        let view = self.create_3d_texture(data, size, label);
        let mut cache = self.lut_texture_cache.lock().unwrap();
        cache.insert(key, (data.clone(), view.clone()));
        view
    }

    fn create_3d_texture(&self, data: &[f32], size: usize, label: &str) -> wgpu::TextureView {
        let texture_size = wgpu::Extent3d {
            width: size as u32,
            height: size as u32,
            depth_or_array_layers: size as u32,
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let data_bytes: &[u8] = bytemuck::cast_slice(data);

        self.queue.write_texture(
            texture.as_image_copy(),
            data_bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size as u32 * 16),
                rows_per_image: Some(size as u32),
            },
            texture_size,
        );
        texture.create_view(&wgpu::TextureViewDescriptor::default())
    }
}
