use crate::types::{ImageType, PngCompressionLevel, ProcessedImage};
use image::ImageEncoder;
use std::io::Cursor;

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, Resizer};
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

pub const PREVIEW_MAX_DIM: u32 = 2000;
pub const THUMBNAIL_MAX_DIM: u32 = 400;

/// File extensions accepted as input images (decodable via `decode_image`,
/// with HEIC/HEIF handled by the platform fallback).
pub const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "tiff", "tif", "webp", "bmp", "heic", "heif",
];

pub fn is_supported_image_extension(ext: &str) -> bool {
    SUPPORTED_IMAGE_EXTENSIONS
        .iter()
        .any(|e| e.eq_ignore_ascii_case(ext))
}

/// Fast SIMD image resizing using NEON/AVX2.
///
/// Takes ownership of `src` so that, when the underlying `Arc` is uniquely held,
/// the source buffer can be borrowed by the resizer instead of copied.
pub fn fast_resize(src: ProcessedImage, max_dim: u32) -> Result<ProcessedImage, String> {
    if src.width <= max_dim && src.height <= max_dim {
        return Ok(src);
    }

    let aspect = src.width as f32 / src.height as f32;
    let (dst_w, dst_h) = if src.width >= src.height {
        (
            max_dim,
            ((max_dim as f32 / aspect).round() as u32).max(1),
        )
    } else {
        (
            ((max_dim as f32 * aspect).round() as u32).max(1),
            max_dim,
        )
    };

    let src_image = ImageRef::new(src.width, src.height, &src.rgba, PixelType::U8x4)
        .map_err(|e| format!("{:?}", e))?;
    let mut dst_image = Image::new(dst_w, dst_h, PixelType::U8x4);

    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src_image,
            &mut dst_image,
            &fast_image_resize::ResizeOptions::new()
                .resize_alg(ResizeAlg::Convolution(FilterType::Bilinear)),
        )
        .map_err(|e| format!("{:?}", e))?;

    Ok(ProcessedImage {
        width: dst_w,
        height: dst_h,
        rgba: dst_image.into_vec().into(),
    })
}

fn decode_jpeg_simd(bytes: &[u8]) -> Result<ProcessedImage, String> {
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(Cursor::new(bytes), options);
    let pixels = decoder.decode().map_err(|e| format!("{:?}", e))?;
    let (width, height) = decoder.dimensions().ok_or("Invalid JPEG dimensions")?;
    Ok(ProcessedImage {
        width: width as u32,
        height: height as u32,
        rgba: pixels.into(),
    })
}

