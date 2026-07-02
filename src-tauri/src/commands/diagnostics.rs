use crate::app_state::AppState;
use crate::browser::{chrome_locator, process_manager, profile_manager};
use crate::domain::environment::RuntimeStatus;
use crate::domain::run::TaskRunStatus;
use crate::errors::AppResult;
use crate::storage::{environment_repo, run_repo, settings_repo};
use chrono::Utc;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Diagnostics {
    pub chrome: ChromeDiagnostics,
    pub data: DataDiagnostics,
    pub runtime: RuntimeDiagnostics,
    pub proxy: ProxyDiagnostics,
    pub recovery: RecoveryDiagnostics,
    pub warnings: Vec<String>,
    pub generated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ChromeDiagnostics {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub searched_paths: Vec<String>,
    pub launchable: bool,
    pub cdp_test_ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DataDiagnostics {
    pub data_dir: String,
    pub sqlite_path: String,
    pub profiles_total_size: u64,
    pub runs_total_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RuntimeDiagnostics {
    pub running_browser_count: usize,
    pub remembered_session_count: usize,
    pub current_queue_concurrency: i64,
    pub stale_process_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProxyDiagnostics {
    pub last_test_status: Option<String>,
    pub last_test_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RecoveryDiagnostics {
    pub stale_lock_count: usize,
    pub crashed_session_count: usize,
    pub interrupted_run_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CleanupResult {
    pub cleaned: usize,
    pub freed_bytes: Option<u64>,
}

#[tauri::command]
pub fn get_diagnostics(state: State<'_, AppState>) -> AppResult<Diagnostics> {
    let detection = chrome_locator::detect();
    let records = environment_repo::list_session_records(state.db())?;
    let environments = environment_repo::list(state.db())?;
    let settings = settings_repo::get(state.db())?;

    let mut stale_lock_count = 0;
    let mut crashed_session_count = 0;
    for env in &environments {
        if let Some(lock) = profile_manager::read_lock(state.data_dir(), &env.id)? {
            if !process_manager::pid_alive(lock.pid) {
                stale_lock_count += 1;
            }
        }
    }
    for record in &records {
        if !process_manager::pid_alive(record.pid) {
            crashed_session_count += 1;
        }
    }

    Ok(Diagnostics {
        chrome: ChromeDiagnostics {
            found: detection.found,
            path: detection.path,
            version: detection.version,
            searched_paths: detection.searched_paths,
            launchable: detection.found,
            cdp_test_ok: false,
            error: detection.error,
        },
        data: DataDiagnostics {
            data_dir: state.data_dir().to_string_lossy().to_string(),
            sqlite_path: state.db().db_path().to_string_lossy().to_string(),
            profiles_total_size: dir_size(&state.data_dir().join("profiles")),
            runs_total_size: dir_size(&state.data_dir().join("runs")),
        },
        runtime: RuntimeDiagnostics {
            running_browser_count: state
                .sessions()
                .list()
                .iter()
                .filter(|session| process_manager::pid_alive(session.pid))
                .count(),
            remembered_session_count: records.len(),
            current_queue_concurrency: settings.default_concurrency,
            stale_process_count: crashed_session_count,
        },
        proxy: ProxyDiagnostics {
            last_test_status: None,
            last_test_at: None,
            message: None,
        },
        recovery: RecoveryDiagnostics {
            stale_lock_count,
            crashed_session_count,
            interrupted_run_count: run_repo::count_runs_by_status(
                state.db(),
                TaskRunStatus::Interrupted,
            )?,
        },
        warnings: Vec::new(),
        generated_at: Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn cleanup_stale_sessions(state: State<'_, AppState>) -> AppResult<CleanupResult> {
    let mut cleaned = 0;
    for record in environment_repo::list_session_records(state.db())? {
        if !process_manager::pid_alive(record.pid) {
            environment_repo::delete_session_record(state.db(), &record.environment_id)?;
            profile_manager::remove_lock(state.data_dir(), &record.environment_id)?;
            cleaned += 1;
        }
    }
    for env in environment_repo::list(state.db())? {
        if let Some(lock) = profile_manager::read_lock(state.data_dir(), &env.id)? {
            if !process_manager::pid_alive(lock.pid) {
                profile_manager::remove_lock(state.data_dir(), &env.id)?;
                cleaned += 1;
            }
        }
    }
    Ok(CleanupResult {
        cleaned,
        freed_bytes: None,
    })
}

#[tauri::command]
pub fn cleanup_temp_files(state: State<'_, AppState>) -> AppResult<CleanupResult> {
    let temp_dir = state.data_dir().join("temp");
    let freed_bytes = dir_size(&temp_dir);
    let cleaned = count_entries(&temp_dir);
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir)?;
    }
    std::fs::create_dir_all(temp_dir.join("proxy-extensions"))?;
    Ok(CleanupResult {
        cleaned,
        freed_bytes: Some(freed_bytes),
    })
}

fn dir_size(path: &std::path::Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                dir_size(&path)
            } else {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn count_entries(path: &std::path::Path) -> usize {
    if !path.exists() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                1 + count_entries(&path)
            } else {
                1
            }
        })
        .sum()
}

#[allow(dead_code)]
fn _status_for_doc() -> RuntimeStatus {
    RuntimeStatus::Stopped
}
