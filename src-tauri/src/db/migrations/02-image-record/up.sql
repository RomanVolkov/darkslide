CREATE TABLE IF NOT EXISTS image_record (
    uuid TEXT PRIMARY KEY,       -- The core identifier (must be unique)
    current_path TEXT NOT NULL,  -- Absolute path for move detection
    file_size INTEGER NOT NULL, -- Used as sanity check for SD card fallbacks
    adjustments TEXT NOT NULL    -- Your JSON payload of edits
);

