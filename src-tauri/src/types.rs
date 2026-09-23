use std::{collections::HashMap, sync::Arc, sync::Mutex};

use darkslide_core::types::ProcessedImage;
use lru::LruCache;


pub const BASE_IMAGES_CACHE_CAPACITY: usize = 16;
pub const THUMBNAILS_CACHE_CAPACITY: usize = 500;
pub const EXIF_CACHE_CAPACITY: usize = 200;

pub type LutCache = Arc<Mutex<HashMap<u32, (Arc<Vec<f32>>, usize)>>>;

pub struct AppState {
    pub base_images: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    pub base_images_cache: Arc<Mutex<LruCache<String, ProcessedImage>>>,
    pub thumbnails: Arc<Mutex<LruCache<String, Vec<u8>>>>,
    pub lut_cache: LutCache,
    pub exif_cache: Arc<Mutex<LruCache<String, Vec<u8>>>>,
    pub db_instance: Arc<crate::db::Db>,
    pub gpu: Arc<darkslide_core::GpuState>,
    pub active_image_id: Arc<Mutex<Option<uuid::Uuid>>>,
}

#[derive(serde::Serialize, Clone)]
pub struct LoadProgress {
    pub done: usize,
    pub total: usize,
}
