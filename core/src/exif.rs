// ---------------------------------------------------------------------------
// EXIF extraction helpers
// ---------------------------------------------------------------------------

/// HEIF/HEIC files are ISOBMFF: ftyp box at offset 4-7 with known brands.
pub fn is_heif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(
            &bytes[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
        )
}

/// Dispatch to the right extractor based on magic bytes.
pub fn extract_exif(bytes: &[u8], path: &str) -> Option<Vec<u8>> {
    if is_heif(bytes) {
        extract_exif_heic(path)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        extract_exif_jpeg(bytes)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        extract_exif_png(bytes)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        extract_exif_webp(bytes)
    } else {
        None
    }
}

/// Scan JPEG APP1 segments for an Exif\0\0 marker and return raw TIFF bytes.
pub fn extract_exif_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if marker == 0xE1 {
            let data_start = i + 4;
            if bytes.get(data_start..data_start + 6) == Some(b"Exif\0\0") {
                let end = i + 2 + seg_len;
                return bytes.get(data_start + 6..end).map(|s| s.to_vec());
            }
        }
        i += 2 + seg_len;
        if marker == 0xDA {
            break;
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedThumbnail {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn parse_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
            if i + 9 <= bytes.len() {
                let height = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let width = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((width, height));
            }
        }
        i += 2 + seg_len;
    }
    None
}

pub fn extract_embedded_jpeg_thumbnail_with_dims(jpeg_bytes: &[u8]) -> Option<EmbeddedThumbnail> {
    let raw = extract_embedded_jpeg_thumbnail(jpeg_bytes)?;
    let (width, height) = parse_jpeg_dimensions(&raw)?;
    Some(EmbeddedThumbnail {
        data: raw,
        width,
        height,
    })
}

/// Extract embedded JPEG thumbnail bytes from EXIF TIFF data if available.
pub fn extract_embedded_jpeg_thumbnail(jpeg_bytes: &[u8]) -> Option<Vec<u8>> {
    let mut i = 2usize;
    while i + 4 <= jpeg_bytes.len() {
        if jpeg_bytes[i] != 0xFF {
            break;
        }
        let marker = jpeg_bytes[i + 1];
        let seg_len = u16::from_be_bytes([jpeg_bytes[i + 2], jpeg_bytes[i + 3]]) as usize;
        if marker == 0xE1 {
            let data_start = i + 4;
            if jpeg_bytes.get(data_start..data_start + 6) == Some(b"Exif\0\0") {
                let tiff = &jpeg_bytes[data_start + 6..i + 2 + seg_len];
                return parse_tiff_thumbnail(tiff);
            }
        }
        i += 2 + seg_len;
        if marker == 0xDA {
            break;
        }
    }
    None
}

fn parse_tiff_thumbnail(tiff: &[u8]) -> Option<Vec<u8>> {
    if tiff.len() < 8 {
        return None;
    }
    let is_le = match &tiff[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };

    let read_u16 = |slice: &[u8]| -> Option<u16> {
        let b: [u8; 2] = slice.get(0..2)?.try_into().ok()?;
        Some(if is_le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    };
    let read_u32 = |slice: &[u8]| -> Option<u32> {
        let b: [u8; 4] = slice.get(0..4)?.try_into().ok()?;
        Some(if is_le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };

    let magic = read_u16(&tiff[2..4])?;
    if magic != 42 {
        return None;
    }

    let ifd0_offset = read_u32(&tiff[4..8])? as usize;
    if ifd0_offset + 2 > tiff.len() {
        return None;
    }

    let ifd0_num_entries = read_u16(&tiff[ifd0_offset..ifd0_offset + 2])? as usize;
    let ifd0_end = ifd0_offset + 2 + ifd0_num_entries * 12;
    if ifd0_end + 4 > tiff.len() {
        return None;
    }

    let ifd1_offset = read_u32(&tiff[ifd0_end..ifd0_end + 4])? as usize;
    if ifd1_offset == 0 || ifd1_offset + 2 > tiff.len() {
        return None;
    }

    let ifd1_num_entries = read_u16(&tiff[ifd1_offset..ifd1_offset + 2])? as usize;
    let mut thumb_offset = None;
    let mut thumb_len = None;

    for idx in 0..ifd1_num_entries {
        let entry_pos = ifd1_offset + 2 + idx * 12;
        if entry_pos + 12 > tiff.len() {
            break;
        }
        let tag = read_u16(&tiff[entry_pos..entry_pos + 2])?;
        let val = read_u32(&tiff[entry_pos + 8..entry_pos + 12])?;
        if tag == 0x0201 {
            thumb_offset = Some(val as usize);
        } else if tag == 0x0202 {
            thumb_len = Some(val as usize);
        }
    }

    if let (Some(off), Some(len)) = (thumb_offset, thumb_len) {
        if off + len <= tiff.len() {
            return Some(tiff[off..off + len].to_vec());
        }
    }

    None
}

/// Scan PNG chunks for an eXIf chunk and return its data.
pub fn extract_exif_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[i..i + 4].try_into().ok()?) as usize;
        let chunk_type = &bytes[i + 4..i + 8];
        if chunk_type == b"eXIf" {
            return bytes.get(i + 8..i + 8 + length).map(|s| s.to_vec());
        }
        if chunk_type == b"IEND" {
            break;
        }
        i += 12 + length;
    }
    None
}

