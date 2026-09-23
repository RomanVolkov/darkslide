pub mod codec;
pub mod color;
pub mod exif;
pub mod filters;
pub mod gpu;
pub mod pipeline;
pub mod types;

// Re-exports for convenient domain access and backward compatibility
pub use codec::{
    decode_image, decode_image_with_size, decode_image_with_size_and_quality, encode,
    is_supported_image_extension, PREVIEW_MAX_DIM, SUPPORTED_IMAGE_EXTENSIONS, THUMBNAIL_MAX_DIM,
};
pub use color::{curve, hsl, lut};
pub use filters as tools;
pub use gpu as native;
pub use gpu::{GpuInitError, GpuState, Lut3d};
pub use pipeline::{render_gpu, LutProvider, INTERNAL_LUT_SIZE};