fn decode_png_simd(bytes: &[u8]) -> Result<ProcessedImage, String> {
    use zune_png::PngDecoder;

    let mut decoder = PngDecoder::new(Cursor::new(bytes));
    let pixels = decoder.decode_raw().map_err(|e| format!("{:?}", e))?;
    let (width, height) = decoder.dimensions().ok_or("Invalid PNG dimensions")?;
    let colorspace = decoder.colorspace().ok_or("Unknown PNG colorspace")?;
    let rgba = match colorspace {
        zune_png::zune_core::colorspace::ColorSpace::RGBA => pixels,
        zune_png::zune_core::colorspace::ColorSpace::RGB => {
            let mut out = Vec::with_capacity(width * height * 4);
            for chunk in pixels.chunks_exact(3) {
                out.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
            out
        }
        _ => return Err("Unsupported PNG format".to_string()),
    };

    Ok(ProcessedImage {
        width: width as u32,
        height: height as u32,
        rgba: rgba.into(),
    })
}

#[cfg(target_os = "macos")]
pub use macos_decoder::{decode_macos_thumbnail, decode_macos_thumbnail_always, decode_macos_thumbnail_fast};

#[cfg(target_os = "macos")]
pub mod macos_decoder {
    use std::ffi::c_void;
    use crate::types::ProcessedImage;

    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[link(name = "ImageIO", kind = "framework")]
    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CGDataProviderCreateWithData(
            info: *mut c_void,
            data: *const u8,
            size: usize,
            releaseData: *mut c_void,
        ) -> *mut c_void;
        fn CGImageSourceCreateWithDataProvider(
            provider: *mut c_void,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageSourceCreateImageAtIndex(
            isrc: *mut c_void,
            index: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageSourceCreateThumbnailAtIndex(
            isrc: *mut c_void,
            index: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGBitmapContextCreate(
            data: *mut u8,
            width: usize,
            height: usize,
            bitsPerComponent: usize,
            bytesPerRow: usize,
            space: *mut c_void,
            bitmapInfo: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(
            context: *mut c_void,
            rect: CGRect,
            image: *mut c_void,
        );
        fn CGContextRelease(context: *mut c_void);
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGDataProviderRelease(provider: *mut c_void);
        fn CGImageRelease(image: *mut c_void);
        fn CFRelease(cf: *mut c_void);

        static kCGImageSourceCreateThumbnailWithTransform: *const c_void;
        static kCGImageSourceCreateThumbnailFromImageAlways: *const c_void;
        static kCGImageSourceThumbnailMaxPixelSize: *const c_void;
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;

        fn CFNumberCreate(
            allocator: *const c_void,
            the_type: isize,
            value_ptr: *const c_void,
        ) -> *mut c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *mut c_void;
    }

    const K_CG_IMAGE_ALPHA_PREMULTIPLIED_LAST: u32 = 1;
    const K_CGBITMAP_BYTE_ORDER_32_BIG: u32 = 4 << 12;

    unsafe fn cg_image_to_processed_image(cg_img: *mut c_void) -> Result<ProcessedImage, String> {
        unsafe {
            let width = CGImageGetWidth(cg_img);
            let height = CGImageGetHeight(cg_img);
            if width == 0 || height == 0 {
                CGImageRelease(cg_img);
                return Err("Invalid image dimensions from CGImage".to_string());
            }

            let mut rgba = vec![0u8; width * height * 4];
            let color_space = CGColorSpaceCreateDeviceRGB();
            let bitmap_info = K_CG_IMAGE_ALPHA_PREMULTIPLIED_LAST | K_CGBITMAP_BYTE_ORDER_32_BIG;

            let ctx = CGBitmapContextCreate(
                rgba.as_mut_ptr(),
                width,
                height,
                8,
                width * 4,
                color_space,
                bitmap_info,
            );
            CGColorSpaceRelease(color_space);

            if ctx.is_null() {
                CGImageRelease(cg_img);
                return Err("Failed to create CGBitmapContext".to_string());
            }

            let rect = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: width as f64,
                    height: height as f64,
                },
            };

            CGContextDrawImage(ctx, rect, cg_img);
            CGContextRelease(ctx);
            CGImageRelease(cg_img);

            Ok(ProcessedImage {
                width: width as u32,
                height: height as u32,
                rgba: rgba.into(),
            })
        }
    }

    pub fn decode_macos_native(bytes: &[u8]) -> Result<ProcessedImage, String> {
        unsafe {
            let provider = CGDataProviderCreateWithData(
                std::ptr::null_mut(),
                bytes.as_ptr(),
                bytes.len(),
                std::ptr::null_mut(),
            );
            if provider.is_null() {
                return Err("Failed to create CGDataProvider".to_string());
            }

            let src = CGImageSourceCreateWithDataProvider(provider, std::ptr::null());
            CGDataProviderRelease(provider);
            if src.is_null() {
                return Err("Failed to create CGImageSource".to_string());
            }

            let keys = [
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceCreateThumbnailFromImageAlways,
            ];
            let values = [
                kCFBooleanTrue,
                kCFBooleanTrue,
            ];

            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                2,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            );

            let cg_img = if !options.is_null() {
                let img = CGImageSourceCreateThumbnailAtIndex(src, 0, options);
                CFRelease(options);
                img
            } else {
                CGImageSourceCreateImageAtIndex(src, 0, std::ptr::null())
            };
            CFRelease(src);
            if cg_img.is_null() {
                return Err("Failed to decode image with CGImageSource".to_string());
            }

            cg_image_to_processed_image(cg_img)
        }
    }

    pub fn decode_macos_thumbnail(bytes: &[u8], max_dim: u32) -> Result<ProcessedImage, String> {
        decode_macos_thumbnail_always(bytes, max_dim)
    }

    pub fn decode_macos_thumbnail_always(bytes: &[u8], max_dim: u32) -> Result<ProcessedImage, String> {
        unsafe {
            let provider = CGDataProviderCreateWithData(
                std::ptr::null_mut(),
                bytes.as_ptr(),
                bytes.len(),
                std::ptr::null_mut(),
            );
            if provider.is_null() {
                return Err("Failed to create CGDataProvider".to_string());
            }

            let src = CGImageSourceCreateWithDataProvider(provider, std::ptr::null());
            CGDataProviderRelease(provider);
            if src.is_null() {
                return Err("Failed to create CGImageSource".to_string());
            }

            let num_val = max_dim as i32;
            let num_ref = CFNumberCreate(std::ptr::null(), 3, &num_val as *const _ as *const c_void);
            if num_ref.is_null() {
                CFRelease(src);
                return Err("Failed to create CFNumber".to_string());
            }

            let keys = [
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceThumbnailMaxPixelSize,
            ];
            let values = [
                kCFBooleanTrue,
                kCFBooleanTrue,
                num_ref as *const c_void,
            ];

            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                3,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            );
            CFRelease(num_ref);

            if options.is_null() {
                CFRelease(src);
                return Err("Failed to create CFDictionary".to_string());
            }

            let cg_img = CGImageSourceCreateThumbnailAtIndex(src, 0, options);
            CFRelease(options);
            CFRelease(src);

            if cg_img.is_null() {
                return Err("Failed to create thumbnail with CGImageSource".to_string());
            }

            cg_image_to_processed_image(cg_img)
        }
    }

    pub fn decode_macos_thumbnail_fast(bytes: &[u8], max_dim: u32) -> Result<ProcessedImage, String> {
        unsafe {
            let provider = CGDataProviderCreateWithData(
                std::ptr::null_mut(),
                bytes.as_ptr(),
                bytes.len(),
                std::ptr::null_mut(),
            );
            if provider.is_null() {
                return Err("Failed to create CGDataProvider".to_string());
            }

            let src = CGImageSourceCreateWithDataProvider(provider, std::ptr::null());
            CGDataProviderRelease(provider);
            if src.is_null() {
                return Err("Failed to create CGImageSource".to_string());
            }

            let num_val = max_dim as i32;
            let num_ref = CFNumberCreate(std::ptr::null(), 3, &num_val as *const _ as *const c_void);
            if num_ref.is_null() {
                CFRelease(src);
                return Err("Failed to create CFNumber".to_string());
            }

            let keys_if_present = [
                kCGImageSourceCreateThumbnailWithTransform,
                kCGImageSourceThumbnailMaxPixelSize,
            ];
            let values_if_present = [
                kCFBooleanTrue,
                num_ref as *const c_void,
            ];

            let options_if_present = CFDictionaryCreate(
                std::ptr::null(),
                keys_if_present.as_ptr(),
                values_if_present.as_ptr(),
                2,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            );
            CFRelease(num_ref);

            let cg_img = if !options_if_present.is_null() {
                let img = CGImageSourceCreateThumbnailAtIndex(src, 0, options_if_present);
                CFRelease(options_if_present);
                img
            } else {
                std::ptr::null_mut()
            };

            CFRelease(src);

            if !cg_img.is_null() {
                return cg_image_to_processed_image(cg_img);
            }

            decode_macos_thumbnail_always(bytes, max_dim)
        }
    }
}