/// Extract EXIF from a HEIC/HEIF file by parsing its ISOBMFF container.
pub fn extract_exif_heic(path: &str) -> Option<Vec<u8>> {
    let file_bytes = std::fs::read(path).ok()?;

    fn iter_boxes(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
        struct BoxIter<'a> {
            data: &'a [u8],
            pos: usize,
        }
        impl<'a> Iterator for BoxIter<'a> {
            type Item = ([u8; 4], &'a [u8]);
            fn next(&mut self) -> Option<Self::Item> {
                if self.pos + 8 > self.data.len() {
                    return None;
                }
                let size =
                    u32::from_be_bytes(self.data[self.pos..self.pos + 4].try_into().ok()?) as usize;
                if size < 8 || self.pos + size > self.data.len() {
                    return None;
                }
                let box_type: [u8; 4] = self.data[self.pos + 4..self.pos + 8].try_into().ok()?;
                let body = &self.data[self.pos + 8..self.pos + size];
                self.pos += size;
                Some((box_type, body))
            }
        }
        BoxIter { data, pos: 0 }
    }

    let meta_body = iter_boxes(&file_bytes)
        .find(|(t, _)| t == b"meta")
        .map(|(_, b)| b)?;

    let meta_sub = meta_body.get(4..)?;

    let iinf_body = iter_boxes(meta_sub)
        .find(|(t, _)| t == b"iinf")
        .map(|(_, b)| b)?;

    let entry_count = u16::from_be_bytes(iinf_body.get(4..6)?.try_into().ok()?);
    let infe_data = iinf_body.get(6..)?;

    let mut exif_item_id: Option<u16> = None;
    let mut infe_pos = 0usize;
    for _ in 0..entry_count {
        if infe_pos + 8 > infe_data.len() {
            break;
        }
        let box_size =
            u32::from_be_bytes(infe_data[infe_pos..infe_pos + 4].try_into().ok()?) as usize;
        if box_size < 8 || infe_pos + box_size > infe_data.len() {
            break;
        }
        let box_type: [u8; 4] = infe_data[infe_pos + 4..infe_pos + 8].try_into().ok()?;
        if box_type == *b"infe" {
            let body = &infe_data[infe_pos + 8..infe_pos + box_size];
            if body.len() >= 12 {
                let version = body[0];
                let item_id: u16 = if version >= 3 {
                    u32::from_be_bytes(body[4..8].try_into().ok()?) as u16
                } else {
                    u16::from_be_bytes(body[4..6].try_into().ok()?)
                };
                let type_offset: usize = if version >= 3 { 10 } else { 8 };
                if body.get(type_offset..type_offset + 4) == Some(b"Exif") {
                    exif_item_id = Some(item_id);
                }
            }
        }
        infe_pos += box_size;
    }
    let exif_item_id = exif_item_id?;

    let iloc_body = iter_boxes(meta_sub)
        .find(|(t, _)| t == b"iloc")
        .map(|(_, b)| b)?;

    if iloc_body.len() < 6 {
        return None;
    }
    let version = iloc_body[0];
    let sizes_byte = iloc_body[4];
    let offset_size = ((sizes_byte >> 4) & 0xF) as usize;
    let length_size = (sizes_byte & 0xF) as usize;
    let base_offset_byte = iloc_body[5];
    let base_offset_size = ((base_offset_byte >> 4) & 0xF) as usize;

    let (item_count, mut pos) = if version < 2 {
        if iloc_body.len() < 8 {
            return None;
        }
        (
            u16::from_be_bytes(iloc_body[6..8].try_into().ok()?) as u32,
            8usize,
        )
    } else {
        if iloc_body.len() < 10 {
            return None;
        }
        (
            u32::from_be_bytes(iloc_body[6..10].try_into().ok()?),
            10usize,
        )
    };

    let read_uint = |data: &[u8], offset: usize, size: usize| -> Option<u64> {
        match size {
            0 => Some(0),
            2 => Some(u16::from_be_bytes(data.get(offset..offset + 2)?.try_into().ok()?) as u64),
            4 => Some(u32::from_be_bytes(data.get(offset..offset + 4)?.try_into().ok()?) as u64),
            8 => Some(u64::from_be_bytes(
                data.get(offset..offset + 8)?.try_into().ok()?,
            )),
            _ => None,
        }
    };

    let id_size: usize = if version < 2 { 2 } else { 4 };

    for _ in 0..item_count {
        if pos + id_size + 2 + base_offset_size + 2 > iloc_body.len() {
            break;
        }
        let item_id = read_uint(iloc_body, pos, id_size)? as u16;
        pos += id_size + 2;
        let _base_offset = read_uint(iloc_body, pos, base_offset_size)?;
        pos += base_offset_size;
        let extent_count =
            u16::from_be_bytes(iloc_body.get(pos..pos + 2)?.try_into().ok()?) as usize;
        pos += 2;

        if item_id == exif_item_id && extent_count > 0 {
            let extent_offset = read_uint(iloc_body, pos, offset_size)? as usize;
            let extent_length = read_uint(iloc_body, pos + offset_size, length_size)? as usize;
            let raw = file_bytes.get(extent_offset..extent_offset + extent_length)?;
            let exif = if raw.get(4..10) == Some(b"Exif\0\0") {
                raw.get(10..)?
            } else if raw.len() >= 4 {
                raw.get(4..)?
            } else {
                raw
            };
            return Some(exif.to_vec());
        }

        pos += extent_count * (offset_size + length_size);
    }

    None
}

