use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use darkslide_core::types::ProcessedImage;
use lru::LruCache;

pub fn load_or_decode_image(
    id: &uuid::Uuid,
    base_images: Arc<Mutex<HashMap<String, PathBuf>>>,
    base_images_cache: Arc<Mutex<LruCache<String, ProcessedImage>>>,
    max_size: Option<u32>,
) -> Result<ProcessedImage, String> {
    load_or_decode_image_with_quality(id, base_images, base_images_cache, max_size, false)
}

pub fn load_or_decode_image_with_quality(
    id: &uuid::Uuid,
    base_images: Arc<Mutex<HashMap<String, PathBuf>>>,
    base_images_cache: Arc<Mutex<LruCache<String, ProcessedImage>>>,
    max_size: Option<u32>,
    fast_only: bool,
) -> Result<ProcessedImage, String> {
    let id_str = id.to_string();

    if let Some(cached) = {
        let mut cache_lock = base_images_cache.lock().unwrap();
        cache_lock.get(&id_str).cloned()
    } {
        return Ok(match max_size {
            Some(max_dim) => resize_image(&cached, max_dim),
            None => cached,
        });
    }

    let base = {
        let bases_lock = base_images.lock().unwrap();
        bases_lock
            .get(&id_str)
            .ok_or("unknown image id")?
            .to_owned()
    };

    let raw = std::fs::read(base.as_path()).map_err(|e| e.to_string())?;
    let decoded = darkslide_core::decode_image_with_size_and_quality(&raw, max_size, fast_only)?;

    if max_size.unwrap_or(darkslide_core::PREVIEW_MAX_DIM) >= darkslide_core::PREVIEW_MAX_DIM {
        let mut cache_lock = base_images_cache.lock().unwrap();
        cache_lock.put(id_str, decoded.clone());
    }

    Ok(decoded)
}

/// Resize a ProcessedImage so its largest dimension does not exceed `max_dim` using SIMD.
pub fn resize_image(img: &ProcessedImage, max_dim: u32) -> ProcessedImage {
    darkslide_core::codec::fast_resize(img.clone(), max_dim).unwrap_or_else(|_| img.clone())
}
