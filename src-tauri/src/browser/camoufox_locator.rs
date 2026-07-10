use crate::errors::{AppError, AppResult};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CAMOUFOX_PACKAGE: &str = "camoufox[geoip]==0.4.11";
const PLAYWRIGHT_PACKAGE: &str = "playwright==1.51.0";
const CAMOUFOX_BROWSER_VERSION: &str = "135.0.1";
const CAMOUFOX_BROWSER_RELEASE: &str = "beta.24";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CamoufoxDetectionResult {
    pub found: bool,
    pub python_path: Option<String>,
    pub version: Option<String>,
    pub searched_paths: Vec<String>,
    pub error: Option<String>,
}

pub fn detect() -> CamoufoxDetectionResult {
    let candidates = default_candidates();
    let searched_paths = candidates
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    for candidate in &candidates {
        if let Some(version) = version(candidate) {
            return CamoufoxDetectionResult {
                found: true,
                python_path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version),
                searched_paths,
                error: None,
            };
        }
    }

    CamoufoxDetectionResult {
        found: false,
        python_path: None,
        version: None,
        searched_paths,
        error: Some("Camoufox Python package was not found".to_string()),
    }
}

pub fn validate_python_path(path: &str) -> AppResult<CamoufoxDetectionResult> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() || !candidate.is_file() {
        return Err(
            AppError::new("camoufox_invalid_path", "Python path does not exist")
                .details(json!({ "path": path }))
                .retryable(true),
        );
    }

    let Some(version) = version(&candidate) else {
        return Err(AppError::new(
            "camoufox_invalid_path",
            "Python executable cannot import camoufox",
        )
        .details(json!({ "path": path }))
        .retryable(true));
    };

    Ok(CamoufoxDetectionResult {
        found: true,
        python_path: Some(candidate.to_string_lossy().to_string()),
        version: Some(version),
        searched_paths: vec![path.to_string()],
        error: None,
    })
}

pub fn resolve(override_path: Option<&str>) -> AppResult<String> {
    if let Some(path) = override_path.filter(|value| !value.trim().is_empty()) {
        validate_python_path(path)?;
        return Ok(path.to_string());
    }

    let detection = detect();
    detection.python_path.ok_or_else(|| {
        AppError::new(
            "camoufox_not_found",
            "Camoufox is not installed. Install it from Settings or configure a Python path that can import camoufox.",
        )
        .details(json!({ "searchedPaths": detection.searched_paths }))
        .retryable(true)
    })
}

pub async fn install() -> AppResult<CamoufoxDetectionResult> {
    let bootstrap_python = python_bootstrap_path().ok_or_else(|| {
        AppError::new(
            "python_not_found",
            "Python was not found. Install Python 3 first, then install Camoufox.",
        )
        .retryable(true)
    })?;
    let python = ensure_orbit_venv(&bootstrap_python).await?;

    run_python_step(
        &python,
        &["-m", "pip", "install", "-U", "pip", "setuptools", "wheel"],
    )
    .await?;
    run_python_step(
        &python,
        &[
            "-m",
            "pip",
            "install",
            "-U",
            CAMOUFOX_PACKAGE,
            PLAYWRIGHT_PACKAGE,
        ],
    )
    .await?;
    if run_python_step(&python, &["-m", "camoufox", "fetch"])
        .await
        .is_err()
    {
        install_camoufox_browser_direct(&python).await?;
    }
    validate_python_path(&python.to_string_lossy())
}

fn default_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ORBIT_CAMOUFOX_PYTHON") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(orbit_venv_python_path());
    for binary in python_binaries() {
        if let Some(path) = find_on_path(binary) {
            candidates.push(path);
        }
    }
    dedupe_candidates(candidates)
}

fn python_bootstrap_path() -> Option<PathBuf> {
    std::env::var_os("ORBIT_CAMOUFOX_PYTHON")
        .map(PathBuf::from)
        .or_else(|| {
            python_binaries()
                .iter()
                .find_map(|binary| find_on_path(binary))
        })
}

async fn ensure_orbit_venv(bootstrap_python: &PathBuf) -> AppResult<PathBuf> {
    let venv_python = orbit_venv_python_path();
    if version(&venv_python).is_some() {
        return Ok(venv_python);
    }

    let venv_dir = orbit_venv_dir()?;
    if let Some(parent) = venv_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    run_python_step(
        bootstrap_python,
        &["-m", "venv", venv_dir.to_string_lossy().as_ref()],
    )
    .await?;
    Ok(venv_python)
}

