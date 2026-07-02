use crate::domain::settings::{SaveSettingsInput, Settings};
use crate::errors::AppResult;
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::params;

pub fn get(db: &Db) -> AppResult<Settings> {
    let conn = db.connect()?;
    let settings = conn.query_row(
        r#"
        SELECT chrome_path, default_concurrency, default_locale, default_timezone_id,
               default_viewport_width, default_viewport_height, data_dir, created_at, updated_at
        FROM settings
        WHERE id = 1
        "#,
        [],
        |row| {
            Ok(Settings {
                chrome_path: row.get(0)?,
                default_concurrency: row.get(1)?,
                default_locale: row.get(2)?,
                default_timezone_id: row.get(3)?,
                default_viewport_width: row.get(4)?,
                default_viewport_height: row.get(5)?,
                data_dir: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )?;
    Ok(settings)
}

pub fn save(db: &Db, input: SaveSettingsInput) -> AppResult<Settings> {
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        UPDATE settings
        SET chrome_path = ?1,
            default_concurrency = ?2,
            default_locale = ?3,
            default_timezone_id = ?4,
            default_viewport_width = ?5,
            default_viewport_height = ?6,
            updated_at = ?7
        WHERE id = 1
        "#,
        params![
            input.chrome_path,
            input.default_concurrency.max(1),
            input.default_locale,
            input.default_timezone_id,
            input.default_viewport_width.max(320),
            input.default_viewport_height.max(240),
            now
        ],
    )?;
    get(db)
}
