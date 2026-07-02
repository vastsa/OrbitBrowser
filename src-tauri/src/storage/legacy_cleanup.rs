use crate::errors::AppResult;
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::params;

pub fn delete_ai_conversations_for_environment(db: &Db, environment_id: &str) -> AppResult<()> {
    if !table_exists(db, "ai_conversations")? {
        return Ok(());
    }
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM ai_conversations WHERE environment_id = ?1",
        params![environment_id],
    )?;
    Ok(())
}

pub fn delete_ai_conversations_for_task(db: &Db, task_id: &str) -> AppResult<()> {
    if !table_exists(db, "ai_conversations")? {
        return Ok(());
    }
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM ai_conversations WHERE task_id = ?1",
        params![task_id],
    )?;
    Ok(())
}

pub fn delete_agent_sessions_for_environment(db: &Db, environment_id: &str) -> AppResult<()> {
    if !table_exists(db, "agent_sessions")? {
        return Ok(());
    }
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM agent_sessions WHERE environment_id = ?1",
        params![environment_id],
    )?;
    Ok(())
}

pub fn clear_agent_task_reference(db: &Db, task_id: &str) -> AppResult<()> {
    if !table_exists(db, "agent_sessions")? {
        return Ok(());
    }
    let conn = db.connect()?;
    conn.execute(
        "UPDATE agent_sessions SET task_id = NULL, updated_at = ?1 WHERE task_id = ?2",
        params![Utc::now().to_rfc3339(), task_id],
    )?;
    Ok(())
}

fn table_exists(db: &Db, table_name: &str) -> AppResult<bool> {
    let conn = db.connect()?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
