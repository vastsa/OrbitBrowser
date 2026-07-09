#![allow(dead_code)]

use crate::domain::artifact::RunArtifact;
use crate::errors::{AppError, AppResult};
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::{params, Row};
use uuid::Uuid;

pub fn create(
    db: &Db,
    run_id: &str,
    kind: &str,
    label: &str,
    path: &str,
) -> AppResult<RunArtifact> {
    let conn = db.connect()?;
    let artifact = RunArtifact {
        id: format!("artifact_{}", Uuid::new_v4()),
        run_id: run_id.to_string(),
        kind: kind.to_string(),
        label: label.to_string(),
        path: path.to_string(),
        created_at: Utc::now().to_rfc3339(),
    };
    conn.execute(
        r#"
        INSERT INTO run_artifacts (id, run_id, kind, label, path, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            artifact.id,
            artifact.run_id,
            artifact.kind,
            artifact.label,
            artifact.path,
            artifact.created_at
        ],
    )?;
    Ok(artifact)
}

pub fn list(db: &Db, run_id: &str) -> AppResult<Vec<RunArtifact>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, run_id, kind, label, path, created_at
        FROM run_artifacts
        WHERE run_id = ?1
        ORDER BY created_at ASC
        "#,
    )?;
    let rows = stmt.query_map(params![run_id], row_to_artifact)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn get_by_path(db: &Db, path: &str) -> AppResult<RunArtifact> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, run_id, kind, label, path, created_at FROM run_artifacts WHERE path = ?1",
    )?;
    stmt.query_row([path], row_to_artifact).map_err(Into::into)
}

fn row_to_artifact(row: &Row<'_>) -> rusqlite::Result<RunArtifact> {
    Ok(RunArtifact {
        id: row.get(0)?,
        run_id: row.get(1)?,
        kind: row.get(2)?,
        label: row.get(3)?,
        path: row.get(4)?,
        created_at: row.get(5)?,
    })
}
