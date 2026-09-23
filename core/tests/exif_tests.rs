use darkslide_core::exif::extract_as_shot_wb;

const TAG_ORIENTATION: u16 = 0x0112;
const TAG_EXIF_IFD_POINTER: u16 = 0x8769;
const TAG_AS_SHOT_NEUTRAL: u16 = 0xC628;
const TAG_COLOR_TEMPERATURE: u16 = 0xC65A;

const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;

struct Entry {
    tag: u16,
    ty: u16,
    count: u32,
    value: [u8; 4],
}

/// Build a little-endian TIFF blob: header, one IFD0 with `entries`, next-IFD
/// terminator, then `extra` bytes (out-of-line values) appended verbatim.
fn build_tiff(entries: &[Entry], extra: &[u8]) -> Vec<u8> {
    let ifd_offset = 8u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&ifd_offset.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in entries {
        out.extend_from_slice(&e.tag.to_le_bytes());
        out.extend_from_slice(&e.ty.to_le_bytes());
        out.extend_from_slice(&e.count.to_le_bytes());
        out.extend_from_slice(&e.value);
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // next IFD offset
    out.extend_from_slice(extra);
    out
}

fn inline_short(value: u16) -> [u8; 4] {
    let mut v = [0u8; 4];
    v[0..2].copy_from_slice(&value.to_le_bytes());
    v
}

fn offset(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

#[test]
fn as_shot_neutral_is_read_and_normalized_to_green() {
    // Out-of-line value starts right after the IFD0 (8 + 2 + 12 + 4 = 26).
    let mut extra = Vec::new();
    for (num, den) in [(2u32, 1u32), (1, 1), (1, 2)] {
        extra.extend_from_slice(&num.to_le_bytes());
        extra.extend_from_slice(&den.to_le_bytes());
    }
    let entries = [Entry {
        tag: TAG_AS_SHOT_NEUTRAL,
        ty: TYPE_RATIONAL,
        count: 3,
        value: offset(26),
    }];

    let wb = extract_as_shot_wb(&build_tiff(&entries, &extra)).expect("wb present");
    assert_eq!(wb.neutral_rgb, Some([2.0, 1.0, 0.5]));
    assert_eq!(wb.kelvin, None);
}

#[test]
fn color_temperature_short_is_read() {
    let entries = [Entry {
        tag: TAG_COLOR_TEMPERATURE,
        ty: TYPE_SHORT,
        count: 1,
        value: inline_short(5500),
    }];

    let wb = extract_as_shot_wb(&build_tiff(&entries, &[])).expect("wb present");
    assert_eq!(wb.kelvin, Some(5500));
    assert_eq!(wb.neutral_rgb, None);
}

#[test]
fn no_wb_tags_returns_none() {
    let entries = [Entry {
        tag: TAG_ORIENTATION,
        ty: TYPE_SHORT,
        count: 1,
        value: inline_short(6),
    }];

    assert_eq!(extract_as_shot_wb(&build_tiff(&entries, &[])), None);
}

#[test]
fn both_tags_are_captured() {
    let mut extra = Vec::new();
    for (num, den) in [(1u32, 1u32), (1, 1), (1, 1)] {
        extra.extend_from_slice(&num.to_le_bytes());
        extra.extend_from_slice(&den.to_le_bytes());
    }
    // 2 entries -> IFD0 size = 2 + 24 + 4 = 30, so out-of-line data starts at 38.
    let entries = [
        Entry {
            tag: TAG_COLOR_TEMPERATURE,
            ty: TYPE_SHORT,
            count: 1,
            value: inline_short(4800),
        },
        Entry {
            tag: TAG_AS_SHOT_NEUTRAL,
            ty: TYPE_RATIONAL,
            count: 3,
            value: offset(38),
        },
    ];

    let wb = extract_as_shot_wb(&build_tiff(&entries, &extra)).expect("wb present");
    assert_eq!(wb.kelvin, Some(4800));
    assert_eq!(wb.neutral_rgb, Some([1.0, 1.0, 1.0]));
}

#[test]
fn color_temperature_in_exif_sub_ifd_is_read() {
    // IFD0 holds a single Exif sub-IFD pointer at offset 26; the sub-IFD (also
    // at 26) holds ColorTemperature.
    let mut layout = Vec::new();
    layout.extend_from_slice(b"II");
    layout.extend_from_slice(&42u16.to_le_bytes());
    layout.extend_from_slice(&8u32.to_le_bytes());

    // IFD0
    layout.extend_from_slice(&1u16.to_le_bytes());
    layout.extend_from_slice(&TAG_EXIF_IFD_POINTER.to_le_bytes());
    layout.extend_from_slice(&TYPE_LONG.to_le_bytes());
    layout.extend_from_slice(&1u32.to_le_bytes());
    layout.extend_from_slice(&26u32.to_le_bytes());
    layout.extend_from_slice(&0u32.to_le_bytes());

    // Exif sub-IFD
    layout.extend_from_slice(&1u16.to_le_bytes());
    layout.extend_from_slice(&TAG_COLOR_TEMPERATURE.to_le_bytes());
    layout.extend_from_slice(&TYPE_SHORT.to_le_bytes());
    layout.extend_from_slice(&1u32.to_le_bytes());
    layout.extend_from_slice(&inline_short(7000));
    layout.extend_from_slice(&0u32.to_le_bytes());

    let wb = extract_as_shot_wb(&layout).expect("wb present");
    assert_eq!(wb.kelvin, Some(7000));
}
