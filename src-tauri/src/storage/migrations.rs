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
        "camoufox_python_path",
        "ALTER TABLE settings ADD COLUMN camoufox_python_path TEXT",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_adds_camoufox_python_path_to_existing_settings_table_idempotently() {
        let conn = Connection::open_in_memory().expect("in-memory database should open");
        conn.execute_batch(
            r#"
            CREATE TABLE settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              chrome_path TEXT,
              default_concurrency INTEGER NOT NULL DEFAULT 2,
              default_locale TEXT NOT NULL DEFAULT 'zh-CN',
              default_timezone_id TEXT NOT NULL DEFAULT 'auto',
              default_viewport_width INTEGER NOT NULL DEFAULT 1280,
              default_viewport_height INTEGER NOT NULL DEFAULT 800,
              data_dir TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO settings (
              id, chrome_path, default_concurrency, default_locale,
              default_timezone_id, default_viewport_width,
              default_viewport_height, data_dir, created_at, updated_at
            ) VALUES (
              1, '/existing/chrome', 2, 'zh-CN', 'auto', 1280, 800,
              '/existing/data', 'created', 'updated'
            );
            "#,
        )
        .expect("legacy settings table should be created");

        let data_dir = Path::new("/tmp/orbit-migration-test");
        run(&conn, data_dir).expect("first migration should succeed");
        run(&conn, data_dir).expect("repeated migration should succeed");

        let columns = conn
            .prepare("PRAGMA table_info(settings)")
            .expect("table info query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("settings columns should query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("settings columns should be readable");
        assert_eq!(
            columns
                .iter()
                .filter(|column| column.as_str() == "camoufox_python_path")
                .count(),
            1
        );

        let (chrome_path, camoufox_python_path): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT chrome_path, camoufox_python_path FROM settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("existing settings row should remain readable");
        assert_eq!(chrome_path.as_deref(), Some("/existing/chrome"));
        assert_eq!(camoufox_python_path, None);
    }
}
