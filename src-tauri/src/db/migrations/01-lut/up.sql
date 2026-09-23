CREATE TABLE lut(
    id INTEGER PRIMARY KEY ASC,
    name TEXT,
    lut_values BLOB,
    lut_size INTEGER,
    created_at INTEGER DEFAULT(strftime(
        '%s',
        'now'
    ))
)
