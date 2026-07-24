use crate::app_state::AppState;
use crate::browser::camoufox_locator::{self, CamoufoxDetectionResult, CamoufoxInstallStage};
use crate::browser::chrome_locator::{self, ChromeDetectionResult};
use crate::domain::settings::{SaveSettingsInput, Settings};
use crate::errors::{AppError, AppResult};
use crate::storage::settings_repo;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

const CAMOUFOX_INSTALL_PROGRESS_EVENT: &str = "camoufox_install_progress";
static CAMOUFOX_INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum CamoufoxInstallStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
struct CamoufoxInstallProgressEvent {
    operation_id: String,
    stage: Option<CamoufoxInstallStage>,
    status: CamoufoxInstallStatus,
    percent: u8,
    message: Option<String>,
}

impl CamoufoxInstallProgressEvent {
    fn new(
        operation_id: &str,
        stage: Option<CamoufoxInstallStage>,
        status: CamoufoxInstallStatus,
        percent: u8,
        message: Option<String>,
    ) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            stage,
            status,
            percent: percent.min(100),
            message,
        }
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    let mut settings = settings_repo::get(state.db())?;
    // 未配置 Chrome 路径时自动检测并持久化，避免环境页误报“未配置/检测不到”。
    if settings
        .chrome_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        let detection = chrome_locator::detect();
        if let Some(path) = detection.path.filter(|value| !value.trim().is_empty()) {
            settings = settings_repo::save(
                state.db(),
                SaveSettingsInput {
                    chrome_path: Some(path),
                    camoufox_python_path: settings.camoufox_python_path.clone(),
                    default_concurrency: settings.default_concurrency,
                    default_locale: settings.default_locale.clone(),
                    default_timezone_id: settings.default_timezone_id.clone(),
                    default_viewport_width: settings.default_viewport_width,
                    default_viewport_height: settings.default_viewport_height,
                    aigc_base_url: settings.aigc_base_url.clone(),
                    aigc_model: settings.aigc_model.clone(),
                    aigc_api_key: settings.aigc_api_key.clone(),
                },
            )?;
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, input: SaveSettingsInput) -> AppResult<Settings> {
    settings_repo::save(state.db(), input)
}

#[tauri::command]
pub fn detect_chrome() -> ChromeDetectionResult {
    chrome_locator::detect()
}

#[tauri::command]
pub fn validate_chrome_path(path: String) -> AppResult<ChromeDetectionResult> {
    chrome_locator::validate_path(&path)
}

#[tauri::command]
pub fn detect_camoufox() -> CamoufoxDetectionResult {
    camoufox_locator::detect()
}

#[tauri::command]
pub fn validate_camoufox_python_path(path: String) -> AppResult<CamoufoxDetectionResult> {
    camoufox_locator::validate_python_path(&path)
}

#[tauri::command]
pub async fn install_camoufox(
    app: AppHandle,
    operation_id: String,
) -> AppResult<CamoufoxDetectionResult> {
    let _install_guard = match CAMOUFOX_INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let error = AppError::new(
                "camoufox_install_in_progress",
                "Another Camoufox installation is already running",
            )
            .details(json!({ "requestedOperationId": &operation_id }))
            .retryable(true);
            emit_camoufox_install_progress(
                &app,
                &operation_id,
                None,
                CamoufoxInstallStatus::Failed,
                0,
                Some(error.message.clone()),
            );
            return Err(error);
        }
    };

    let progress_app = app.clone();
    let progress_operation_id = operation_id.clone();
    let last_percent = Arc::new(AtomicU8::new(0));
    let progress_percent = last_percent.clone();
    let result = camoufox_locator::install(move |stage, percent| {
        progress_percent.store(percent, Ordering::Relaxed);
        emit_camoufox_install_progress(
            &progress_app,
            &progress_operation_id,
            Some(stage),
            CamoufoxInstallStatus::Running,
            percent,
            None,
        );
    })
    .await;

    match result {
        Ok(detection) => {
            emit_camoufox_install_progress(
                &app,
                &operation_id,
                None,
                CamoufoxInstallStatus::Completed,
                100,
                None,
            );
            Ok(detection)
        }
        Err(error) => {
            emit_camoufox_install_progress(
                &app,
                &operation_id,
                None,
                CamoufoxInstallStatus::Failed,
                last_percent.load(Ordering::Relaxed),
                Some(error.message.clone()),
            );
            Err(error)
        }
    }
}

fn emit_camoufox_install_progress(
    app: &AppHandle,
    operation_id: &str,
    stage: Option<CamoufoxInstallStage>,
    status: CamoufoxInstallStatus,
    percent: u8,
    message: Option<String>,
) {
    let _ = app.emit(
        CAMOUFOX_INSTALL_PROGRESS_EVENT,
        CamoufoxInstallProgressEvent::new(operation_id, stage, status, percent, message),
    );
}

#[tauri::command]
pub fn open_data_dir(state: State<'_, AppState>) -> AppResult<()> {
    super::open_path(state.data_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camoufox_progress_event_preserves_frontend_contract() {
        let event = CamoufoxInstallProgressEvent::new(
            "operation-1",
            Some(CamoufoxInstallStage::FetchingBrowser),
            CamoufoxInstallStatus::Running,
            120,
            None,
        );
        let value = serde_json::to_value(event).expect("progress event should serialize");

        assert_eq!(value["operation_id"], "operation-1");
        assert_eq!(value["stage"], "fetching_browser");
        assert_eq!(value["status"], "running");
        assert_eq!(value["percent"], 100);
        assert!(value["message"].is_null());
    }
}
