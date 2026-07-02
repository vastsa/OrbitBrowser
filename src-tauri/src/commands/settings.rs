use crate::app_state::AppState;
use crate::browser::chrome_locator::{self, ChromeDetectionResult};
use crate::domain::settings::{SaveSettingsInput, Settings};
use crate::errors::AppResult;
use crate::storage::settings_repo;
use tauri::State;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    settings_repo::get(state.db())
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
pub fn open_data_dir(state: State<'_, AppState>) -> AppResult<()> {
    super::open_path(state.data_dir())
}
