use crate::domain::task::{AutomationTask, SaveTaskInput};
use crate::errors::{AppError, AppResult};
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;

pub fn list(db: &Db) -> AppResult<Vec<AutomationTask>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, name, description, script, timeout_sec, api_version,
               permissions_json, created_at, updated_at, deleted_at
        FROM automation_tasks
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        "#,
    )?;
    let rows = stmt.query_map([], row_to_task)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn get(db: &Db, id: &str) -> AppResult<AutomationTask> {
    let conn = db.connect()?;
    conn.query_row(
        r#"
        SELECT id, name, description, script, timeout_sec, api_version,
               permissions_json, created_at, updated_at, deleted_at
        FROM automation_tasks
        WHERE id = ?1 AND deleted_at IS NULL
        "#,
        params![id],
        row_to_task,
    )
    .optional()?
    .ok_or_else(|| AppError::new("task_not_found", "Task does not exist or was deleted"))
}

pub fn save(db: &Db, input: SaveTaskInput) -> AppResult<AutomationTask> {
    if input.name.trim().is_empty() {
        return Err(AppError::new("validation_error", "Task name is required"));
    }
    if input.script.trim().is_empty() {
        return Err(AppError::new(
            "script_compile_error",
            "Script cannot be empty",
        ));
    }

    let conn = db.connect()?;
    let id = input
        .id
        .unwrap_or_else(|| format!("task_{}", Uuid::new_v4()));
    let now = Utc::now().to_rfc3339();
    let permissions_json = serde_json::to_string(&input.permissions)?;
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM automation_tasks WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let created_at = existing_created_at.unwrap_or_else(|| now.clone());

    conn.execute(
        r#"
        INSERT INTO automation_tasks (
          id, name, description, script, timeout_sec, api_version, permissions_json,
          created_at, updated_at, deleted_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 'v1', ?6, ?7, ?8, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          script = excluded.script,
          timeout_sec = excluded.timeout_sec,
          permissions_json = excluded.permissions_json,
          updated_at = excluded.updated_at,
          deleted_at = NULL
        "#,
        params![
            id,
            input.name.trim(),
            input.description.filter(|value| !value.trim().is_empty()),
            input.script,
            input.timeout_sec.clamp(1, 24 * 60 * 60),
            permissions_json,
            created_at,
            now
        ],
    )?;

    get(db, &id)
}

pub fn hard_delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.connect()?;
    let affected = conn.execute("DELETE FROM automation_tasks WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::new("task_not_found", "Task does not exist"));
    }
    Ok(())
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<AutomationTask> {
    let permissions_json: String = row.get(6)?;
    let permissions =
        serde_json::from_str(&permissions_json).unwrap_or_else(|_| serde_json::json!({}));
    Ok(AutomationTask {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        script: row.get(3)?,
        timeout_sec: row.get(4)?,
        api_version: row.get(5)?,
        permissions,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}
