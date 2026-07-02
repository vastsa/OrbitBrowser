use crate::domain::run::{RunBatch, RunOptions, RunTaskInput, TaskRun, TaskRunStatus};
use crate::errors::{AppError, AppResult};
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;

pub fn create_queued_batch(db: &Db, input: RunTaskInput, timeout_sec: i64) -> AppResult<RunBatch> {
    if input.environment_ids.is_empty() {
        return Err(AppError::new(
            "validation_error",
            "Select at least one environment",
        ));
    }

    let options = input.options.unwrap_or_default();
    let options_json = serde_json::to_string(&options)?;
    let max_concurrency = options.max_concurrency.max(1);
    let conn = db.connect()?;
    let batch_id = format!("batch_{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        r#"
        INSERT INTO run_batches (
          id, task_id, total_count, queued_count, running_count, succeeded_count,
          failed_count, cancelled_count, options_json, created_at, finished_at
        )
        VALUES (?1, ?2, ?3, ?3, 0, 0, 0, 0, ?4, ?5, NULL)
        "#,
        params![
            batch_id,
            input.task_id,
            input.environment_ids.len() as i64,
            options_json,
            now
        ],
    )?;

    for environment_id in input.environment_ids {
        let run_id = format!("run_{}", Uuid::new_v4());
        let artifacts_dir = format!("runs/{run_id}");
        tx.execute(
            r#"
            INSERT INTO task_runs (
              id, batch_id, task_id, environment_id, status, attempt, timeout_sec,
              queued_at, started_at, finished_at, error_code, error_message, artifacts_dir
            )
            VALUES (?1, ?2, ?3, ?4, 'queued', 1, ?5, ?6, NULL, NULL, NULL, NULL, ?7)
            "#,
            params![
                run_id,
                batch_id,
                input.task_id,
                environment_id,
                timeout_sec,
                now,
                artifacts_dir
            ],
        )?;
    }

    tx.commit()?;
    let mut batch = get_batch(db, &batch_id)?;
    if max_concurrency > batch.total_count {
        batch.running_count = 0;
    }
    Ok(batch)
}

pub fn list_runs(db: &Db) -> AppResult<Vec<TaskRun>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, batch_id, task_id, environment_id, status, attempt, timeout_sec,
               queued_at, started_at, finished_at, error_code, error_message, artifacts_dir
        FROM task_runs
        ORDER BY queued_at DESC
        LIMIT 200
        "#,
    )?;
    let rows = stmt.query_map([], row_to_run)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn list_runs_by_batch(db: &Db, batch_id: &str) -> AppResult<Vec<TaskRun>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, batch_id, task_id, environment_id, status, attempt, timeout_sec,
               queued_at, started_at, finished_at, error_code, error_message, artifacts_dir
        FROM task_runs
        WHERE batch_id = ?1
        ORDER BY queued_at ASC
        "#,
    )?;
    let rows = stmt.query_map(params![batch_id], row_to_run)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn get_run(db: &Db, run_id: &str) -> AppResult<TaskRun> {
    let conn = db.connect()?;
    conn.query_row(
        r#"
        SELECT id, batch_id, task_id, environment_id, status, attempt, timeout_sec,
               queued_at, started_at, finished_at, error_code, error_message, artifacts_dir
        FROM task_runs
        WHERE id = ?1
        "#,
        params![run_id],
        row_to_run,
    )
    .optional()?
    .ok_or_else(|| AppError::new("task_not_found", "Run does not exist"))
}

pub fn create_retry_run(db: &Db, run_id: &str) -> AppResult<TaskRun> {
    let source = get_run(db, run_id)?;
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let retry_id = format!("run_{}", Uuid::new_v4());
    let artifacts_dir = format!("runs/{retry_id}");
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        r#"
        INSERT INTO task_runs (
          id, batch_id, task_id, environment_id, status, attempt, timeout_sec,
          queued_at, started_at, finished_at, error_code, error_message, artifacts_dir
        )
        VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, NULL, NULL, NULL, NULL, ?8)
        "#,
        params![
            retry_id,
            source.batch_id,
            source.task_id,
            source.environment_id,
            source.attempt + 1,
            source.timeout_sec,
            now,
            artifacts_dir
        ],
    )?;

    if let Some(batch_id) = &source.batch_id {
        tx.execute(
            r#"
            UPDATE run_batches
            SET total_count = total_count + 1,
                queued_count = queued_count + 1,
                finished_at = NULL
            WHERE id = ?1
            "#,
            params![batch_id],
        )?;
    }

    tx.commit()?;
    get_run(db, &retry_id)
}

