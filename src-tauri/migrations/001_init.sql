PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chrome_path TEXT,
  default_concurrency INTEGER NOT NULL DEFAULT 2,
  default_locale TEXT NOT NULL DEFAULT 'zh-CN',
  default_timezone_id TEXT NOT NULL DEFAULT 'auto',
  default_viewport_width INTEGER NOT NULL DEFAULT 1280,
  default_viewport_height INTEGER NOT NULL DEFAULT 800,
  data_dir TEXT NOT NULL,
  aigc_base_url TEXT,
  aigc_model TEXT,
  aigc_api_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  browser_kind TEXT NOT NULL DEFAULT 'chrome',
  chrome_path_override TEXT,
  profile_dir TEXT NOT NULL,
  proxy_config_json TEXT NOT NULL DEFAULT '{"kind":"none"}',
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  timezone_id TEXT,
  geolocation_latitude REAL,
  geolocation_longitude REAL,
  user_agent TEXT,
  platform TEXT,
  web_rtc_protection INTEGER NOT NULL DEFAULT 1,
  viewport_width INTEGER NOT NULL DEFAULT 1280,
  viewport_height INTEGER NOT NULL DEFAULT 800,
  device_scale_factor REAL NOT NULL DEFAULT 1,
  environment_mode TEXT NOT NULL DEFAULT 'standard',
  seed TEXT,
  headless INTEGER NOT NULL DEFAULT 0,
  start_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS browser_session_records (
  environment_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cdp_port INTEGER NOT NULL,
  websocket_url TEXT,
  profile_dir TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(environment_id) REFERENCES environments(id)
);

CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  script TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL DEFAULT 60,
  api_version TEXT NOT NULL DEFAULT 'v1',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS run_batches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  queued_count INTEGER NOT NULL DEFAULT 0,
  running_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(task_id) REFERENCES automation_tasks(id)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  task_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  timeout_sec INTEGER NOT NULL DEFAULT 60,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  artifacts_dir TEXT,
  FOREIGN KEY(batch_id) REFERENCES run_batches(id),
  FOREIGN KEY(task_id) REFERENCES automation_tasks(id),
  FOREIGN KEY(environment_id) REFERENCES environments(id)
);

CREATE TABLE IF NOT EXISTS run_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES task_runs(id)
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES task_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_environments_deleted_at ON environments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_environment ON task_runs(environment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_logs_run_seq ON run_logs(run_id, seq);