// ---------------------------------------------------------------------------
// PNG eXIf chunk injection
// ---------------------------------------------------------------------------

/// Inject EXIF into JPEG by inserting an APP1 segment after the SOI marker (FF D8).
pub fn inject_exif_jpeg(mut jpeg: Vec<u8>, exif_bytes: &[u8]) -> Vec<u8> {
    // APP1 segment: FF E1 [length: 2 bytes BE] [Exif\0\0: 6 bytes] [exif raw bytes]
    let app1_len = (2 + 6 + exif_bytes.len()) as u16; // length includes itself
    let mut segment = Vec::with_capacity(2 + 2 + 6 + exif_bytes.len());
    segment.push(0xFF);
    segment.push(0xE1);
    segment.extend_from_slice(&app1_len.to_be_bytes());
    segment.extend_from_slice(b"Exif\0\0");
    segment.extend_from_slice(exif_bytes);

    // Insert after SOI (first 2 bytes)
    let tail = jpeg.split_off(2);
    jpeg.extend_from_slice(&segment);
    jpeg.extend_from_slice(&tail);
    jpeg
}

/// Inject EXIF into PNG by inserting an eXIf chunk before the IEND terminator.
pub fn inject_exif_png(mut png: Vec<u8>, exif_bytes: &[u8]) -> Vec<u8> {
    let iend_pos = (0..png.len().saturating_sub(3))
        .rev()
        .find(|&i| &png[i..i + 4] == b"IEND")
        .map(|i| i - 4)
        .unwrap_or(png.len());

    let data_len = exif_bytes.len() as u32;
    let mut chunk = Vec::with_capacity(12 + exif_bytes.len());
    chunk.extend_from_slice(&data_len.to_be_bytes());
    chunk.extend_from_slice(b"eXIf");
    chunk.extend_from_slice(exif_bytes);
    let crc = crc32fast::hash(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());

    let tail = png.split_off(iend_pos);
    png.extend_from_slice(&chunk);
    png.extend_from_slice(&tail);
    png
}

// ---------------------------------------------------------------------------
// WebP EXIF
// ---------------------------------------------------------------------------

