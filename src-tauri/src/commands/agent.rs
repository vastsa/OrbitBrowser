use crate::app_state::AppState;
use crate::browser::runtime_page::BrowserPage;
use crate::commands::environments::start_environment_inner_headed;
use crate::domain::agent::{
    AgentArtifactContent, AgentArtifactRef, AgentBrowserActionInput, AgentHistorySession,
    AgentHistorySnapshot, AgentRecordingEvent, AgentRecordingSummary, ReadAgentArtifactInput,
    SaveAgentArtifactInput, SaveAgentHistoryInput,
};
use crate::domain::environment::BrowserKind;
use crate::errors::{AppError, AppResult};
use crate::storage::environment_repo;
use chrono::Utc;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::State;

const MAX_RECORDING_EVENTS: usize = 2_000;
const AGENT_HISTORY_DIR: &str = "agent-history";
const AGENT_ARTIFACTS_DIR: &str = "artifacts";
const LEGACY_SESSION_ID: &str = "default";

#[derive(Clone)]
struct RecordingHandle {
    started_at: String,
    stop: Arc<AtomicBool>,
    events: Arc<Mutex<Vec<AgentRecordingEvent>>>,
}

static RECORDINGS: OnceLock<Mutex<HashMap<String, RecordingHandle>>> = OnceLock::new();

fn recordings() -> &'static Mutex<HashMap<String, RecordingHandle>> {
    RECORDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_file_id(value: &str, label: &str) -> AppResult<String> {
    let safe_id = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect::<String>();
    if safe_id.is_empty() || safe_id != value {
        return Err(AppError::new(
            "invalid_input",
            format!("{label} contains unsupported characters"),
        ));
    }
    Ok(safe_id)
}

fn agent_history_dir(data_dir: &Path, environment_id: &str) -> AppResult<PathBuf> {
    Ok(data_dir
        .join(AGENT_HISTORY_DIR)
        .join(validate_file_id(environment_id, "Environment id")?))
}

fn legacy_agent_history_path(data_dir: &Path, environment_id: &str) -> AppResult<PathBuf> {
    Ok(data_dir.join(AGENT_HISTORY_DIR).join(format!(
        "{}.jsonl",
        validate_file_id(environment_id, "Environment id")?
    )))
}

fn agent_history_path(
    data_dir: &Path,
    environment_id: &str,
    session_id: &str,
) -> AppResult<PathBuf> {
    if session_id == LEGACY_SESSION_ID {
        let legacy_path = legacy_agent_history_path(data_dir, environment_id)?;
        if legacy_path.exists() {
            return Ok(legacy_path);
        }
    }
    Ok(agent_history_dir(data_dir, environment_id)?.join(format!(
        "{}.jsonl",
        validate_file_id(session_id, "Session id")?
    )))
}

fn agent_artifact_dir(
    data_dir: &Path,
    environment_id: &str,
    session_id: &str,
) -> AppResult<PathBuf> {
    Ok(agent_history_dir(data_dir, environment_id)?
        .join(AGENT_ARTIFACTS_DIR)
        .join(validate_file_id(session_id, "Session id")?))
}

fn agent_artifact_path(
    data_dir: &Path,
    environment_id: &str,
    session_id: &str,
    artifact_id: &str,
) -> AppResult<PathBuf> {
    Ok(
        agent_artifact_dir(data_dir, environment_id, session_id)?.join(format!(
            "{}.json",
            validate_file_id(artifact_id, "Artifact id")?
        )),
    )
}

fn empty_history_snapshot(
    environment_id: String,
    session_id: String,
    path: PathBuf,
) -> AgentHistorySnapshot {
    AgentHistorySnapshot {
        environment_id,
        session_id,
        title: "新对话".to_string(),
        messages: Vec::new(),
        api_messages: Vec::new(),
        created_at: None,
        updated_at: None,
        path: path.to_string_lossy().to_string(),
    }
}

fn fallback_title(messages: &[Value]) -> String {
    messages
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get("content").and_then(Value::as_str))
        .map(|content| {
            let title = content.trim().chars().take(40).collect::<String>();
            if title.is_empty() {
                "新对话".to_string()
            } else {
                title
            }
        })
        .unwrap_or_else(|| "新对话".to_string())
}

