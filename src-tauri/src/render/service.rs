use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use darkslide_core::GpuState;
use darkslide_core::Lut3d;
use darkslide_core::PREVIEW_MAX_DIM;
use darkslide_core::THUMBNAIL_MAX_DIM;
use darkslide_core::filters::calculate_histogram;
use darkslide_core::pipeline::render_gpu;
use darkslide_core::types::{Adjustments, ProcessedImage};
use rayon::prelude::*;

use crate::render::loader::load_or_decode_image;
use crate::types::AppState;

pub static THUMBNAIL_POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_sub(2)
        .max(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("thumb-worker-{i}"))
        .build()
        .expect("failed to create thumbnail rayon thread pool")
});

pub const FAST_THUMBNAIL_MAX_DIM: u32 = 160;

#[derive(Clone, Debug)]
pub struct ThumbnailRequest {
    pub id: uuid::Uuid,
    pub adjustments: Adjustments,
    pub quality: Option<String>,
    pub max_dim: u32,
}

pub fn thumbnail_cache_key_with_quality(
    id: uuid::Uuid,
    adjustments: &Adjustments,
    quality: Option<&str>,
    max_dim: u32,
) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    adjustments.hash(&mut hasher);
    quality.hash(&mut hasher);
    max_dim.hash(&mut hasher);
    format!(
        "{}:{}:{}:{:016x}",
        id,
        quality.unwrap_or("hq"),
        max_dim,
        hasher.finish()
    )
}

pub fn thumbnail_cache_key(id: uuid::Uuid, adjustments: &Adjustments) -> String {
    thumbnail_cache_key_with_quality(id, adjustments, None, THUMBNAIL_MAX_DIM)
}

pub fn pack_single_thumbnail(img: &ProcessedImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + img.rgba.len());
    buf.extend_from_slice(&img.width.to_le_bytes());
    buf.extend_from_slice(&img.height.to_le_bytes());
    buf.extend_from_slice(&img.rgba);
    buf
}

pub fn prefetch_previews(ids: Vec<uuid::Uuid>, state: &AppState) {
    let base_images = state.base_images.clone();
    let base_images_cache = state.base_images_cache.clone();

    tauri::async_runtime::spawn(async move {
        for id in ids {
            let id_str = id.to_string();
            let already_cached = {
                let cache = base_images_cache.lock().unwrap();
                cache.contains(&id_str)
            };
            if already_cached {
                continue;
            }

            let bi = base_images.clone();
            let bic = base_images_cache.clone();

            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = load_or_decode_image(&id, bi, bic, Some(PREVIEW_MAX_DIM));
            })
            .await;
        }
    });
}

pub fn pack_thumbnails_batch(thumbnails: Vec<Vec<u8>>) -> Vec<u8> {
    let total_size = thumbnails.iter().map(|t| t.len()).sum::<usize>() + 4;
    let mut payload = Vec::with_capacity(total_size);
    payload.extend_from_slice(&(thumbnails.len() as u32).to_le_bytes());
    for thumbnail in thumbnails {
        payload.extend_from_slice(&thumbnail);
    }
    payload
}

pub async fn resolve_lut(
    lut_id: Option<u32>,
    lut_intensity: u32,
    lut_cache: &crate::types::LutCache,
    db_instance: &Arc<crate::db::Db>,
) -> Result<Option<Lut3d>, String> {
    match lut_id {
        Some(id) => {
            let cached = {
                let lock = lut_cache.lock().unwrap();
                lock.get(&id).cloned()
            };

            let lut_tuple = if let Some(cached_lut) = cached {
                log::info!("load cached lut: {}", id);
                Some(cached_lut)
            } else {
                let lookup = db_instance.load_lut(id).await?.map(|l| (Arc::new(l.values), l.size));
                if let Some(ref values) = lookup {
                    let mut lock = lut_cache.lock().unwrap();
                    lock.insert(id, values.clone());
                }
                lookup
            };

            Ok(lut_tuple.map(|(data, size)| Lut3d::from_arc(data, size, lut_intensity as f32 / 100.0)))
        }
        None => Ok(None),
    }
}

pub fn render_image_direct(
    img: &ProcessedImage,
    adjustments: &Adjustments,
    gpu: &GpuState,
    lut: Option<Lut3d>,
) -> ProcessedImage {
    render_gpu(img, adjustments, gpu, lut)
}

