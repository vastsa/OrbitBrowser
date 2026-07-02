#![allow(dead_code)]

use crate::domain::run::RunLog;
use crate::errors::{AppError, AppResult};
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::{params, Row};
use uuid::Uuid;

pub fn append(
    db: &Db,
    run_id: &str,
    level: &str,
    message: &str,
    data: Option<serde_json::Value>,
) -> AppResult<RunLog> {
    let conn = db.connect()?;
    let seq = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM run_logs WHERE run_id = ?1",
        params![run_id],
        |row| row.get::<_, i64>(0),
    )?;
    let log = RunLog {
        id: format!("log_{}", Uuid::new_v4()),
        run_id: run_id.to_string(),
        seq,
        level: level.to_string(),
        message: message.to_string(),
        data,
        created_at: Utc::now().to_rfc3339(),
    };
    conn.execute(
        r#"
        INSERT INTO run_logs (id, run_id, seq, level, message, data_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            log.id,
            log.run_id,
            log.seq,
            log.level,
            log.message,
            log.data.as_ref().map(serde_json::to_string).transpose()?,
            log.created_at
        ],
    )?;
    Ok(log)
}

pub fn list(db: &Db, run_id: &str) -> AppResult<Vec<RunLog>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, run_id, seq, level, message, data_json, created_at
        FROM run_logs
        WHERE run_id = ?1
        ORDER BY seq ASC
        "#,
    )?;
    let rows = stmt.query_map(params![run_id], row_to_log)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

fn row_to_log(row: &Row<'_>) -> rusqlite::Result<RunLog> {
    let data_json: Option<String> = row.get(5)?;
    let data = data_json.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
    Ok(RunLog {
        id: row.get(0)?,
        run_id: row.get(1)?,
        seq: row.get(2)?,
        level: row.get(3)?,
        message: row.get(4)?,
        data,
        created_at: row.get(6)?,
    })
}
