export type BrowserKind = "chrome" | "chromium";

export type EnvironmentMode = "standard" | "custom";

export type ProxyKind = "none" | "http" | "https" | "socks4" | "socks5";

export type EnvironmentRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "unknown";

export type TaskRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type RunLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type RunArtifactKind = "screenshot" | "json" | "text" | "html" | "file";


export interface AppError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface ProxyConfig {
  kind: ProxyKind;
  host?: string;
  port?: number;
  username?: string;
  password_ref?: string;
  password?: string;
  bypass_list?: string[];
}

export interface Environment {
  id: string;
  name: string;
  group_id?: string | null;
  tags?: string[];
  tags_json?: string | null;
  notes?: string | null;
  browser_kind: BrowserKind;
  chrome_path_override?: string | null;
  profile_dir?: string | null;
  proxy_config?: ProxyConfig;
  proxy_config_json?: string | null;
  locale: string;
  timezone_id: string;
  geolocation_latitude?: number | null;
  geolocation_longitude?: number | null;
  user_agent?: string | null;
  platform?: string | null;
  web_rtc_protection: boolean;
  viewport_width: number;
  viewport_height: number;
  device_scale_factor: number;
  environment_mode: EnvironmentMode;
  seed?: string | null;
  headless: boolean;
  start_url?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export type EnvironmentDraft = Omit<
  Environment,
  "id" | "created_at" | "updated_at" | "deleted_at"
> & {
  id?: string;
};

export interface EnvironmentStatusDetail {
  status: EnvironmentRuntimeStatus;
  pid?: number;
  cdp_port?: number;
  websocket_url?: string;
  profile_dir?: string;
  last_seen_at?: string;
  message?: string;
}

export type EnvironmentStatusMap = Record<
  string,
  EnvironmentRuntimeStatus | EnvironmentStatusDetail
>;

export interface AutomationTask {
  id: string;
  name: string;
  description?: string | null;
  script: string;
  timeout_sec: number;
  api_version: string;
  permissions?: TaskPermissions;
  permissions_json?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export type AutomationTaskDraft = Omit<
  AutomationTask,
  "id" | "created_at" | "updated_at" | "deleted_at"
> & {
  id?: string;
};

export interface TaskPermissions {
  screenshots: boolean;
  external_urls: string[];
  clipboard: boolean;
}

export interface TaskValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface RunOptions {
  auto_start_browser: boolean;
  close_browser_after_run: boolean;
  max_concurrency: number;
  stop_on_first_error: boolean;
}

export interface RunBatch {
  id: string;
  task_id: string;
  total_count: number;
  queued_count: number;
  running_count: number;
  succeeded_count: number;
  failed_count: number;
  cancelled_count: number;
  options?: RunOptions;
  created_at?: string;
  finished_at?: string | null;
}

export interface TaskRun {
  id: string;
  batch_id?: string | null;
  task_id: string;
  environment_id: string;
  status: TaskRunStatus;
  attempt: number;
  timeout_sec?: number;
  queued_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  artifacts_dir?: string | null;
}

export interface RunLog {
  id: string;
  run_id: string;
  seq: number;
  level: RunLogLevel;
  message: string;
  data_json?: string | null;
  created_at: string;
}

export interface RunArtifact {
  id: string;
  run_id: string;
  kind: RunArtifactKind;
  label: string;
  path: string;
  created_at: string;
}

export interface RunFilters {
  task_id?: string;
  environment_id?: string;
  status?: TaskRunStatus | "all";
}

export interface Settings {
  chrome_path?: string | null;
  default_concurrency: number;
  default_locale: string;
  default_timezone_id: string;
  default_viewport_width: number;
  default_viewport_height: number;
  data_dir?: string | null;
  created_at?: string;
  updated_at?: string;
}



export interface ChromeDetectionResult {
  found: boolean;
  path?: string | null;
  version?: string | null;
  searched_paths: string[];
  error?: string | null;
}

export interface ProxyTestResult {
  ok: boolean;
  message: string;
  status_code?: number | null;
  ip?: string | null;
  timezone_id?: string | null;
}

export interface CleanupResult {
  cleaned: number;
  freed_bytes?: number;
}

export interface Diagnostics {
  chrome?: {
    path?: string | null;
    version?: string | null;
    launchable?: boolean;
    cdp_test_ok?: boolean;
    error?: string | null;
  };
  data?: {
    data_dir?: string | null;
    sqlite_path?: string | null;
    profiles_total_size?: number;
    runs_total_size?: number;
  };
  runtime?: {
    running_browser_count?: number;
    current_queue_concurrency?: number;
    stale_process_count?: number;
  };
  proxy?: {
    last_test_status?: string | null;
    last_test_at?: string | null;
    message?: string | null;
  };
  recovery?: {
    interrupted_run_count?: number;
    stale_lock_count?: number;
  };
  warnings?: string[];
  generated_at?: string;
}