fn parse_history_snapshot(
    path: &Path,
    environment_id: &str,
    fallback_session_id: &str,
) -> AppResult<AgentHistorySnapshot> {
    if !path.exists() {
        return Ok(empty_history_snapshot(
            environment_id.to_string(),
            fallback_session_id.to_string(),
            path.to_path_buf(),
        ));
    }

    let content = std::fs::read_to_string(path)?;
    let mut latest: Option<AgentHistorySnapshot> = None;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("agent_history_snapshot") {
            continue;
        }
        let messages = payload
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| fallback_title(&messages));
        latest = Some(AgentHistorySnapshot {
            environment_id: payload
                .get("environment_id")
                .and_then(Value::as_str)
                .unwrap_or(environment_id)
                .to_string(),
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or(fallback_session_id)
                .to_string(),
            title,
            messages,
            api_messages: payload
                .get("api_messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            created_at: payload
                .get("created_at")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            updated_at: value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            path: path.to_string_lossy().to_string(),
        });
    }

    Ok(latest.unwrap_or_else(|| {
        empty_history_snapshot(
            environment_id.to_string(),
            fallback_session_id.to_string(),
            path.to_path_buf(),
        )
    }))
}

fn snapshot_to_session(snapshot: &AgentHistorySnapshot) -> AgentHistorySession {
    AgentHistorySession {
        environment_id: snapshot.environment_id.clone(),
        session_id: snapshot.session_id.clone(),
        title: snapshot.title.clone(),
        created_at: snapshot.created_at.clone(),
        updated_at: snapshot.updated_at.clone(),
        message_count: snapshot.messages.len(),
        path: snapshot.path.clone(),
    }
}

fn agent_message_event(timestamp: &str, message: &Value) -> Value {
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_name = message.get("toolName").and_then(Value::as_str);

    match role {
        "user" => json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": content,
                "orbit_message_id": id
            }
        }),
        "tool" => json!({
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "name": tool_name,
                "output": content,
                "orbit_message_id": id
            }
        }),
        _ => json!({
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": content }],
                "orbit_message_id": id
            }
        }),
    }
}

#[tauri::command]
pub fn list_agent_histories(
    state: State<'_, AppState>,
    environment_id: String,
) -> AppResult<Vec<AgentHistorySession>> {
    let mut sessions = Vec::new();

    let legacy_path = legacy_agent_history_path(state.data_dir(), &environment_id)?;
    if legacy_path.exists() {
        let snapshot = parse_history_snapshot(&legacy_path, &environment_id, LEGACY_SESSION_ID)?;
        sessions.push(snapshot_to_session(&snapshot));
    }

    let dir = agent_history_dir(state.data_dir(), &environment_id)?;
    if dir.exists() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let snapshot = parse_history_snapshot(&path, &environment_id, session_id)?;
            sessions.push(snapshot_to_session(&snapshot));
        }
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn get_agent_history(
    state: State<'_, AppState>,
    environment_id: String,
    session_id: Option<String>,
) -> AppResult<AgentHistorySnapshot> {
    let session_id = session_id.unwrap_or_else(|| LEGACY_SESSION_ID.to_string());
    let path = agent_history_path(state.data_dir(), &environment_id, &session_id)?;
    parse_history_snapshot(&path, &environment_id, &session_id)
}

