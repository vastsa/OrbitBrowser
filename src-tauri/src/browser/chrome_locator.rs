use crate::errors::{AppError, AppResult};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAC_CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_CHROMIUM: &str = "/Applications/Chromium.app/Contents/MacOS/Chromium";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ChromeDetectionResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub searched_paths: Vec<String>,
    pub error: Option<String>,
}

pub fn default_candidates() -> Vec<PathBuf> {
    let mut candidates = platform_candidates();

    for binary in path_binaries() {
        if let Some(path) = find_on_path(binary) {
            candidates.push(path);
        }
    }

    dedupe_candidates(candidates)
}

fn platform_candidates() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        return vec![PathBuf::from(MAC_CHROME), PathBuf::from(MAC_CHROMIUM)];
    }

    if cfg!(target_os = "windows") {
        return windows_candidates();
    }

    linux_candidates()
}

fn path_binaries() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        return &["chrome.exe", "chromium.exe", "msedge.exe"];
    }

    &[
        "google-chrome",
        "google-chrome-stable",
        "google-chrome-beta",
        "google-chrome-unstable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "brave-browser",
        "chrome",
    ]
}

fn linux_candidates() -> Vec<PathBuf> {
    let mut candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/local/bin/google-chrome",
        "/usr/local/bin/chromium",
        "/opt/google/chrome/google-chrome",
        "/opt/google/chrome/chrome",
        "/opt/google/chrome-beta/google-chrome-beta",
        "/opt/google/chrome-unstable/google-chrome-unstable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/brave-browser",
        "/snap/bin/chromium",
        "/var/lib/flatpak/exports/bin/com.google.Chrome",
        "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect::<Vec<_>>();

    if let Some(home) = std::env::var_os("HOME") {
        let exports = PathBuf::from(home).join(".local/share/flatpak/exports/bin");
        candidates.extend([
            exports.join("com.google.Chrome"),
            exports.join("org.chromium.Chromium"),
        ]);
    }

    candidates
}

fn windows_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in [
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        let base = PathBuf::from(base);
        candidates.extend([
            base.join("Google/Chrome/Application/chrome.exe"),
            base.join("Google/Chrome Beta/Application/chrome.exe"),
            base.join("Google/Chrome Dev/Application/chrome.exe"),
            base.join("Google/Chrome SxS/Application/chrome.exe"),
            base.join("Chromium/Application/chrome.exe"),
            base.join("Microsoft/Edge/Application/msedge.exe"),
        ]);
    }
    candidates
}

fn dedupe_candidates(candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect()
}

pub fn detect() -> ChromeDetectionResult {
    let candidates = default_candidates();
    let searched_paths = candidates
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    for candidate in &candidates {
        if let Some(version) = version(candidate) {
            return ChromeDetectionResult {
                found: true,
                path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version),
                searched_paths,
                error: None,
            };
        }
    }

    ChromeDetectionResult {
        found: false,
        path: None,
        version: None,
        searched_paths,
        error: Some("Chrome or Chromium was not found".to_string()),
    }
}

pub fn validate_path(path: &str) -> AppResult<ChromeDetectionResult> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err(
            AppError::new("chrome_invalid_path", "Chrome path does not exist")
                .details(json!({ "path": path }))
                .retryable(true),
        );
    }
    if !candidate.is_file() {
        return Err(
            AppError::new("chrome_invalid_path", "Chrome path is not executable")
                .details(json!({ "path": path }))
                .retryable(true),
        );
    }

    let Some(version) = version(&candidate) else {
        return Err(AppError::new(
            "chrome_invalid_path",
            "Chrome path did not pass launch validation",
        )
        .details(json!({ "path": path }))
        .retryable(true));
    };

    Ok(ChromeDetectionResult {
        found: true,
        path: Some(candidate.to_string_lossy().to_string()),
        version: Some(version),
        searched_paths: vec![path.to_string()],
        error: None,
    })
}

pub fn resolve(override_path: Option<&str>, settings_path: Option<&str>) -> AppResult<String> {
    if let Some(path) = override_path.filter(|value| !value.trim().is_empty()) {
        validate_path(path)?;
        return Ok(path.to_string());
    }

    if let Some(path) = settings_path.filter(|value| !value.trim().is_empty()) {
        validate_path(path)?;
        return Ok(path.to_string());
    }

    let detection = detect();
    detection.path.ok_or_else(|| {
        AppError::new(
            "chrome_not_found",
            "Chrome or Chromium was not found. Configure a Chrome path in Settings.",
        )
        .details(json!({ "searchedPaths": detection.searched_paths }))
        .retryable(true)
    })
}

pub fn version(path: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Windows 上 chrome.exe 是 GUI 子系统程序，频繁用 `--version` 探测
        // 可能会唤起真实浏览器窗口。直接读取 EXE 版本资源，避免产生副作用。
        return windows_file_version(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        version_by_process_probe(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn version_by_process_probe(path: &Path) -> Option<String> {
    const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_probe_process(&mut command);

    let mut child = command.spawn().ok()?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if started_at.elapsed() < VERSION_PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }

    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    let value = stdout.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "windows")]
fn windows_file_version(path: &Path) -> Option<String> {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    let wide_path = to_wide_null(path.as_os_str());
    let mut handle = 0u32;
    let size = unsafe { GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    let ok = unsafe {
        GetFileVersionInfoW(
            wide_path.as_ptr(),
            0,
            size,
            buffer.as_mut_ptr().cast::<c_void>(),
        )
    };
    if ok == 0 {
        return None;
    }

    let mut fixed_info_ptr: *mut c_void = null_mut();
    let mut fixed_info_len = 0u32;
    let root = to_wide_null(OsStr::new("\\"));
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast::<c_void>(),
            root.as_ptr(),
            &mut fixed_info_ptr,
            &mut fixed_info_len,
        )
    };
    if ok == 0
        || fixed_info_ptr.is_null()
        || fixed_info_len < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return None;
    }

    let fixed_info = unsafe { &*(fixed_info_ptr.cast::<VS_FIXEDFILEINFO>()) };
    Some(format_fixed_file_version(
        fixed_info.dwFileVersionMS,
        fixed_info.dwFileVersionLS,
    ))
}

#[cfg(target_os = "windows")]
fn to_wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn format_fixed_file_version(ms: u32, ls: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        (ms >> 16) & 0xffff,
        ms & 0xffff,
        (ls >> 16) & 0xffff,
        ls & 0xffff
    )
}

#[cfg(target_os = "windows")]
fn configure_probe_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_probe_process(_command: &mut Command) {}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(binary))
        .find(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_candidates_keeps_first_path_case_insensitively() {
        let candidates = dedupe_candidates(vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/applications/google chrome.app/contents/macos/google chrome"),
            PathBuf::from("/usr/bin/chromium"),
        ]);

        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0],
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        );
        assert_eq!(candidates[1], PathBuf::from("/usr/bin/chromium"));
    }

    #[test]
    fn default_candidates_includes_current_platform_paths() {
        let candidates = default_candidates();

        if cfg!(target_os = "macos") {
            assert!(candidates.contains(&PathBuf::from(MAC_CHROME)));
            assert!(candidates.contains(&PathBuf::from(MAC_CHROMIUM)));
        } else if cfg!(target_os = "windows") {
            assert!(path_binaries().contains(&"chrome.exe"));
            assert!(path_binaries().contains(&"msedge.exe"));
        } else {
            assert!(candidates.contains(&PathBuf::from("/usr/bin/google-chrome")));
            assert!(candidates.contains(&PathBuf::from("/snap/bin/chromium")));
        }
    }
}