/// Extract EXIF from a WebP file by scanning RIFF chunks for an "EXIF" chunk.
pub fn extract_exif_webp(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 12; // skip RIFF header + "WEBP" FourCC
    while pos + 8 <= bytes.len() {
        let chunk_type = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        if chunk_type == b"EXIF" {
            return bytes.get(pos + 8..pos + 8 + chunk_size).map(|s| s.to_vec());
        }
        pos += 8 + chunk_size + (chunk_size & 1); // pad to even
    }
    None
}

/// Inject EXIF into a WebP file by inserting an "EXIF" RIFF chunk after the
/// "WEBP" FourCC marker.
pub fn inject_exif_webp(mut webp: Vec<u8>, exif_bytes: &[u8]) -> Vec<u8> {
    let data_len = exif_bytes.len() as u32;
    let tail = webp.split_off(12); // after RIFF header + "WEBP"
    webp.extend_from_slice(b"EXIF");
    webp.extend_from_slice(&data_len.to_le_bytes());
    webp.extend_from_slice(exif_bytes);
    if data_len & 1 != 0 {
        webp.push(0); // pad to even
    }
    webp.extend_from_slice(&tail);
    webp
}

// ---------------------------------------------------------------------------
// Injection dispatcher
// ---------------------------------------------------------------------------