pub fn decode_image_with_size_and_quality(
    bytes: &[u8],
    target_max_dim: Option<u32>,
    fast_only: bool,
) -> Result<ProcessedImage, String> {
    let target_dim = target_max_dim.unwrap_or(PREVIEW_MAX_DIM);

    if fast_only && target_dim <= THUMBNAIL_MAX_DIM {
        if let Some(thumb) = crate::exif::extract_embedded_jpeg_thumbnail_with_dims(bytes) {
            if thumb.width >= 120 && thumb.height >= 90 {
                if let Ok(mut decoded) = decode_jpeg_simd(&thumb.data) {
                    if let Some(rot) = crate::exif::orientation(bytes).filter(|&r| r > 0) {
                        decoded = crate::filters::apply_rotation(decoded, rot as u32);
                    }
                    return fast_resize(decoded, target_dim);
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(decoded) = macos_decoder::decode_macos_thumbnail_fast(bytes, target_dim) {
                return fast_resize(decoded, target_dim);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(decoded) = macos_decoder::decode_macos_thumbnail_always(bytes, target_dim) {
            return fast_resize(decoded, target_dim);
        }
    }

    if bytes.starts_with(&[0xFF, 0xD8]) {
        if let Ok(mut decoded) = decode_jpeg_simd(bytes) {
            if let Some(rot) = crate::exif::orientation(bytes).filter(|&r| r > 0) {
                decoded = crate::filters::apply_rotation(decoded, rot as u32);
            }
            return fast_resize(decoded, target_dim);
        }
    }

    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if let Ok(decoded) = decode_png_simd(bytes) {
            return fast_resize(decoded, target_dim);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(decoded) = macos_decoder::decode_macos_native(bytes) {
            return fast_resize(decoded, target_dim);
        }
    }

    let img = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;

    let rgba = img.into_rgba8();
    let mut processed = ProcessedImage {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw().into(),
    };
    if let Some(rot) = crate::exif::orientation(bytes).filter(|&r| r > 0) {
        processed = crate::filters::apply_rotation(processed, rot as u32);
    }

    fast_resize(processed, target_dim)
}

pub fn decode_image_with_size(
    bytes: &[u8],
    target_max_dim: Option<u32>,
) -> Result<ProcessedImage, String> {
    decode_image_with_size_and_quality(bytes, target_max_dim, false)
}

/// Decode raw image file bytes into a thumbnail/preview RGBA image.
pub fn decode_image(bytes: &[u8]) -> Result<ProcessedImage, String> {
    decode_image_with_size(bytes, Some(PREVIEW_MAX_DIM))
}

pub fn encode(img: &ProcessedImage, into: ImageType) -> Result<Vec<u8>, String> {
    let (width, height) = (img.width, img.height);
    let mut buf = Vec::new();

    match into {
        ImageType::PNG(compression_level) => {
            let compression = match compression_level {
                PngCompressionLevel::Fast => image::codecs::png::CompressionType::Fast,
                PngCompressionLevel::Default => image::codecs::png::CompressionType::Default,
                PngCompressionLevel::Best => image::codecs::png::CompressionType::Best,
            };

            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                &mut buf,
                compression,
                image::codecs::png::FilterType::Adaptive,
            );
            encoder
                .write_image(
                    &img.rgba,
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
        ImageType::JPG(quality) => {
            let encoder = jpeg_encoder::Encoder::new(&mut buf, quality);
            encoder
                .encode(
                    &img.rgba,
                    width as u16,
                    height as u16,
                    jpeg_encoder::ColorType::Rgba,
                )
                .map_err(|e| e.to_string())?;
        }
        ImageType::TIFF => {
            let encoder = image::codecs::tiff::TiffEncoder::new(Cursor::new(&mut buf));
            encoder
                .write_image(
                    &img.rgba,
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
        ImageType::WEBP => {
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut buf);
            encoder
                .encode(
                    &img.rgba,
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(buf)
}
