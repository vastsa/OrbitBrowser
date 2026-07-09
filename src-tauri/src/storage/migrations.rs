use chrono::Utc;
use rusqlite::{params, Connection};
use std::path::Path;

pub fn run(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("../../migrations/001_init.sql"))?;
    ensure_column(
        conn,
        "run_batches",
        "options_json",
        "ALTER TABLE run_batches ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        conn,
        "environments",
        "geolocation_latitude",
        "ALTER TABLE environments ADD COLUMN geolocation_latitude REAL",
    )?;
    ensure_column(
        conn,
        "environments",
        "geolocation_longitude",
        "ALTER TABLE environments ADD COLUMN geolocation_longitude REAL",
    )?;
    ensure_column(
        conn,
        "environments",
        "user_agent",
        "ALTER TABLE environments ADD COLUMN user_agent TEXT",
    )?;
    ensure_column(
        conn,
        "environments",
        "platform",
        "ALTER TABLE environments ADD COLUMN platform TEXT",
    )?;
    ensure_column(
        conn,
        "environments",
        "web_rtc_protection",
        "ALTER TABLE environments ADD COLUMN web_rtc_protection INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        conn,
        "settings",
        "aigc_base_url",
        "ALTER TABLE settings ADD COLUMN aigc_base_url TEXT",
    )?;
    ensure_column(
        conn,
        "settings",
        "aigc_model",
        "ALTER TABLE settings ADD COLUMN aigc_model TEXT",
    )?;
    ensure_column(
        conn,
        "settings",
        "aigc_api_key",
        "ALTER TABLE settings ADD COLUMN aigc_api_key TEXT",
    )?;

    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT OR IGNORE INTO settings (
          id, chrome_path, default_concurrency, default_locale, default_timezone_id,
          default_viewport_width, default_viewport_height, data_dir, created_at, updated_at
        )
        VALUES (1, NULL, 2, 'zh-CN', 'auto', 1280, 800, ?1, ?2, ?2)
        "#,
        params![data_dir.to_string_lossy(), now],
    )?;
    conn.execute(
        r#"
        UPDATE settings
        SET default_timezone_id = 'auto',
            updated_at = ?1
        WHERE id = 1
          AND default_timezone_id = 'Asia/Shanghai'
        "#,
        params![now],
    )?;

    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == column) {
        conn.execute_batch(alter_sql)?;
    }
    Ok(())
}