pub fn list_batches_with_queued_runs(db: &Db) -> AppResult<Vec<RunBatch>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT DISTINCT b.id, b.task_id, b.total_count, b.queued_count, b.running_count,
               b.succeeded_count, b.failed_count, b.cancelled_count, b.options_json,
               b.created_at, b.finished_at
        FROM run_batches b
        INNER JOIN task_runs r ON r.batch_id = b.id
        WHERE r.status = 'queued'
        ORDER BY b.created_at ASC
        "#,
    )?;
    let rows = stmt.query_map([], row_to_batch)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn mark_interrupted_on_startup(db: &Db) -> AppResult<usize> {
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        r#"
        UPDATE task_runs
        SET status = 'interrupted',
            finished_at = ?1,
            error_code = 'app_restarted',
            error_message = 'The app found unfinished tasks from the previous launch and marked them as interrupted.'
        WHERE status IN ('starting', 'running', 'cancel_requested')
        "#,
        params![now],
    )?;
    refresh_all_batch_counts(db)?;
    Ok(affected)
}

pub fn set_status(db: &Db, run_id: &str, status: TaskRunStatus) -> AppResult<()> {
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let status_text = status_to_str(&status);
    let affected = conn.execute(
        r#"
        UPDATE task_runs
        SET status = ?1,
            finished_at = CASE WHEN ?1 IN ('cancelled', 'failed', 'succeeded', 'timed_out', 'interrupted') THEN ?2 ELSE finished_at END
        WHERE id = ?3
        "#,
        params![status_text, now, run_id],
    )?;
    if affected == 0 {
        return Err(AppError::new("task_not_found", "Run does not exist"));
    }
    refresh_batch_counts(db, run_id)
}

pub fn mark_started(db: &Db, run_id: &str) -> AppResult<()> {
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        r#"
        UPDATE task_runs
        SET status = 'running',
            started_at = COALESCE(started_at, ?1)
        WHERE id = ?2
        "#,
        params![now, run_id],
    )?;
    if affected == 0 {
        return Err(AppError::new("task_not_found", "Run does not exist"));
    }
    refresh_batch_counts(db, run_id)
}

pub fn mark_finished(
    db: &Db,
    run_id: &str,
    status: TaskRunStatus,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> AppResult<()> {
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let status_text = status_to_str(&status);
    let affected = conn.execute(
        r#"
        UPDATE task_runs
        SET status = ?1,
            finished_at = ?2,
            error_code = ?3,
            error_message = ?4
        WHERE id = ?5
        "#,
        params![status_text, now, error_code, error_message, run_id],
    )?;
    if affected == 0 {
        return Err(AppError::new("task_not_found", "Run does not exist"));
    }
    refresh_batch_counts(db, run_id)
}

pub fn get_batch(db: &Db, id: &str) -> AppResult<RunBatch> {
    let conn = db.connect()?;
    conn.query_row(
        r#"
        SELECT id, task_id, total_count, queued_count, running_count, succeeded_count,
               failed_count, cancelled_count, options_json, created_at, finished_at
        FROM run_batches
        WHERE id = ?1
        "#,
        params![id],
        row_to_batch,
    )
    .optional()?
    .ok_or_else(|| AppError::new("task_not_found", "Batch does not exist"))
}

pub fn refresh_all_batch_counts(db: &Db) -> AppResult<()> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare("SELECT id FROM run_batches")?;
    let batch_ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for batch_id in batch_ids {
        conn.execute(
            r#"
            UPDATE run_batches
            SET queued_count = (
                  SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'queued'
                ),
                running_count = (
                  SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status IN ('starting', 'running', 'cancel_requested')
                ),
                succeeded_count = (
                  SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'succeeded'
                ),
                failed_count = (
                  SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status IN ('failed', 'timed_out', 'interrupted')
                ),
                cancelled_count = (
                  SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'cancelled'
                ),
                finished_at = CASE
                  WHEN (
                    SELECT COUNT(*) FROM task_runs
                    WHERE batch_id = ?1 AND status IN ('queued', 'starting', 'running', 'cancel_requested')
                  ) = 0 THEN COALESCE(finished_at, ?2)
                  ELSE NULL
                END
            WHERE id = ?1
            "#,
            params![batch_id, Utc::now().to_rfc3339()],
        )?;
    }

    Ok(())
}

pub fn count_runs_by_status(db: &Db, status: TaskRunStatus) -> AppResult<usize> {
    let conn = db.connect()?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_runs WHERE status = ?1",
        params![status_to_str(&status)],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

pub fn delete_runs_for_task(db: &Db, task_id: &str) -> AppResult<Vec<String>> {
    let conn = db.connect()?;
    let artifact_dirs = artifact_dirs_for_task(&conn, task_id)?;
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM task_runs WHERE task_id = ?1)",
        params![task_id],
    )?;
    tx.execute(
        "DELETE FROM run_logs WHERE run_id IN (SELECT id FROM task_runs WHERE task_id = ?1)",
        params![task_id],
    )?;
    tx.execute("DELETE FROM task_runs WHERE task_id = ?1", params![task_id])?;
    tx.execute(
        "DELETE FROM run_batches WHERE task_id = ?1",
        params![task_id],
    )?;
    tx.commit()?;

    Ok(artifact_dirs)
}