fn orbit_venv_dir() -> AppResult<PathBuf> {
    dirs::data_dir()
        .map(|dir| {
            dir.join("com.orbit.browser")
                .join("runtime")
                .join("camoufox-python")
        })
        .ok_or_else(|| AppError::new("data_dir_unavailable", "Unable to resolve app data dir"))
}

fn orbit_venv_python_path() -> PathBuf {
    let base = dirs::data_dir()
        .map(|dir| {
            dir.join("com.orbit.browser")
                .join("runtime")
                .join("camoufox-python")
        })
        .unwrap_or_else(|| PathBuf::from("camoufox-python"));
    if cfg!(target_os = "windows") {
        base.join("Scripts").join("python.exe")
    } else {
        base.join("bin").join("python")
    }
}

fn python_binaries() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        return &["python.exe", "python3.exe", "py.exe"];
    }
    &["python3", "python"]
}

fn version(path: &PathBuf) -> Option<String> {
    let script = r#"
import importlib.metadata as m
try:
    print(m.version("camoufox"))
except Exception:
    import camoufox
    print(getattr(camoufox, "__version__", "installed"))
"#;
    let output = Command::new(path)
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

async fn install_camoufox_browser_direct(python: &PathBuf) -> AppResult<()> {
    let script = format!(
        r#"
import json
import platform
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

try:
    from platformdirs import user_cache_dir
except Exception as exc:
    raise SystemExit(f"platformdirs unavailable: {{exc}}")

system = platform.system().lower()
machine = platform.machine().lower()
if system == "darwin":
    suffix = "mac.arm64" if machine in ("arm64", "aarch64") else "mac.x86_64"
elif system == "linux":
    suffix = "lin.arm64" if machine in ("arm64", "aarch64") else "lin.x86_64"
elif system == "windows":
    suffix = "win.arm64" if machine in ("arm64", "aarch64") else "win.x86_64"
else:
    raise SystemExit(f"unsupported platform: {{system}}/{{machine}}")

version = "{version}"
release = "{release}"
asset = f"camoufox-{{version}}-{{release}}-{{suffix}}.zip"
url = f"https://github.com/daijro/camoufox/releases/download/v{{version}}-{{release}}/{{asset}}"
cache_dir = Path(user_cache_dir("camoufox"))
tmp_dir = Path(tempfile.mkdtemp(prefix="orbit-camoufox-"))
zip_path = tmp_dir / asset
try:
    urllib.request.urlretrieve(url, zip_path)
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(cache_dir)
    if system != "windows":
        for path in cache_dir.rglob("*"):
            if path.is_file() and (
                path.name == "camoufox" or
                "/Contents/MacOS/" in path.as_posix()
            ):
                path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (cache_dir / "version.json").write_text(
        json.dumps({{"version": version, "release": release}}),
        encoding="utf-8",
    )
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
"#,
        version = CAMOUFOX_BROWSER_VERSION,
        release = CAMOUFOX_BROWSER_RELEASE,
    );
    run_python_script(python, &script).await
}

async fn run_python_step(python: &PathBuf, args: &[&str]) -> AppResult<()> {
    let status = tokio::process::Command::new(python)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|err| {
            AppError::new(
                "camoufox_install_failed",
                format!("Failed to run Python: {err}"),
            )
            .retryable(true)
        })?;
    if !status.success() {
        return Err(AppError::new(
            "camoufox_install_failed",
            "Camoufox installation command failed",
        )
        .details(json!({ "python": python, "args": args }))
        .retryable(true));
    }
    Ok(())
}

async fn run_python_script(python: &PathBuf, script: &str) -> AppResult<()> {
    let status = tokio::process::Command::new(python)
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|err| {
            AppError::new(
                "camoufox_install_failed",
                format!("Failed to run Python: {err}"),
            )
            .retryable(true)
        })?;
    if !status.success() {
        return Err(AppError::new(
            "camoufox_install_failed",
            "Camoufox browser download fallback failed",
        )
        .details(json!({ "python": python }))
        .retryable(true));
    }
    Ok(())
}

fn dedupe_candidates(candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .collect()
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(binary))
        .find(|path| path.exists())
}
