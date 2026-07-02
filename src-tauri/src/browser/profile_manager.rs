use crate::domain::environment::Environment;
use crate::errors::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProfileLock {
    pub pid: u32,
    pub started_at: String,
    pub cdp_port: u16,
}

pub fn profile_dir(data_dir: &Path, env: &Environment) -> PathBuf {
    data_dir.join(&env.profile_dir)
}

pub fn environment_dir(data_dir: &Path, environment_id: &str) -> PathBuf {
    data_dir.join("profiles").join(environment_id)
}

pub fn lock_path(data_dir: &Path, environment_id: &str) -> PathBuf {
    environment_dir(data_dir, environment_id).join(".orbit.lock")
}

pub fn ensure_profile_dir(data_dir: &Path, env: &Environment) -> AppResult<PathBuf> {
    let path = profile_dir(data_dir, env);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn read_lock(data_dir: &Path, environment_id: &str) -> AppResult<Option<ProfileLock>> {
    let path = lock_path(data_dir, environment_id);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)?;
    let lock = serde_json::from_str(&content).map_err(|err| {
        AppError::new(
            "profile_locked",
            format!("Failed to parse profile lock: {err}"),
        )
    })?;
    Ok(Some(lock))
}

pub fn write_lock(data_dir: &Path, environment_id: &str, pid: u32, cdp_port: u16) -> AppResult<()> {
    let dir = environment_dir(data_dir, environment_id);
    std::fs::create_dir_all(&dir)?;
    let lock = ProfileLock {
        pid,
        started_at: Utc::now().to_rfc3339(),
        cdp_port,
    };
    let content = serde_json::to_string_pretty(&lock)?;
    std::fs::write(lock_path(data_dir, environment_id), content)?;
    Ok(())
}

pub fn remove_lock(data_dir: &Path, environment_id: &str) -> AppResult<()> {
    let path = lock_path(data_dir, environment_id);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