pub fn delete_runs_for_environment(db: &Db, environment_id: &str) -> AppResult<Vec<String>> {
    let conn = db.connect()?;
    let artifact_dirs = artifact_dirs_for_environment(&conn, environment_id)?;
    let batch_ids = batch_ids_for_environment(&conn, environment_id)?;
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM task_runs WHERE environment_id = ?1)",
        params![environment_id],
    )?;
    tx.execute(
        "DELETE FROM run_logs WHERE run_id IN (SELECT id FROM task_runs WHERE environment_id = ?1)",
        params![environment_id],
    )?;
    tx.execute(
        "DELETE FROM task_runs WHERE environment_id = ?1",
        params![environment_id],
    )?;

    for batch_id in &batch_ids {
        tx.execute(
            "DELETE FROM run_batches WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM task_runs WHERE batch_id = ?1)",
            params![batch_id],
        )?;
    }
    tx.commit()?;

    refresh_all_batch_counts(db)?;
    Ok(artifact_dirs)
}

pub fn delete_run(db: &Db, run_id: &str) -> AppResult<Option<String>> {
    let run = get_run(db, run_id)?;
    let conn = db.connect()?;
    let batch_id = run.batch_id.clone();
    let artifact_dir = run.artifacts_dir.clone();
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "DELETE FROM run_artifacts WHERE run_id = ?1",
        params![run_id],
    )?;
    tx.execute("DELETE FROM run_logs WHERE run_id = ?1", params![run_id])?;
    tx.execute("DELETE FROM task_runs WHERE id = ?1", params![run_id])?;

    if let Some(batch_id) = &batch_id {
        tx.execute(
            "DELETE FROM run_batches WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM task_runs WHERE batch_id = ?1)",
            params![batch_id],
        )?;
    }

    tx.commit()?;
    refresh_all_batch_counts(db)?;
    Ok(artifact_dir)
}

