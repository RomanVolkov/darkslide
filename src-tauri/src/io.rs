use std::path::{Path, PathBuf};
use std::sync::Mutex;

use clap::Parser;
use tauri::Emitter;
use walkdir::WalkDir;

#[derive(Parser, Debug, Clone)]
#[command(name = "darkslide", about = "Open images in Darkslide")]
pub struct Cli {
    /// Image files or directories to open
    pub inputs: Vec<PathBuf>,

    #[cfg(any(test, feature = "profiling"))]
    #[arg(long)]
    pub scenario: bool,

    #[cfg(any(test, feature = "profiling"))]
    #[arg(long)]
    pub devtools: bool,
}

impl Cli {
    /// Parse CLI arguments, tolerating invalid input by falling back to no
    /// inputs (clap expects argv[0] to be the program name).
    pub fn parse_args(args: &[String]) -> Self {
        let argv = std::iter::once("darkslide".to_string()).chain(args.iter().cloned());
        Cli::try_parse_from(argv).unwrap_or_else(|_| Cli {
            inputs: vec![],
            #[cfg(any(test, feature = "profiling"))]
            scenario: false,
            #[cfg(any(test, feature = "profiling"))]
            devtools: false,
        })
    }

    /// Resolve inputs (files or directories) into a flat list of image paths.
    pub fn collect_files(&self, cwd: &str) -> Vec<String> {
        self.inputs
            .iter()
            .flat_map(|input| {
                let resolved = if input.is_absolute() {
                    input.clone()
                } else {
                    PathBuf::from(cwd).join(input)
                };

                if resolved.is_dir() {
                    // directory → walk recursively, collect images
                    WalkDir::new(&resolved)
                        .into_iter()
                        .filter_map(|e| e.ok())
                        .map(|e| e.into_path())
                        .filter(|p| is_image(p.as_path()))
                        .collect::<Vec<_>>()
                } else if resolved.exists() && is_image(&resolved) {
                    vec![resolved]
                } else {
                    vec![]
                }
            })
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    /// Collect files and emit them to the frontend via `cli-open-files`.
    pub fn open_files(&self, app: &tauri::AppHandle, cwd: &str) {
        log::info!("open_files: cwd={}", cwd);
        let files = self.collect_files(cwd);
        log::info!("open_files: collected={:?}", files);
        if !files.is_empty() {
            app.emit("cli-open-files", &files).unwrap();
        }
    }
}

pub struct PendingFiles {
    pub files: Mutex<Vec<String>>,
}

#[cfg(any(test, feature = "profiling"))]
#[derive(Clone, Debug, Default)]
pub struct CliConfig {
    pub scenario: bool,
    pub devtools: bool,
}

fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(darkslide_core::is_supported_image_extension)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parsing_flags() {
        let args = vec![
            "test_fixtures/images".to_string(),
            "--scenario".to_string(),
            "--devtools".to_string(),
        ];
        let cli = Cli::parse_args(&args);
        assert_eq!(cli.inputs.len(), 1);
        assert!(cli.scenario);
        assert!(cli.devtools);

        let default_args = vec!["image.jpg".to_string()];
        let default_cli = Cli::parse_args(&default_args);
        assert_eq!(default_cli.inputs.len(), 1);
        assert!(!default_cli.scenario);
        assert!(!default_cli.devtools);
    }
}