pub async fn render_image(
    id: uuid::Uuid,
    adjustments: &Adjustments,
    max_size: Option<u32>,
    update_db: bool,
    state: &AppState,
) -> Result<ProcessedImage, String> {
    let lut = resolve_lut(
        adjustments.lut_id,
        adjustments.lut_intensity,
        &state.lut_cache,
        &state.db_instance,
    )
    .await?;

    if max_size == Some(PREVIEW_MAX_DIM)
        && let Some(active) = *state.active_image_id.lock().unwrap()
        && active != id
    {
        return Err("cancelled".to_string());
    }

    let base_images = state.base_images.clone();
    let base_images_cache = state.base_images_cache.clone();
    let img = tauri::async_runtime::spawn_blocking(move || {
        load_or_decode_image(
            &id,
            base_images,
            base_images_cache,
            max_size,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    if max_size == Some(PREVIEW_MAX_DIM)
        && let Some(active) = *state.active_image_id.lock().unwrap()
        && active != id
    {
        return Err("cancelled".to_string());
    }

    let result = render_image_direct(&img, adjustments, &state.gpu, lut);

    if update_db
        && let Err(err) = state.db_instance.update_adjustments(id, adjustments).await
    {
        log::error!("failed to save adjustments: {}", err);
    }

    Ok(result)
}

pub async fn render_preview(
    id: uuid::Uuid,
    adjustments: &Adjustments,
    state: &AppState,
) -> Result<Vec<u8>, String> {
    if let Some(active) = *state.active_image_id.lock().unwrap()
        && active != id
    {
        return Err("cancelled".to_string());
    }

    let img = render_image(id, adjustments, Some(PREVIEW_MAX_DIM), true, state).await?;

    if let Some(active) = *state.active_image_id.lock().unwrap()
        && active != id
    {
        return Err("cancelled".to_string());
    }

    let histogram = calculate_histogram(&img.rgba);

    let mut buf = Vec::with_capacity(8 + img.rgba.len() + histogram.len() * 4);
    buf.extend_from_slice(&img.width.to_le_bytes());
    buf.extend_from_slice(&img.height.to_le_bytes());
    buf.extend_from_slice(&img.rgba);
    buf.extend_from_slice(bytemuck::cast_slice(&*histogram));

    Ok(buf)
}

pub async fn render_thumbnail(
    id: uuid::Uuid,
    adjustments: &Adjustments,
    state: &AppState,
) -> Result<Vec<u8>, String> {
    let cache_key = thumbnail_cache_key(id, adjustments);

    {
        let mut thumb_lock = state.thumbnails.lock().unwrap();
        if let Some(cached) = thumb_lock.get(&cache_key) {
            log::info!("thumbnail raw cache hit for {}", id);
            return Ok(cached.clone());
        }
    }

    let img = render_image(id, adjustments, Some(THUMBNAIL_MAX_DIM), false, state).await?;
    let buf = pack_single_thumbnail(&img);

    {
        let mut thumb_lock = state.thumbnails.lock().unwrap();
        thumb_lock.put(cache_key, buf.clone());
    }

    Ok(buf)
}

pub async fn render_thumbnails(
    items: &[(uuid::Uuid, Adjustments)],
    state: &AppState,
) -> Result<Vec<Vec<u8>>, String> {
    let requests: Vec<ThumbnailRequest> = items
        .iter()
        .map(|(id, adj)| ThumbnailRequest {
            id: *id,
            adjustments: adj.clone(),
            quality: None,
            max_dim: THUMBNAIL_MAX_DIM,
        })
        .collect();
    render_thumbnails_tiered(&requests, state).await
}

pub async fn render_thumbnails_tiered(
    items: &[ThumbnailRequest],
    state: &AppState,
) -> Result<Vec<Vec<u8>>, String> {
    if items.is_empty() {
        return Ok(vec![]);
    }

    let mut results: Vec<Vec<u8>> = vec![Vec::new(); items.len()];
    let mut missing_indices: Vec<usize> = Vec::new();
    let mut missing_keys: Vec<String> = Vec::new();

    {
        let mut thumb_lock = state.thumbnails.lock().unwrap();
        for (i, req) in items.iter().enumerate() {
            let key = thumbnail_cache_key_with_quality(
                req.id,
                &req.adjustments,
                req.quality.as_deref(),
                req.max_dim,
            );
            if let Some(cached) = thumb_lock.get(&key) {
                log::info!("thumbnail raw cache hit for {}", req.id);
                results[i] = cached.clone();
            } else {
                missing_indices.push(i);
                missing_keys.push(key);
            }
        }
    }

    if missing_indices.is_empty() {
        return Ok(results);
    }

    let mut resolved_luts: HashMap<(Option<u32>, u32), Option<Lut3d>> = HashMap::new();
    for &idx in &missing_indices {
        let req = &items[idx];
        let lut_key = (req.adjustments.lut_id, req.adjustments.lut_intensity);
        if !resolved_luts.contains_key(&lut_key) {
            let lut = resolve_lut(
                req.adjustments.lut_id,
                req.adjustments.lut_intensity,
                &state.lut_cache,
                &state.db_instance,
            )
            .await?;
            resolved_luts.insert(lut_key, lut);
        }
    }

    let luts: Vec<Option<Lut3d>> = missing_indices
        .iter()
        .map(|&idx| {
            let req = &items[idx];
            resolved_luts
                .get(&(req.adjustments.lut_id, req.adjustments.lut_intensity))
                .cloned()
                .flatten()
        })
        .collect();

    let base_images = state.base_images.clone();
    let base_images_cache = state.base_images_cache.clone();

    let missing_items: Vec<_> = missing_indices
        .iter()
        .map(|&idx| items[idx].clone())
        .collect();

    let gpu = state.gpu.clone();
    let missing_keys_clone = missing_keys.clone();
    let missing_indices_clone = missing_indices.clone();

    let (rendered_entries, rendered_to_cache) = tauri::async_runtime::spawn_blocking(move || {
        let decoded_images: Vec<Result<ProcessedImage, String>> = THUMBNAIL_POOL.install(|| {
            missing_items
                .par_iter()
                .map(|req| {
                    let fast_only = req.quality.as_deref() == Some("fast");
                    let dim = req.max_dim;
                    super::loader::load_or_decode_image_with_quality(
                        &req.id,
                        base_images.clone(),
                        base_images_cache.clone(),
                        Some(dim),
                        fast_only,
                    )
                })
                .collect()
        });

        let mut entries = Vec::with_capacity(missing_indices_clone.len());
        let mut to_cache = Vec::with_capacity(missing_indices_clone.len());
        let mut batch_items = Vec::new();
        let mut batch_meta = Vec::new();

        for (k, &orig_idx) in missing_indices_clone.iter().enumerate() {
            let req = &missing_items[k];
            let lut = luts[k].clone();
            let key = missing_keys_clone[k].clone();

            match &decoded_images[k] {
                Ok(img) => {
                    batch_items.push((img.clone(), req.adjustments.clone(), lut));
                    batch_meta.push((orig_idx, key));
                }
                Err(e) => {
                    log::error!("failed to load image for thumbnail: {}", e);
                    let packed = pack_single_thumbnail(&ProcessedImage::new(1, 1, vec![0, 0, 0, 0]));
                    entries.push((orig_idx, packed.clone()));
                    to_cache.push((key, packed));
                }
            }
        }

        if !batch_items.is_empty() {
            let receivers = darkslide_core::pipeline::render_gpu_batch(batch_items, &gpu);
            for ((orig_idx, key), rx) in batch_meta.into_iter().zip(receivers) {
                let rendered = match rx.recv() {
                    Ok(img) => img,
                    Err(_) => ProcessedImage::new(1, 1, vec![0, 0, 0, 0]),
                };
                let packed = pack_single_thumbnail(&rendered);
                entries.push((orig_idx, packed.clone()));
                to_cache.push((key, packed));
            }
        }

        (entries, to_cache)
    })
    .await
    .map_err(|e| e.to_string())?;

    for (orig_idx, packed) in rendered_entries {
        results[orig_idx] = packed;
    }

    {
        let mut thumb_lock = state.thumbnails.lock().unwrap();
        for (key, buf) in rendered_to_cache {
            thumb_lock.put(key, buf);
        }
    }

    Ok(results)
}