pub fn refresh_batch_counts(db: &Db, run_id: &str) -> AppResult<()> {
    let conn = db.connect()?;
    let batch_id: Option<String> = conn
        .query_row(
            "SELECT batch_id FROM task_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let Some(batch_id) = batch_id else {
        return Ok(());
    };

    conn.execute(
        r#"
        UPDATE run_batches
        SET queued_count = (
              SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'queued'
            ),
            running_count = (
              SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status IN ('starting', 'running', 'cancel_requested')
            ),
            succeeded_count = (
              SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'succeeded'
            ),
            failed_count = (
              SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status IN ('failed', 'timed_out', 'interrupted')
            ),
            cancelled_count = (
              SELECT COUNT(*) FROM task_runs WHERE batch_id = ?1 AND status = 'cancelled'
            ),
            finished_at = CASE
              WHEN (
                SELECT COUNT(*) FROM task_runs
                WHERE batch_id = ?1 AND status IN ('queued', 'starting', 'running', 'cancel_requested')
              ) = 0 THEN ?2
              ELSE finished_at
            END
        WHERE id = ?1
        "#,
        params![batch_id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn artifact_dirs_for_task(conn: &rusqlite::Connection, task_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT artifacts_dir FROM task_runs WHERE task_id = ?1 AND artifacts_dir IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![task_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

fn artifact_dirs_for_environment(
    conn: &rusqlite::Connection,
    environment_id: &str,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT artifacts_dir FROM task_runs WHERE environment_id = ?1 AND artifacts_dir IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![environment_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

fn batch_ids_for_environment(
    conn: &rusqlite::Connection,
    environment_id: &str,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT batch_id FROM task_runs WHERE environment_id = ?1 AND batch_id IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![environment_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

fn row_to_run(row: &Row<'_>) -> rusqlite::Result<TaskRun> {
    let status: String = row.get(4)?;
    Ok(TaskRun {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        task_id: row.get(2)?,
        environment_id: row.get(3)?,
        status: parse_status(&status),
        attempt: row.get(5)?,
        timeout_sec: row.get(6)?,
        queued_at: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        error_code: row.get(10)?,
        error_message: row.get(11)?,
        artifacts_dir: row.get(12)?,
    })
}

fn row_to_batch(row: &Row<'_>) -> rusqlite::Result<RunBatch> {
    let options_json: String = row.get(8)?;
    let options = serde_json::from_str(&options_json).unwrap_or_default();
    Ok(RunBatch {
        id: row.get(0)?,
        task_id: row.get(1)?,
        total_count: row.get(2)?,
        queued_count: row.get(3)?,
        running_count: row.get(4)?,
        succeeded_count: row.get(5)?,
        failed_count: row.get(6)?,
        cancelled_count: row.get(7)?,
        options,
        created_at: row.get(9)?,
        finished_at: row.get(10)?,
    })
}

pub fn status_to_str(status: &TaskRunStatus) -> &'static str {
    match status {
        TaskRunStatus::Queued => "queued",
        TaskRunStatus::Starting => "starting",
        TaskRunStatus::Running => "running",
        TaskRunStatus::CancelRequested => "cancel_requested",
        TaskRunStatus::Succeeded => "succeeded",
        TaskRunStatus::Failed => "failed",
        TaskRunStatus::Cancelled => "cancelled",
        TaskRunStatus::TimedOut => "timed_out",
        TaskRunStatus::Interrupted => "interrupted",
    }
}

fn parse_status(value: &str) -> TaskRunStatus {
    match value {
        "starting" => TaskRunStatus::Starting,
        "running" => TaskRunStatus::Running,
        "cancel_requested" => TaskRunStatus::CancelRequested,
        "succeeded" => TaskRunStatus::Succeeded,
        "failed" => TaskRunStatus::Failed,
        "cancelled" => TaskRunStatus::Cancelled,
        "timed_out" => TaskRunStatus::TimedOut,
        "interrupted" => TaskRunStatus::Interrupted,
        _ => TaskRunStatus::Queued,
    }
}

#[allow(dead_code)]
fn _default_options() -> RunOptions {
    RunOptions::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::environment::{BrowserKind, EnvironmentMode, SaveEnvironmentInput};
    use crate::domain::proxy::ProxyConfig;
    use crate::domain::task::SaveTaskInput;
    use crate::storage::{artifact_repo, db::Db, environment_repo, log_repo, task_repo};
    use serde_json::json;
    use std::path::PathBuf;

    fn test_db() -> AppResult<(Db, PathBuf)> {
        let data_dir =
            std::env::temp_dir().join(format!("orbit-run-repo-test-{}", uuid::Uuid::new_v4()));
        let db = Db::initialize(data_dir.clone())?;
        Ok((db, data_dir))
    }

    fn save_test_task(db: &Db) -> AppResult<crate::domain::task::AutomationTask> {
        task_repo::save(
            db,
            SaveTaskInput {
                id: Some("task_delete_run".to_string()),
                name: "Delete Run Test".to_string(),
                description: None,
                script: "log.info('ok');".to_string(),
                timeout_sec: 30,
                permissions: json!({}),
            },
        )
    }

    fn save_test_environment(db: &Db) -> AppResult<crate::domain::environment::Environment> {
        environment_repo::save(
            db,
            SaveEnvironmentInput {
                id: Some("env_delete_run".to_string()),
                name: "Delete Run Environment".to_string(),
                group_id: None,
                tags: Vec::new(),
                notes: None,
                browser_kind: BrowserKind::Chrome,
                chrome_path_override: None,
                proxy_config: ProxyConfig::default(),
                locale: "en-US".to_string(),
                timezone_id: Some("UTC".to_string()),
                geolocation_latitude: None,
                geolocation_longitude: None,
                user_agent: None,
                platform: None,
                web_rtc_protection: true,
                viewport_width: 1280,
                viewport_height: 800,
                device_scale_factor: 1.0,
                environment_mode: EnvironmentMode::Standard,
                seed: None,
                headless: false,
                start_url: Some("about:blank".to_string()),
            },
        )
    }

    #[test]
    fn delete_run_removes_logs_artifacts_and_empty_batch() -> AppResult<()> {
        let (db, data_dir) = test_db()?;
        let task = save_test_task(&db)?;
        let environment = save_test_environment(&db)?;
        let batch = create_queued_batch(
            &db,
            RunTaskInput {
                task_id: task.id.clone(),
                environment_ids: vec![environment.id],
                options: Some(RunOptions::default()),
            },
            task.timeout_sec,
        )?;
        let run = list_runs_by_batch(&db, &batch.id)?
            .into_iter()
            .next()
            .expect("queued run should exist");

        log_repo::append(&db, &run.id, "info", "ready", None)?;
        artifact_repo::create(&db, &run.id, "json", "result", "runs/run-test/result.json")?;

        let artifact_dir = delete_run(&db, &run.id)?;

        assert_eq!(artifact_dir.as_deref(), run.artifacts_dir.as_deref());
        assert_eq!(get_run(&db, &run.id).unwrap_err().code, "task_not_found");
        assert!(log_repo::list(&db, &run.id)?.is_empty());
        assert!(artifact_repo::list(&db, &run.id)?.is_empty());

        let conn = db.connect()?;
        let batch_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM run_batches WHERE id = ?1",
            rusqlite::params![batch.id],
            |row| row.get(0),
        )?;
        assert_eq!(batch_count, 0);

        std::fs::remove_dir_all(data_dir)?;
        Ok(())
    }
}
