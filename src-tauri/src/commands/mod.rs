pub mod agent;
pub mod diagnostics;
pub mod environments;
pub mod runs;
pub mod settings;
pub mod tasks;

use crate::errors::{AppError, AppResult};
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn open_path(path: &Path) -> AppResult<()> {
    spawn_platform_opener(path).map_err(|err| {
        AppError::new(
            "open_path_failed",
            format!("Failed to open path with system opener: {err}"),
        )
        .retryable(true)
    })
}

fn spawn_platform_opener(path: &Path) -> io::Result<()> {
    if cfg!(target_os = "macos") {
        return spawn_open_command("open", [], path);
    }

    if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            return spawn_windows_explorer(path);
        }
        #[cfg(not(target_os = "windows"))]
        {
            unreachable!()
        }
    }

    spawn_linux_opener(path)
}

fn spawn_linux_opener(path: &Path) -> io::Result<()> {
    let mut last_error = None;

    for (program, args) in [
        ("gio", &["open"][..]),
        ("xdg-open", &[][..]),
        ("kde-open6", &[][..]),
        ("kde-open5", &[][..]),
        ("kde-open", &[][..]),
        ("gnome-open", &[][..]),
    ] {
        match spawn_open_command(program, args.iter().copied(), path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => last_error = Some(err),
            Err(err) => return Err(err),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "no supported system opener found")
    }))
}

fn spawn_open_command<'a>(
    program: &str,
    args: impl IntoIterator<Item = &'a str>,
    path: &Path,
) -> io::Result<()> {
    let mut command = Command::new(program);
    command
        .args(args)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn spawn_windows_explorer(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new("explorer.exe");
    command
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    command.spawn().map(|_| ())
}
