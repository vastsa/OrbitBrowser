use crate::errors::{AppError, AppResult};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

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
        "chromium",
        "chromium-browser",
        "chrome",
    ]
}

fn linux_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/var/lib/flatpak/exports/bin/com.google.Chrome",
        "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
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
        if candidate.exists() {
            return ChromeDetectionResult {
                found: true,
                path: Some(candidate.to_string_lossy().to_string()),
                version: version(candidate),
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

    Ok(ChromeDetectionResult {
        found: true,
        path: Some(candidate.to_string_lossy().to_string()),
        version: version(&candidate),
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

fn version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

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
