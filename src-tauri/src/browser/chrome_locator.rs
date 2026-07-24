use crate::errors::{AppError, AppResult};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAC_CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_CHROME_BETA: &str =
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const MAC_CHROME_DEV: &str =
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev";
const MAC_CHROME_CANARY: &str =
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
const MAC_CHROME_FOR_TESTING: &str =
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const MAC_CHROMIUM: &str = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const MAC_EDGE: &str = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const MAC_BRAVE: &str = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

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

    candidates.extend(discovered_app_candidates());
    dedupe_candidates(candidates)
}

fn platform_candidates() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        return mac_candidates();
    }

    if cfg!(target_os = "windows") {
        return windows_candidates();
    }

    linux_candidates()
}

fn mac_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from(MAC_CHROME),
        PathBuf::from(MAC_CHROME_BETA),
        PathBuf::from(MAC_CHROME_DEV),
        PathBuf::from(MAC_CHROME_CANARY),
        PathBuf::from(MAC_CHROME_FOR_TESTING),
        PathBuf::from(MAC_CHROMIUM),
        PathBuf::from(MAC_EDGE),
        PathBuf::from(MAC_BRAVE),
    ];

    // 用户级 Applications 与 Homebrew Cask 常见安装位置。
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let user_apps = home.join("Applications");
        for name in [
            "Google Chrome.app",
            "Google Chrome Beta.app",
            "Google Chrome Dev.app",
            "Google Chrome Canary.app",
            "Google Chrome for Testing.app",
            "Chromium.app",
            "Microsoft Edge.app",
            "Brave Browser.app",
        ] {
            candidates.push(user_apps.join(name));
        }
    }

    for prefix in ["/opt/homebrew/Caskroom", "/usr/local/Caskroom"] {
        let root = PathBuf::from(prefix);
        if !root.exists() {
            continue;
        }
        for cask in [
            "google-chrome",
            "google-chrome-beta",
            "google-chrome-dev",
            "google-chrome-canary",
            "chromium",
            "microsoft-edge",
            "brave-browser",
        ] {
            let cask_dir = root.join(cask);
            if let Ok(versions) = std::fs::read_dir(&cask_dir) {
                for entry in versions.flatten() {
                    let apps = entry.path();
                    if let Ok(children) = std::fs::read_dir(apps) {
                        for child in children.flatten() {
                            let path = child.path();
                            if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
                                candidates.push(path);
                            }
                        }
                    }
                }
            }
        }
    }

    candidates
        .into_iter()
        .map(|path| resolve_browser_executable(&path).unwrap_or(path))
        .collect()
}

fn path_binaries() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        return &["chrome.exe", "chromium.exe", "msedge.exe", "brave.exe"];
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
        "brave",
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
            base.join("BraveSoftware/Brave-Browser/Application/brave.exe"),
        ]);
    }
    candidates
}