pub fn normalize_exif_for_export(exif: &[u8]) -> Vec<u8> {
    let mut out = exif.to_vec();
    if out.len() < 8 {
        return out;
    }
    let le = match &out[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return out,
    };
    let read_u16 = |slice: &[u8], offset: usize| -> Option<u16> {
        let b = slice.get(offset..offset + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let read_u32 = |slice: &[u8], offset: usize| -> Option<u32> {
        let b = slice.get(offset..offset + 4)?;
        Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
    };
    let write_u16 = |slice: &mut [u8], offset: usize, val: u16| {
        let bytes = if le { val.to_le_bytes() } else { val.to_be_bytes() };
        if let Some(target) = slice.get_mut(offset..offset + 2) {
            target.copy_from_slice(&bytes);
        }
    };
    let write_u32 = |slice: &mut [u8], offset: usize, val: u32| {
        let bytes = if le { val.to_le_bytes() } else { val.to_be_bytes() };
        if let Some(target) = slice.get_mut(offset..offset + 4) {
            target.copy_from_slice(&bytes);
        }
    };

    if read_u16(&out, 2) != Some(42) {
        return out;
    }

    let Some(mut ifd_offset) = read_u32(&out, 4).map(|v| v as usize) else {
        return out;
    };

    let mut is_first_ifd = true;

    while ifd_offset > 0 && ifd_offset + 2 <= out.len() {
        let Some(count) = read_u16(&out, ifd_offset).map(|v| v as usize) else {
            break;
        };
        let mut entry_offset = ifd_offset + 2;
        for _ in 0..count {
            if entry_offset + 12 > out.len() {
                break;
            }
            let tag = read_u16(&out, entry_offset);
            let tag_type = read_u16(&out, entry_offset + 2);
            let value_count = read_u32(&out, entry_offset + 4);
            let value_offset = entry_offset + 8;

            if tag == Some(TAG_ORIENTATION) && tag_type == Some(3) && value_count == Some(1) {
                write_u16(&mut out, value_offset, 1);
            }

            entry_offset += 12;
        }

        let next_ifd_pos = entry_offset;
        if next_ifd_pos + 4 <= out.len() {
            let next_ifd = read_u32(&out, next_ifd_pos).unwrap_or(0) as usize;
            if is_first_ifd {
                write_u32(&mut out, next_ifd_pos, 0);
                is_first_ifd = false;
            }
            ifd_offset = next_ifd;
        } else {
            break;
        }
    }

    out
}

/// Inject EXIF into encoded image bytes, dispatching by magic bytes.
pub fn inject_exif(encoded: Vec<u8>, exif_bytes: &[u8]) -> Vec<u8> {
    let normalized = normalize_exif_for_export(exif_bytes);
    if encoded.starts_with(&[0xFF, 0xD8]) {
        inject_exif_jpeg(encoded, &normalized)
    } else if encoded.starts_with(b"\x89PNG") {
        inject_exif_png(encoded, &normalized)
    } else if encoded.starts_with(b"RIFF") && encoded.get(8..12) == Some(b"WEBP") {
        inject_exif_webp(encoded, &normalized)
    } else {
        encoded
    }
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

const TAG_ORIENTATION: u16 = 0x0112;

/// Read EXIF orientation from raw image bytes and return rotation in degrees
/// (0, 90, 180, or 270). Returns None if no orientation tag is found.
pub fn orientation(bytes: &[u8]) -> Option<u16> {
    let exif = extract_exif(bytes, "")?;
    let raw = parse_orientation(&exif)?;
    Some(match raw {
        3 => 180,
        6 => 90,
        8 => 270,
        _ => 0,
    })
}

fn parse_orientation(exif: &[u8]) -> Option<u16> {
    if exif.len() < 8 {
        return None;
    }
    let le = &exif[0..2] == b"II";
    let read_u16 = |offset: usize| -> Option<u16> {
        let b = exif.get(offset..offset + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let b = exif.get(offset..offset + 4)?;
        Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
    };

    let mut ifd_offset = read_u32(4)? as usize;
    while ifd_offset > 0 && ifd_offset + 2 <= exif.len() {
        let count = read_u16(ifd_offset)? as usize;
        ifd_offset += 2;
        for _ in 0..count {
            if ifd_offset + 12 > exif.len() {
                return None;
            }
            let tag = read_u16(ifd_offset)?;
            let tag_type = read_u16(ifd_offset + 2)?;
            let value_count = read_u32(ifd_offset + 4)?;
            let value_offset = ifd_offset + 8;

            if tag == TAG_ORIENTATION && tag_type == 3 && value_count == 1 {
                return read_u16(value_offset);
            }

            ifd_offset += 12;
        }
        ifd_offset = read_u32(ifd_offset)? as usize;
    }

    None
}

// ---------------------------------------------------------------------------
// As-shot white balance
// ---------------------------------------------------------------------------

/// Exif sub-IFD pointer (`0x8769`), GPS (`0x8825`), DNG private (`0xC634`).
const TAG_EXIF_IFD_POINTER: u16 = 0x8769;
const TAG_GPS_IFD_POINTER: u16 = 0x8825;
const TAG_DNG_PRIVATE_IFD: u16 = 0xC634;
/// DNG `AsShotNeutral` — 3 RATIONAL linear RGB neutral multipliers.
const TAG_AS_SHOT_NEUTRAL: u16 = 0xC628;
/// `ColorTemperature` — SHORT Kelvin (DNG / some makers).
const TAG_COLOR_TEMPERATURE: u16 = 0xC65A;

const TIFF_TYPE_SHORT: u16 = 3;
const TIFF_TYPE_LONG: u16 = 4;
const TIFF_TYPE_RATIONAL: u16 = 5;

/// As-shot white balance read from image metadata.
///
/// Each field is `None` when the corresponding tag is absent. A value with both
/// fields `None` is never produced by [`extract_as_shot_wb`] (it returns `None`
/// instead); the renderer then falls back to a 6500K neutral.
#[derive(Debug, Default, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AsShotWb {
    /// Color temperature in Kelvin (`ColorTemperature` tag).
    pub kelvin: Option<u32>,
    /// Linear RGB neutral multipliers (`AsShotNeutral` tag), normalized so
    /// green = 1.0. Stored raw; the renderer derives correction gains as the
    /// reciprocal of these values.
    pub neutral_rgb: Option<[f32; 3]>,
}

impl std::hash::Hash for AsShotWb {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.kelvin.hash(state);
        match self.neutral_rgb {
            Some(rgb) => {
                true.hash(state);
                for v in rgb {
                    v.to_bits().hash(state);
                }
            }
            None => false.hash(state),
        }
    }
}

/// One parsed TIFF IFD entry. `value_raw` is the 4-byte value field, which for
/// values larger than 4 bytes holds an offset into the TIFF blob.
#[derive(Clone, Copy)]
struct TiffEntry {
    tag: u16,
    ty: u16,
    count: u32,
    value_raw: [u8; 4],
}

fn read_u16_at(data: &[u8], offset: usize, le: bool) -> Option<u16> {
    let b: [u8; 2] = data.get(offset..offset + 2)?.try_into().ok()?;
    Some(if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
}

fn read_u32_at(data: &[u8], offset: usize, le: bool) -> Option<u32> {
    let b: [u8; 4] = data.get(offset..offset + 4)?.try_into().ok()?;
    Some(if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
}

fn read_u32_raw(raw: [u8; 4], le: bool) -> u32 {
    if le {
        u32::from_le_bytes(raw)
    } else {
        u32::from_be_bytes(raw)
    }
}

/// Walk an IFD chain, recursing into the Exif / GPS / DNG-private sub-IFDs.
fn walk_ifd(exif: &[u8], le: bool, ifd: usize, depth: u32, out: &mut Vec<TiffEntry>) {
    if depth > 4 || ifd == 0 || ifd + 2 > exif.len() {
        return;
    }
    let Some(count) = read_u16_at(exif, ifd, le) else {
        return;
    };
    let mut sub_ifds = Vec::new();
    let mut off = ifd + 2;

    for _ in 0..count {
        if off + 12 > exif.len() {
            break;
        }
        let tag = read_u16_at(exif, off, le).unwrap_or(0);
        let ty = read_u16_at(exif, off + 2, le).unwrap_or(0);
        let cnt = read_u32_at(exif, off + 4, le).unwrap_or(0);
        let mut value_raw = [0u8; 4];
        if let Some(v) = exif.get(off + 8..off + 12) {
            value_raw.copy_from_slice(v);
        }

        if matches!(tag, TAG_EXIF_IFD_POINTER | TAG_GPS_IFD_POINTER | TAG_DNG_PRIVATE_IFD)
            && ty == TIFF_TYPE_LONG
            && cnt == 1
        {
            sub_ifds.push(read_u32_raw(value_raw, le) as usize);
        }

        out.push(TiffEntry {
            tag,
            ty,
            count: cnt,
            value_raw,
        });
        off += 12;
    }

    let next = read_u32_at(exif, off, le).unwrap_or(0) as usize;
    if next != 0 {
        walk_ifd(exif, le, next, depth + 1, out);
    }
    for sub in sub_ifds {
        walk_ifd(exif, le, sub, depth + 1, out);
    }
}

/// Read a 3-value RATIONAL out of line and normalize it so green = 1.0.
fn read_rational_rgb(exif: &[u8], entry: &TiffEntry, le: bool) -> Option<[f32; 3]> {
    let base = read_u32_raw(entry.value_raw, le) as usize;
    let mut vals = [0.0f32; 3];
    for (i, v) in vals.iter_mut().enumerate() {
        let off = base.checked_add(i * 8)?;
        let num = read_u32_at(exif, off, le)?;
        let den = read_u32_at(exif, off + 4, le)?;
        if den == 0 {
            return None;
        }
        *v = num as f32 / den as f32;
    }
    let green = vals[1];
    if green.abs() < 1e-6 {
        return None;
    }
    Some([vals[0] / green, 1.0, vals[2] / green])
}

/// Read as-shot white balance from raw TIFF/EXIF bytes.
///
/// Scans IFD0 plus the Exif / GPS / DNG-private sub-IFDs. Prefers
/// `AsShotNeutral` (linear RGB multipliers) and also captures
/// `ColorTemperature` (Kelvin) when present. Returns `None` when neither tag is
/// available or parseable.
pub fn extract_as_shot_wb(exif: &[u8]) -> Option<AsShotWb> {
    if exif.len() < 8 {
        return None;
    }
    let le = match &exif[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    if read_u16_at(exif, 2, le)? != 42 {
        return None;
    }

    let ifd0 = read_u32_at(exif, 4, le)? as usize;
    let mut entries = Vec::new();
    walk_ifd(exif, le, ifd0, 0, &mut entries);

    let mut wb = AsShotWb::default();
    for entry in &entries {
        match (entry.tag, entry.ty, entry.count) {
            (TAG_AS_SHOT_NEUTRAL, TIFF_TYPE_RATIONAL, 3) if wb.neutral_rgb.is_none() => {
                if let Some(rgb) = read_rational_rgb(exif, entry, le) {
                    wb.neutral_rgb = Some(rgb);
                }
            }
            (TAG_COLOR_TEMPERATURE, TIFF_TYPE_SHORT, 1) if wb.kelvin.is_none() => {
                let b = [entry.value_raw[0], entry.value_raw[1]];
                let value = if le {
                    u16::from_le_bytes(b)
                } else {
                    u16::from_be_bytes(b)
                };
                wb.kelvin = Some(u32::from(value));
            }
            _ => {}
        }
    }

    if wb.neutral_rgb.is_none() && wb.kelvin.is_none() {
        return None;
    }
    Some(wb)
}
