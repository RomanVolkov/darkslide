pub fn install_cli() -> Result<String, String> {
    let script = concat!(
        "#!/bin/bash\n",
        "/Applications/Darkslide.app/Contents/MacOS/Darkslide \"$@\" > /dev/null 2>&1 &\n",
        "disown\n"
    );

    let path = "/usr/local/bin/darkslide";
    match std::fs::write(path, script) {
        Ok(_) => {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
            Ok(path.to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            Err("permission_denied".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}
