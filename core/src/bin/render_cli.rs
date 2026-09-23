use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use darkslide_core::gpu::GpuState;
use darkslide_core::pipeline::{render_gpu, };
use darkslide_core::types::{Adjustments, ImageType, PngCompressionLevel};
use darkslide_core::{decode_image, encode};

fn print_usage(prog: &str) {
    eprintln!(
        r#"Darkslide Standalone Render CLI

Usage: {prog} --input <path> [options]

Options:
  -i, --input <path>               Input image path (required)
  -o, --output <path>              Output image path (default: target/rendered_output.png)
      --adjustments-json <path>    Load adjustments from a JSON file
      --exposure <f32>             Exposure adjustment (e.g. 1.0, -0.5)
      --temperature <i32>          Relative color temperature offset (default: 0)
      --tint <i32>                 Color tint (default: 0)
      --contrast <i32>             Contrast percentage (-100 to 100)
      --highlights <i32>           Highlights (-100 to 100)
      --shadows <i32>              Shadows (-100 to 100)
      --saturation <i32>           Saturation (-100 to 100)
      --rotation <u32>             Rotation in degrees (0, 90, 180, 270)
      --format <fmt>               Output format: png | jpg | webp | tiff (default: derived from output ext or png)
  -h, --help                       Print this help message
"#
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let prog = &args[0];

    if args.len() < 2 || args.iter().any(|a| a == "-h" || a == "--help") {
        print_usage(prog);
        process::exit(0);
    }

    let mut input_path: Option<PathBuf> = None;
    let mut output_path = PathBuf::from("target/rendered_output.png");
    let mut adjustments = Adjustments::default();
    let mut format_override: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-i" | "--input" => {
                i += 1;
                if i < args.len() {
                    input_path = Some(PathBuf::from(&args[i]));
                }
            }
            "-o" | "--output" => {
                i += 1;
                if i < args.len() {
                    output_path = PathBuf::from(&args[i]);
                }
            }
            "--adjustments-json" => {
                i += 1;
                if i < args.len() {
                    let content = fs::read_to_string(&args[i])
                        .unwrap_or_else(|e| panic!("Failed to read adjustments JSON {}: {e}", args[i]));
                    adjustments = serde_json::from_str(&content)
                        .unwrap_or_else(|e| panic!("Failed to parse adjustments JSON: {e}"));
                }
            }
            "--exposure" => {
                i += 1;
                if i < args.len() {
                    adjustments.light.exposure = args[i].parse().expect("Invalid exposure value");
                }
            }
            "--temperature" => {
                i += 1;
                if i < args.len() {
                    adjustments.color.temperature = args[i].parse().expect("Invalid temperature value");
                }
            }
            "--tint" => {
                i += 1;
                if i < args.len() {
                    adjustments.color.tint = args[i].parse().expect("Invalid tint value");
                }
            }
            "--contrast" => {
                i += 1;
                if i < args.len() {
                    adjustments.light.contrast = args[i].parse().expect("Invalid contrast value");
                }
            }
            "--highlights" => {
                i += 1;
                if i < args.len() {
                    adjustments.light.highlights = args[i].parse().expect("Invalid highlights value");
                }
            }
            "--shadows" => {
                i += 1;
                if i < args.len() {
                    adjustments.light.shadows = args[i].parse().expect("Invalid shadows value");
                }
            }
            "--saturation" => {
                i += 1;
                if i < args.len() {
                    adjustments.hsl.saturation = args[i].parse().expect("Invalid saturation value");
                }
            }
            "--rotation" => {
                i += 1;
                if i < args.len() {
                    adjustments.rotation = args[i].parse().expect("Invalid rotation value");
                }
            }
            "--format" => {
                i += 1;
                if i < args.len() {
                    format_override = Some(args[i].to_lowercase());
                }
            }
            other => {
                eprintln!("Unknown argument: {other}");
                print_usage(prog);
                process::exit(1);
            }
        }
        i += 1;
    }

    let input_path = input_path.unwrap_or_else(|| {
        eprintln!("Error: --input is required");
        print_usage(prog);
        process::exit(1);
    });

    println!("Reading input image: {}", input_path.display());
    let raw_bytes = fs::read(&input_path)
        .unwrap_or_else(|e| panic!("Failed to read input image {}: {e}", input_path.display()));

    println!("Decoding input image...");
    let base_image = decode_image(&raw_bytes).expect("Failed to decode image");
    println!("Base image dimensions: {}x{}", base_image.width, base_image.height);

    println!("Initializing GPU state...");
    let gpu = GpuState::init().expect("Failed to initialize GPU state");

    println!("Executing render pipeline...");
    let start_time = std::time::Instant::now();
    let rendered = render_gpu(&base_image, &adjustments, &gpu, None);
    let elapsed = start_time.elapsed();
    println!(
        "Render completed in {:.2?}ms! Rendered dimensions: {}x{}",
        elapsed.as_secs_f64() * 1000.0,
        rendered.width,
        rendered.height
    );

    let format_str = format_override.unwrap_or_else(|| {
        output_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("png")
            .to_lowercase()
    });

    let image_type = match format_str.as_str() {
        "jpg" | "jpeg" => ImageType::JPG(95),
        "webp" => ImageType::WEBP,
        "tiff" | "tif" => ImageType::TIFF,
        _ => ImageType::PNG(PngCompressionLevel::Default),
    };

    let encoded = encode(&rendered, image_type).expect("Failed to encode output image");

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).ok();
    }

    fs::write(&output_path, encoded)
        .unwrap_or_else(|e| panic!("Failed to write output image {}: {e}", output_path.display()));

    println!("Successfully saved rendered image to: {}", output_path.display());
}
