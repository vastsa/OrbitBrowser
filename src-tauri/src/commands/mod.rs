pub mod diagnostics;
pub mod environments;
pub mod runs;
pub mod settings;
pub mod tasks;

use crate::errors::{AppError, AppResult};
use std::path::Path;

pub fn open_path(path: &Path) -> AppResult<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &path.to_string_lossy()])
                .creation_flags(0x08000000)
                .status()
        }
        #[cfg(not(target_os = "windows"))]
        {
            unreachable!()
        }
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    }?;

    if status.success() {
        Ok(())
    } else {
        Err(AppError::new("open_path_failed", "Failed to open path"))
    }
}
