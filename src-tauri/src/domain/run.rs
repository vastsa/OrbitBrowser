use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunOptions {
    pub auto_start_browser: bool,
    pub close_browser_after_run: bool,
    pub max_concurrency: i64,
    pub stop_on_first_error: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            auto_start_browser: true,
            close_browser_after_run: false,
            max_concurrency: 2,
            stop_on_first_error: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunTaskInput {
    pub task_id: String,
    pub environment_ids: Vec<String>,
    pub options: Option<RunOptions>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunBatch {
    pub id: String,
    pub task_id: String,
    pub total_count: i64,
    pub queued_count: i64,
    pub running_count: i64,
    pub succeeded_count: i64,
    pub failed_count: i64,
    pub cancelled_count: i64,
    pub options: RunOptions,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskRun {
    pub id: String,
    pub batch_id: Option<String>,
    pub task_id: String,
    pub environment_id: String,
    pub status: TaskRunStatus,
    pub attempt: i64,
    pub timeout_sec: i64,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub artifacts_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Queued,
    Starting,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunLog {
    pub id: String,
    pub run_id: String,
    pub seq: i64,
    pub level: String,
    pub message: String,
    pub data: Option<serde_json::Value>,
    pub created_at: String,
}
