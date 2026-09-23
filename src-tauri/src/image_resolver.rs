use std::path::Path;

use darkslide_core::exif::{AsShotWb, extract_as_shot_wb, extract_exif};
use darkslide_core::types::Adjustments;

/// Read the as-shot white balance from an image file's EXIF metadata.
///
/// Only a bounded head of the file is read (EXIF lives near the start for
/// JPEG/TIFF); HEIC falls back to its full-file container parser via
/// `extract_exif`. Returns the default (no correction) on any failure.
fn read_as_shot_wb(path: &Path) -> AsShotWb {
    use std::io::Read;

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            log::debug!("as-shot wb: open failed for {}: {e}", path.display());
            return AsShotWb::default();
        }
    };
    let mut head = vec![0u8; 256 * 1024];
    let read = match file.read(&mut head) {
        Ok(n) => n,
        Err(e) => {
            log::debug!("as-shot wb: read failed for {}: {e}", path.display());
            return AsShotWb::default();
        }
    };
    head.truncate(read);

    let path_str = path.to_string_lossy();
    match extract_exif(&head, &path_str) {
        Some(exif) => extract_as_shot_wb(&exif).unwrap_or_default(),
        None => AsShotWb::default(),
    }
}

/// Resolves the persistent identity of an image file: finds its DB record via
/// xattr UUID or path+size lookup, and creates/heals/forks the record as
/// needed. Returns the record id and its adjustments.
#[derive(Clone)]
pub struct ImageResolver {
    db: std::sync::Arc<crate::db::Db>,
}

impl ImageResolver {
    pub fn new(db: std::sync::Arc<crate::db::Db>) -> Self {
        Self { db }
    }

    pub async fn resolve(
        &self,
        path: &Path,
        file_size: u64,
    ) -> Result<(uuid::Uuid, Adjustments), String> {
        let file_path = path.to_string_lossy();
        let mut adjustments = Adjustments::default();

        let uuid_option = match crate::utils::get_file_uuid(&file_path) {
            Ok(u) => u,
            Err(err) => {
                log::error!("error loading uuid via xattr for {}: {}", file_path, err);
                log::debug!("xattr error — falling through to path+size lookup");
                None
            }
        };

        let image_id = match uuid_option {
            Some(uuid) => {
                log::info!("uuid found: {uuid}");
                match self.db.find_image_by_uuid(uuid).await {
                    Err(err) => {
                        log::error!("error loading image_record by uuid: {err}");
                        return Err(format!("DB error for {}: {}", file_path, err));
                    }
                    Ok(None) => {
                        log::debug!("uuid in xattr but no DB record — creating new record");
                        let record = self
                            .db
                            .create_image_record(Some(path), file_size)
                            .await
                            .unwrap();
                        crate::utils::set_file_uuid(&file_path, record.id)?;
                        record.id
                    }
                    Ok(Some(image_record)) => {
                        if image_record.current_path.as_deref() == Some(path) {
                            log::debug!("path unchanged — loading edits");
                            adjustments = image_record.adjustments;
                            image_record.id
                        } else {
                            let original_exists = image_record
                                .current_path
                                .as_ref()
                                .map(|p| p.exists())
                                .unwrap_or(false);
                            if original_exists {
                                log::debug!("duplicate detected — forking record with new UUID");
                                let new_uuid = uuid::Uuid::new_v4();
                                crate::utils::set_file_uuid(&file_path, new_uuid)?;
                                let new_record = self
                                    .db
                                    .fork_image_record(image_record.id, new_uuid, path, file_size)
                                    .await
                                    .unwrap();
                                adjustments = new_record.adjustments;
                                new_record.id
                            } else {
                                log::debug!("move detected — updating path in DB");
                                self.db
                                    .update_image_path(image_record.id, path)
                                    .await
                                    .unwrap();
                                adjustments = image_record.adjustments;
                                image_record.id
                            }
                        }
                    }
                }
            }
            None => {
                log::debug!("no uuid for {file_path}");
                match self.db.find_image_by_path_and_size(path, file_size).await {
                    Err(err) => {
                        log::error!("error loading image_record by path+size: {err}");
                        return Err(format!("DB error for {}: {}", file_path, err));
                    }
                    Ok(None) => {
                        log::debug!("no uuid, no DB record — creating new record");
                        let record = self
                            .db
                            .create_image_record(Some(path), file_size)
                            .await
                            .unwrap();
                        crate::utils::set_file_uuid(&file_path, record.id)?;
                        record.id
                    }
                    Ok(Some(image_record)) => {
                        log::debug!(
                            "no uuid but DB record found by path+size (HEAL) — replacing UUID"
                        );
                        let new_uuid = uuid::Uuid::new_v4();
                        self.db
                            .update_image_uuid(image_record.id, new_uuid)
                            .await
                            .unwrap();
                        crate::utils::set_file_uuid(&file_path, new_uuid)?;
                        adjustments = image_record.adjustments;
                        new_uuid
                    }
                }
            }
        };

        // Anchor the relative white-balance sliders on the image's as-shot WB.
        // Read once and persist so subsequent loads do not re-parse the header.
        if adjustments.as_shot_wb == AsShotWb::default() {
            let wb = read_as_shot_wb(path);
            if wb != AsShotWb::default() {
                log::debug!("as-shot wb for {}: {:?}", path.display(), wb);
                adjustments.as_shot_wb = wb;
                if let Err(err) = self.db.update_adjustments(image_id, &adjustments).await {
                    log::error!("failed to persist as-shot wb: {err}");
                }
            }
        }

        Ok((image_id, adjustments))
    }
}
