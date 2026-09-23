use crate::color::lut;
use crate::filters;
use crate::gpu::{GpuRenderJob, GpuState, Lut3d};
use crate::types::{Adjustments, ProcessedImage};
use std::sync::mpsc;

pub const INTERNAL_LUT_SIZE: usize = 17;

pub trait LutProvider {
    fn fetch_lut(&self, id: u32) -> Option<(Vec<f32>, usize)>;
}

pub fn apply_cpu_filters(img: ProcessedImage, adj: &Adjustments) -> ProcessedImage {
    filters::apply_rotation(img, adj.rotation)
}

pub fn render_gpu(
    base: &ProcessedImage,
    adj: &Adjustments,
    gpu: &GpuState,
    external_lut: Option<Lut3d>,
) -> ProcessedImage {
    let lut_size: usize = INTERNAL_LUT_SIZE;
    let luts_3d = lut::build_3d_luts(adj, lut_size);
    let internal_lut = Lut3d::new(luts_3d, lut_size, 1.0);

    let external_lut = match external_lut {
        Some(mut lut) => {
            lut.intensity = adj.lut_intensity as f32 / 100.0;
            lut
        }
        None => Lut3d::from_arc(lut::identity_3d_lut_2_arc(), 2, 0.0),
    };

    let (out_w, out_h) = crate::gpu::geometry_output_size(base.width, base.height, &adj.geometry);

    let pixels = gpu.render_single(
        base.rgba.clone(),
        base.width,
        base.height,
        internal_lut,
        external_lut,
        &adj.detail,
        &adj.geometry,
    );

    let img = ProcessedImage {
        width: out_w,
        height: out_h,
        rgba: pixels.into(),
    };

    apply_cpu_filters(img, adj)
}

/// Render multiple images through the GPU in one batch, then apply CPU filters as each
/// GPU readback completes.
///
/// Returns one receiver per input item in the same order. The GPU work is submitted once,
/// and CPU post-processing (texture, clarity, sharpen, grain, rotation) runs in parallel
/// threads as soon as each raw result is available, so the GPU is not blocked waiting for
/// CPU filters on the previous image.
use std::sync::LazyLock;

pub static BATCH_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("batch-worker-{i}"))
        .build()
        .expect("failed to create pipeline batch rayon thread pool")
});

pub fn render_gpu_batch(
    items: Vec<(ProcessedImage, Adjustments, Option<Lut3d>)>,
    gpu: &GpuState,
) -> Vec<mpsc::Receiver<ProcessedImage>> {
    let lut_size: usize = INTERNAL_LUT_SIZE;
    let mut jobs = Vec::with_capacity(items.len());
    let mut receivers = Vec::with_capacity(items.len());
    let mut tasks = Vec::with_capacity(items.len());

    for (base, adj, external_lut) in items {
        let luts_3d = lut::build_3d_luts(&adj, lut_size);
        let internal_lut = Lut3d::new(luts_3d, lut_size, 1.0);

        let external_lut = match external_lut {
            Some(mut lut) => {
                lut.intensity = adj.lut_intensity as f32 / 100.0;
                lut
            }
            None => Lut3d::from_arc(lut::identity_3d_lut_2_arc(), 2, 0.0),
        };

        let (gpu_tx, gpu_rx) = mpsc::channel::<Vec<u8>>();
        let (result_tx, result_rx) = mpsc::channel::<ProcessedImage>();

        jobs.push(GpuRenderJob {
            input: base.rgba.clone(),
            width: base.width,
            height: base.height,
            internal_lut,
            external_lut,
            detail: adj.detail.clone(),
            geometry: adj.geometry,
            result_tx: gpu_tx,
        });

        let (out_w, out_h) = crate::gpu::geometry_output_size(base.width, base.height, &adj.geometry);
        tasks.push((gpu_rx, result_tx, out_w, out_h, adj));
        receivers.push(result_rx);
    }

    gpu.render_batch(jobs);

    for (gpu_rx, result_tx, width, height, adj) in tasks {
        BATCH_POOL.spawn(move || {
            let pixels = match gpu_rx.recv() {
                Ok(p) => p,
                Err(_) => {
                    let _ = result_tx.send(ProcessedImage::new(width, height, vec![]));
                    return;
                }
            };

            let img = ProcessedImage {
                width,
                height,
                rgba: pixels.into(),
            };

            let _ = result_tx.send(apply_cpu_filters(img, &adj));
        });
    }

    receivers
}