fn discovered_app_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return mac_mdfind_candidates();
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn mac_mdfind_candidates() -> Vec<PathBuf> {
    let queries = [
        "kMDItemCFBundleIdentifier == 'com.google.Chrome'",
        "kMDItemCFBundleIdentifier == 'com.google.Chrome.beta'",
        "kMDItemCFBundleIdentifier == 'com.google.Chrome.dev'",
        "kMDItemCFBundleIdentifier == 'com.google.Chrome.canary'",
        "kMDItemCFBundleIdentifier == 'org.chromium.Chromium'",
        "kMDItemCFBundleIdentifier == 'com.microsoft.edgemac'",
        "kMDItemCFBundleIdentifier == 'com.brave.Browser'",
    ];

    let mut candidates = Vec::new();
    for query in queries {
        let Ok(output) = Command::new("mdfind").arg(query).output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let app = PathBuf::from(line.trim());
            if app.as_os_str().is_empty() {
                continue;
            }
            if let Some(executable) = resolve_browser_executable(&app) {
                candidates.push(executable);
            } else {
                candidates.push(app);
            }
        }
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
        if let Some(result) = inspect_candidate(candidate) {
            return ChromeDetectionResult {
                found: true,
                path: Some(result.path),
                version: result.version,
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
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(
            AppError::new("chrome_invalid_path", "Chrome path is empty")
                .details(json!({ "path": path }))
                .retryable(true),
        );
    }

    let raw = PathBuf::from(trimmed);
    let candidate = resolve_browser_executable(&raw).unwrap_or(raw);

    if !candidate.exists() {
        return Err(
            AppError::new("chrome_invalid_path", "Chrome path does not exist")
                .details(json!({ "path": candidate }))
                .retryable(true),
        );
    }
    if !is_executable_candidate(&candidate) {
        return Err(
            AppError::new("chrome_invalid_path", "Chrome path is not executable")
                .details(json!({ "path": candidate }))
                .retryable(true),
        );
    }

    let inspected = inspect_candidate(&candidate).ok_or_else(|| {
        AppError::new(
            "chrome_invalid_path",
            "Chrome path did not pass launch validation",
        )
        .details(json!({ "path": candidate }))
        .retryable(true)
    })?;

    Ok(ChromeDetectionResult {
        found: true,
        path: Some(inspected.path),
        version: inspected.version,
        searched_paths: vec![trimmed.to_string()],
        error: None,
    })
}

pub fn resolve(override_path: Option<&str>, settings_path: Option<&str>) -> AppResult<String> {
    if let Some(path) = override_path.filter(|value| !value.trim().is_empty()) {
        let validated = validate_path(path)?;
        return validated.path.ok_or_else(|| {
            AppError::new("chrome_invalid_path", "Chrome path is invalid").retryable(true)
        });
    }

    if let Some(path) = settings_path.filter(|value| !value.trim().is_empty()) {
        let validated = validate_path(path)?;
        return validated.path.ok_or_else(|| {
            AppError::new("chrome_invalid_path", "Chrome path is invalid").retryable(true)
        });
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

#[derive(Debug, Clone)]
struct InspectedChrome {
    path: String,
    version: Option<String>,
}

fn inspect_candidate(path: &Path) -> Option<InspectedChrome> {
    let resolved = resolve_browser_executable(path).unwrap_or_else(|| path.to_path_buf());
    if !is_executable_candidate(&resolved) {
        return None;
    }

    // 版本探测失败时仍可视为可用浏览器，避免把“能启动但读版本失败”误判为未安装。
    let version = version(&resolved);
    Some(InspectedChrome {
        path: resolved.to_string_lossy().to_string(),
        version,
    })
}

fn is_executable_candidate(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        return path.is_file();
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        if !path.is_file() {
            return false;
        }
        path.metadata()
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
}

/// 把 `.app` 包路径解析为真实可执行文件；已经是二进制时原样返回。
fn resolve_browser_executable(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    let app_root = if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
        path.to_path_buf()
    } else if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".app"))
    {
        path.to_path_buf()
    } else {
        return None;
    };

    let info_plist = app_root.join("Contents/Info.plist");
    if let Some(executable_name) = read_plist_string(&info_plist, "CFBundleExecutable") {
        let candidate = app_root
            .join("Contents/MacOS")
            .join(executable_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let macos_dir = app_root.join("Contents/MacOS");
    if let Ok(entries) = std::fs::read_dir(macos_dir) {
        let mut files = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|entry| entry.is_file())
            .collect::<Vec<_>>();
        files.sort();
        if let Some(first) = files.into_iter().next() {
            return Some(first);
        }
    }

    None
}

pub fn version(path: &Path) -> Option<String> {
    if let Some(version) = metadata_version(path) {
        return Some(version);
    }

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

fn metadata_version(path: &Path) -> Option<String> {
    // macOS: 优先从相邻 Info.plist 读取，避免拉起 Chrome 进程。
    let app_info = path
        .parent()
        .and_then(|macos| macos.parent())
        .map(|contents| contents.join("Info.plist"));
    if let Some(info_plist) = app_info {
        if let Some(version) = read_plist_string(&info_plist, "CFBundleShortVersionString") {
            return Some(version);
        }
        if let Some(version) = read_plist_string(&info_plist, "CFBundleVersion") {
            return Some(version);
        }
    }

    // 同目录或上级目录的 version 文件（Chrome for Testing 等场景）。
    for candidate in [
        path.with_file_name("VERSION"),
        path.with_file_name("version"),
        path.parent()
            .map(|dir| dir.join("VERSION"))
            .unwrap_or_default(),
    ] {
        if candidate.as_os_str().is_empty() {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            let value = text.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

fn read_plist_string(path: &Path, key: &str) -> Option<String> {
    if !path.is_file() {
        return None;
    }

    // 优先走 plutil，兼容 binary/xml plist。
    if let Ok(output) = Command::new("plutil")
        .args(["-extract", key, "raw", "-o", "-", "--"])
        .arg(path)
        .stdin(Stdio::null())
        .output()
    {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    // 简单 XML fallback。
    let content = std::fs::read_to_string(path).ok()?;
    let pattern = format!("<key>{key}</key>");
    let index = content.find(&pattern)?;
    let after = &content[index + pattern.len()..];
    let start = after.find("<string>")? + "<string>".len();
    let rest = &after[start..];
    let end = rest.find("</string>")?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(not(target_os = "windows"))]
fn version_by_process_probe(path: &Path) -> Option<String> {
    const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

    // 先试 --product-version（输出更干净），失败再回退 --version。
    for args in [&["--product-version"][..], &["--version"][..]] {
        let mut command = Command::new(path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_probe_process(&mut command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => continue,
        };
        let started_at = Instant::now();

        let status_ok = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if started_at.elapsed() < VERSION_PROBE_TIMEOUT => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
                Err(_) => break false,
            }
        };

        if !status_ok {
            continue;
        }

        let mut stdout = String::new();
        if child.stdout.take()?.read_to_string(&mut stdout).ok().is_none() {
            continue;
        }
        let value = stdout.trim().to_string();
        if value.is_empty() {
            continue;
        }
        // 过滤 Chrome 复用已有会话时的本地化提示，避免误把提示当版本。
        if value.contains("现有的浏览器会话")
            || value.to_ascii_lowercase().contains("existing browser session")
        {
            continue;
        }
        return Some(value);
    }

    None
}

#[cfg(target_os = "windows")]
fn windows_file_version(path: &Path) -> Option<String> {
    use std::ffi::{c_void, OsStr};
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::{
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
    use std::os::windows::ffi::OsStrExt;

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
            assert!(candidates.contains(&PathBuf::from(MAC_CHROME_CANARY)));
            assert!(candidates.contains(&PathBuf::from(MAC_EDGE)));
        } else if cfg!(target_os = "windows") {
            assert!(path_binaries().contains(&"chrome.exe"));
            assert!(path_binaries().contains(&"msedge.exe"));
        } else {
            assert!(candidates.contains(&PathBuf::from("/usr/bin/google-chrome")));
            assert!(candidates.contains(&PathBuf::from("/snap/bin/chromium")));
        }
    }

    #[test]
    fn resolve_browser_executable_accepts_app_bundle() {
        let app = PathBuf::from("/Applications/Google Chrome.app");
        if !app.exists() {
            return;
        }
        let resolved = resolve_browser_executable(&app).expect("resolve app bundle");
        assert!(resolved.ends_with("Google Chrome"));
        assert!(resolved.is_file());
    }

    #[test]
    fn inspect_candidate_finds_local_chrome_when_present() {
        let chrome = PathBuf::from(MAC_CHROME);
        if !chrome.exists() {
            return;
        }
        let inspected = inspect_candidate(&chrome).expect("chrome should be inspectable");
        assert!(inspected.path.contains("Google Chrome"));
        assert!(inspected.version.is_some());
    }
}