#[tauri::command]
pub fn save_agent_history(
    state: State<'_, AppState>,
    input: SaveAgentHistoryInput,
) -> AppResult<AgentHistorySnapshot> {
    let session_id = input
        .session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let path = agent_history_path(state.data_dir(), &input.environment_id, &session_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let now = Utc::now().to_rfc3339();
    let existing = parse_history_snapshot(&path, &input.environment_id, &session_id).ok();
    let created_at = existing
        .and_then(|snapshot| snapshot.created_at.or(snapshot.updated_at))
        .unwrap_or_else(|| now.clone());
    let title = fallback_title(&input.messages);
    let mut lines = Vec::with_capacity(input.messages.len() + 2);
    lines.push(json!({
        "timestamp": now,
        "type": "session_meta",
        "payload": {
            "id": session_id,
            "environment_id": input.environment_id,
            "title": title,
            "created_at": created_at,
            "timestamp": now,
            "source": "orbit-browser-agent",
            "format": "codex-jsonl-compatible"
        }
    }));

    for message in &input.messages {
        lines.push(agent_message_event(&now, message));
    }

    lines.push(json!({
        "timestamp": now,
        "type": "event_msg",
        "payload": {
            "type": "agent_history_snapshot",
            "environment_id": input.environment_id,
            "session_id": session_id,
            "title": title,
            "created_at": created_at,
            "messages": input.messages,
            "api_messages": input.api_messages
        }
    }));

    let body = lines
        .into_iter()
        .map(|line| serde_json::to_string(&line))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n")
        + "\n";
    std::fs::write(&path, body)?;

    Ok(AgentHistorySnapshot {
        environment_id: input.environment_id,
        session_id,
        title,
        messages: Vec::new(),
        api_messages: Vec::new(),
        created_at: Some(created_at),
        updated_at: Some(now),
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn delete_agent_history(
    state: State<'_, AppState>,
    environment_id: String,
    session_id: String,
) -> AppResult<()> {
    let path = agent_history_path(state.data_dir(), &environment_id, &session_id)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }

    let artifact_dir = agent_artifact_dir(state.data_dir(), &environment_id, &session_id)?;
    if artifact_dir.exists() {
        std::fs::remove_dir_all(artifact_dir)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn agent_browser_action(
    state: State<'_, AppState>,
    input: AgentBrowserActionInput,
) -> AppResult<serde_json::Value> {
    let mut page = page_for_environment(&state, &input.environment_id).await?;
    match input.action.as_str() {
        "goto" => {
            let url = required_option(input.url, "url")?;
            page.goto(&url, Duration::from_secs(30)).await?;
            Ok(json!(page.context_snapshot(false).await?))
        }
        "click" => {
            let selector = required_option(input.selector, "selector")?;
            page.click(&selector).await?;
            Ok(json!(page.context_snapshot(false).await?))
        }
        "type" => {
            let selector = required_option(input.selector, "selector")?;
            let text = required_option(input.text, "text")?;
            page.type_text(&selector, &text).await?;
            Ok(json!(page.context_snapshot(false).await?))
        }
        "wait" => {
            if let Some(milliseconds) = input.milliseconds {
                tokio::time::sleep(Duration::from_millis(milliseconds)).await;
            } else {
                let selector = required_option(input.selector, "selector")?;
                page.wait_for_selector(&selector, Duration::from_secs(10))
                    .await?;
            }
            Ok(json!(page.context_snapshot(false).await?))
        }
        "context" => Ok(json!(
            page.context_snapshot(input.include_screenshot.unwrap_or(false))
                .await?
        )),
        "evaluate" => {
            let expression = required_option(input.expression, "expression")?;
            Ok(json!({ "value": page.evaluate(&expression).await? }))
        }
        other => Err(AppError::new(
            "agent_action_unsupported",
            format!("Unsupported browser action: {other}"),
        )),
    }
}

#[tauri::command]
pub async fn agent_start_browser_recording(
    state: State<'_, AppState>,
    environment_id: String,
) -> AppResult<AgentRecordingSummary> {
    if let Some(existing) = recordings()
        .lock()
        .ok()
        .and_then(|map| map.get(&environment_id).cloned())
    {
        return Ok(summary(&environment_id, &existing, true, None));
    }

    let mut page = page_for_environment(&state, &environment_id).await?;
    let started_at = Utc::now().to_rfc3339();
    let stop = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let handle = RecordingHandle {
        started_at: started_at.clone(),
        stop: stop.clone(),
        events: events.clone(),
    };

    recordings()
        .lock()
        .map_err(|_| AppError::new("agent_recording_failed", "Recording registry is locked"))?
        .insert(environment_id.clone(), handle.clone());

    let task_environment_id = environment_id.clone();
    let task_stop = stop.clone();
    tokio::spawn(async move {
        while !task_stop.load(Ordering::Relaxed) {
            match page.next_recording_event(Duration::from_millis(750)).await {
                Ok(Some(event)) => {
                    if let Ok(mut items) = events.lock() {
                        items.push(event);
                        if items.len() > MAX_RECORDING_EVENTS {
                            let overflow = items.len() - MAX_RECORDING_EVENTS;
                            items.drain(0..overflow);
                        }
                    }
                }
                Ok(None) => {}
                Err(err) if err.code == "cdp_timeout" => {}
                Err(err) => {
                    tracing::warn!(error = %err, "AI Agent browser recording stopped");
                    break;
                }
            }
        }

        if !task_stop.load(Ordering::Relaxed) {
            if let Ok(mut map) = recordings().lock() {
                map.remove(&task_environment_id);
            }
        }
    });

    Ok(summary(&environment_id, &handle, true, None))
}

#[tauri::command]
pub fn agent_stop_browser_recording(environment_id: String) -> AppResult<AgentRecordingSummary> {
    let handle = recordings()
        .lock()
        .map_err(|_| AppError::new("agent_recording_failed", "Recording registry is locked"))?
        .remove(&environment_id)
        .ok_or_else(|| AppError::new("agent_recording_not_found", "Recording is not active"))?;
    handle.stop.store(true, Ordering::Relaxed);
    Ok(summary(
        &environment_id,
        &handle,
        false,
        Some(Utc::now().to_rfc3339()),
    ))
}

#[tauri::command]
pub fn agent_get_browser_recording(environment_id: String) -> AppResult<AgentRecordingSummary> {
    let Some(handle) = recordings()
        .lock()
        .map_err(|_| AppError::new("agent_recording_failed", "Recording registry is locked"))?
        .get(&environment_id)
        .cloned()
    else {
        return Ok(AgentRecordingSummary {
            environment_id,
            is_recording: false,
            started_at: None,
            stopped_at: None,
            total_events: 0,
            total_requests: 0,
            total_responses: 0,
            events: Vec::new(),
        });
    };
    Ok(summary(&environment_id, &handle, true, None))
}

async fn page_for_environment(state: &AppState, environment_id: &str) -> AppResult<BrowserPage> {
    let status = start_environment_inner_headed(state, environment_id.to_string()).await?;
    let cdp_port = status.cdp_port.ok_or_else(|| {
        AppError::new(
            "cdp_unsupported",
            "This environment is running without a browser control endpoint.",
        )
    })?;
    let env = environment_repo::get(state.db(), environment_id)?;
    if matches!(env.browser_kind, BrowserKind::Camoufox) {
        BrowserPage::connect_camoufox(cdp_port).await
    } else {
        BrowserPage::connect_cdp(cdp_port, env.start_url.as_deref()).await
    }
}

fn required_option(value: Option<String>, name: &str) -> AppResult<String> {
    value
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| AppError::new("invalid_input", format!("Missing required field: {name}")))
}

fn summary(
    environment_id: &str,
    handle: &RecordingHandle,
    is_recording: bool,
    stopped_at: Option<String>,
) -> AgentRecordingSummary {
    let events = handle
        .events
        .lock()
        .map(|items| items.clone())
        .unwrap_or_default();
    let total_requests = events.iter().filter(|item| item.kind == "request").count();
    let total_responses = events.iter().filter(|item| item.kind == "response").count();
    AgentRecordingSummary {
        environment_id: environment_id.to_string(),
        is_recording,
        started_at: Some(handle.started_at.clone()),
        stopped_at,
        total_events: events.len(),
        total_requests,
        total_responses,
        events,
    }
}

#[tauri::command]
pub fn save_agent_artifact(
    state: State<'_, AppState>,
    input: SaveAgentArtifactInput,
) -> AppResult<AgentArtifactRef> {
    let path = agent_artifact_path(
        state.data_dir(),
        &input.environment_id,
        &input.session_id,
        &input.artifact_id,
    )?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let body = serde_json::to_vec_pretty(&json!({
        "environment_id": input.environment_id,
        "session_id": input.session_id,
        "artifact_id": input.artifact_id,
        "kind": input.kind,
        "created_at": Utc::now().to_rfc3339(),
        "content": input.content,
    }))?;
    std::fs::write(&path, &body)?;

    let metadata = std::fs::metadata(&path)?;
    Ok(AgentArtifactRef {
        environment_id: input.environment_id,
        session_id: input.session_id,
        artifact_id: input.artifact_id,
        kind: input.kind,
        path: path.to_string_lossy().to_string(),
        bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn read_agent_artifact(
    state: State<'_, AppState>,
    input: ReadAgentArtifactInput,
) -> AppResult<AgentArtifactContent> {
    let path = agent_artifact_path(
        state.data_dir(),
        &input.environment_id,
        &input.session_id,
        &input.artifact_id,
    )?;
    let bytes = std::fs::metadata(&path)?.len();
    let value: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("json")
        .to_string();
    let raw_content = value.get("content").cloned().unwrap_or(Value::Null);
    let mut content = serde_json::to_string_pretty(&raw_content)?;
    let max_chars = input.max_chars.unwrap_or(12_000).clamp(1_000, 80_000);
    let truncated = content.chars().count() > max_chars;
    if truncated {
        content = content.chars().take(max_chars).collect::<String>();
        content.push_str("…[truncated]");
    }

    Ok(AgentArtifactContent {
        artifact_id: input.artifact_id,
        kind,
        content,
        bytes,
        truncated,
    })
}
