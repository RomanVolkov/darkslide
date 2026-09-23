use darkslide_core::filters::{apply_rotation, calculate_histogram};
use darkslide_core::types::ProcessedImage;

#[test]
fn test_rotation() {
    let img = ProcessedImage {
        width: 2,
        height: 1,
        rgba: vec![255, 0, 0, 255, 0, 255, 0, 255].into(),
    };
    let rotated = apply_rotation(img.clone(), 90);
    assert_eq!(rotated.width, 1);
    assert_eq!(rotated.height, 2);

    let unrotated = apply_rotation(img.clone(), 0);
    assert_eq!(unrotated.width, 2);
    assert_eq!(unrotated.height, 1);
}

#[test]
fn test_calculate_histogram() {
    let pixels = vec![
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
    ];
    let hist = calculate_histogram(&pixels);
    assert_eq!(hist.len(), 1024);
}

#[test]
fn test_calculate_histogram_subsampled_consistency() {
    let total_pixels = 100_000;
    let mut pixels = Vec::with_capacity(total_pixels * 4);
    for i in 0..total_pixels {
        let v = (i % 256) as u8;
        pixels.extend_from_slice(&[v, (255 - v), 128, 255]);
    }

    let hist = calculate_histogram(&pixels);
    assert_eq!(hist.len(), 1024);

    let red_sum: u32 = hist[0..256].iter().sum();
    let green_sum: u32 = hist[256..512].iter().sum();
    let blue_sum: u32 = hist[512..768].iter().sum();
    let luma_sum: u32 = hist[768..1024].iter().sum();

    assert!(red_sum > 0);
    assert!(green_sum > 0);
    assert!(blue_sum > 0);
    assert!(luma_sum > 0);

    let diff = (red_sum as i64 - green_sum as i64).abs();
    assert!(diff < 500);
}
