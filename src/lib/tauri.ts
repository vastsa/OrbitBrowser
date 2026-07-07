import { invoke } from "@tauri-apps/api/core";

import type {
  AppError,
  AutomationTask,
  AutomationTaskDraft,
  ChromeDetectionResult,
  Diagnostics,
  Environment,
  EnvironmentDraft,
  EnvironmentStatusDetail,
  EnvironmentStatusMap,
  CleanupResult,
  ProxyTestResult,
  RunArtifact,
  RunBatch,
  RunFilters,
  RunLog,
  RunOptions,
  Settings,
  TaskRun,
  TaskValidationResult,
} from "@/types/domain";

export const COMMANDS = {
  listEnvironments: "list_environments",
  saveEnvironment: "save_environment",
  deleteEnvironment: "delete_environment",
  duplicateEnvironment: "duplicate_environment",
  startEnvironment: "start_environment",
  stopEnvironment: "stop_environment",
  restartEnvironment: "restart_environment",
  getEnvironmentStatuses: "get_environment_statuses",
  validateEnvironment: "validate_environment",
  testEnvironmentProxy: "test_environment_proxy",
  openEnvironmentProfileDir: "open_environment_profile_dir",
  listTasks: "list_tasks",
  saveTask: "save_task",
  deleteTask: "delete_task",
  validateTaskScript: "validate_task_script",
  runTask: "run_task",
  cancelRun: "cancel_run",
  cancelBatch: "cancel_batch",
  retryRun: "retry_run",
  listRuns: "list_runs",
  getRunLogs: "get_run_logs",
  listRunArtifacts: "list_run_artifacts",
  deleteRun: "delete_run",
  openRunArtifact: "open_run_artifact",
  openRunArtifactsDir: "open_run_artifacts_dir",
  getSettings: "get_settings",
  saveSettings: "save_settings",
  detectChrome: "detect_chrome",
  validateChromePath: "validate_chrome_path",
  openDataDir: "open_data_dir",
  getDiagnostics: "get_diagnostics",
  cleanupStaleSessions: "cleanup_stale_sessions",
  cleanupTempFiles: "cleanup_temp_files",
} as const;

export type TauriCommand = (typeof COMMANDS)[keyof typeof COMMANDS];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const mockNow = new Date().toISOString();

const mockEnvironments: Environment[] = [
  {
    id: "env-main",
    name: "Default Chrome Environment",
    group_id: "core",
    tags: ["local", "visible-window"],
    notes: "Used for daily smoke checks and script debugging.",
    browser_kind: "chrome",
    locale: "en-US",
    timezone_id: "auto",
    geolocation_latitude: null,
    geolocation_longitude: null,
    user_agent: null,
    platform: null,
    web_rtc_protection: true,
    viewport_width: 1365,
    viewport_height: 860,
    device_scale_factor: 1,
    environment_mode: "standard",
    headless: false,
    start_url: "https://example.com",
    proxy_config: { kind: "none", bypass_list: [] },
    created_at: mockNow,
    updated_at: mockNow,
  },
  {
    id: "env-proxy",
    name: "Proxy Validation Environment",
    group_id: "proxy",
    tags: ["SOCKS5", "screenshot"],
    notes: "Used to verify proxy routing, locale, and artifact output.",
    browser_kind: "chrome",
    locale: "en-US",
    timezone_id: "America/Los_Angeles",
    geolocation_latitude: 34.0522,
    geolocation_longitude: -118.2437,
    user_agent: null,
    platform: null,
    web_rtc_protection: true,
    viewport_width: 1440,
    viewport_height: 900,
    device_scale_factor: 1,
    environment_mode: "standard",
    headless: false,
    start_url: "https://example.org",
    proxy_config: {
      kind: "socks5",
      host: "127.0.0.1",
      port: 7890,
      bypass_list: ["localhost", "127.0.0.1"],
    },
    created_at: mockNow,
    updated_at: mockNow,
  },
];

const mockTasks: AutomationTask[] = [
  {
    id: "task-title",
    name: "Page Title Capture",
    description: "Open a target page, log its title, and emit a JSON artifact.",
    script:
      'await page.goto("https://example.com");\nconst title = await page.title();\nlog.info(`Page title: ${title}`);\nawait run.outputJson("title", { title });',
    timeout_sec: 60,
    api_version: "v1",
    permissions: {
      screenshots: true,
      external_urls: ["<all_urls>"],
      clipboard: true,
    },
    created_at: mockNow,
    updated_at: mockNow,
  },
  {
    id: "task-shot",
    name: "Homepage Screenshot Check",
    description: "Open the homepage and save a screenshot for quick visual checks.",
    script:
      'await page.goto("https://example.com", { waitUntil: "load" });\nawait page.screenshot("home");\nlog.info("Screenshot saved");',
    timeout_sec: 90,
    api_version: "v1",
    permissions: {
      screenshots: true,
      external_urls: ["<all_urls>"],
      clipboard: true,
    },
    created_at: mockNow,
    updated_at: mockNow,
  },
];

type PreviewLanguage = "zh-CN" | "en-US";

function previewLanguage(): PreviewLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  return window.localStorage.getItem("orbit-browser.language") === "en-US"
    ? "en-US"
    : "zh-CN";
}

function localizedMockEnvironments(language: PreviewLanguage): Environment[] {
  if (language === "en-US") {
    return mockEnvironments;
  }

  return [
    {
      ...mockEnvironments[0],
      name: "默认 Chrome 环境",
      tags: ["本机", "可见窗口"],
      notes: "用于日常 smoke 和脚本调试。",
      locale: "zh-CN",
      timezone_id: "Asia/Shanghai",
    },
    {
      ...mockEnvironments[1],
      name: "代理验证环境",
      tags: ["SOCKS5", "截图"],
      notes: "用于检查代理、地区和产物输出。",
    },
  ];
}

function localizedMockTasks(language: PreviewLanguage): AutomationTask[] {
  if (language === "en-US") {
    return mockTasks;
  }

  return [
    {
      ...mockTasks[0],
      name: "页面标题采集",
      description: "打开目标页面，记录标题并输出 JSON 产物。",
      script:
        'await page.goto("https://example.com");\nconst title = await page.title();\nlog.info(`页面标题: ${title}`);\nawait run.outputJson("title", { title });',
    },
    {
      ...mockTasks[1],
      name: "首页截图检查",
      description: "访问首页后保存截图，适合快速检查可视化状态。",
      script:
        'await page.goto("https://example.com", { waitUntil: "load" });\nawait page.screenshot("home");\nlog.info("截图已保存");',
    },
  ];
}

let mockRuns: TaskRun[] = [
  {
    id: "run-001",
    batch_id: "batch-20260618",
    task_id: "task-title",
    environment_id: "env-main",
    status: "succeeded",
    attempt: 1,
    queued_at: mockNow,
    started_at: mockNow,
    finished_at: mockNow,
    artifacts_dir: "/tmp/orbit-browser/runs/run-001",
  },
  {
    id: "run-002",
    batch_id: "batch-20260618",
    task_id: "task-shot",
    environment_id: "env-proxy",
    status: "running",
    attempt: 1,
    queued_at: mockNow,
    started_at: mockNow,
    artifacts_dir: "/tmp/orbit-browser/runs/run-002",
  },
];

function mockInvoke<TResult>(
  command: TauriCommand,
  args?: Record<string, unknown>,
): TResult {
  const language = previewLanguage();
  const environments = localizedMockEnvironments(language);
  const tasks = localizedMockTasks(language);

  switch (command) {
    case COMMANDS.listEnvironments:
      return environments as TResult;
    case COMMANDS.getEnvironmentStatuses:
      return [
        {
          environment_id: "env-main",
          status: "stopped",
          last_seen_at: mockNow,
        },
        {
          cdp_port: 9222,
          environment_id: "env-proxy",
          last_seen_at: mockNow,
          pid: 42810,
          status: "running",
        },
      ] as TResult;
    case COMMANDS.saveEnvironment:
      return {
        ...(args?.input as EnvironmentDraft),
        id: (args?.input as EnvironmentDraft | undefined)?.id ?? "env-preview",
        created_at: mockNow,
        updated_at: mockNow,
      } as TResult;
    case COMMANDS.duplicateEnvironment:
      return {
        ...environments[0],
        id: "env-copy",
        name:
          language === "en-US"
            ? `${environments[0].name} Copy`
            : `${environments[0].name}副本`,
      } as TResult;
    case COMMANDS.startEnvironment:
    case COMMANDS.stopEnvironment:
    case COMMANDS.restartEnvironment:
      return {
        environment_id: args?.id,
        status: command === COMMANDS.stopEnvironment ? "stopped" : "running",
        last_seen_at: mockNow,
      } as TResult;
    case COMMANDS.validateEnvironment:
      return undefined as TResult;
    case COMMANDS.testEnvironmentProxy:
      return {
        ok: true,
        message:
          args?.id === "env-proxy"
            ? language === "en-US"
              ? "Proxy reachable: 203.0.113.20 (America/Los_Angeles)"
              : "代理连通：203.0.113.20 (America/Los_Angeles)"
            : language === "en-US"
              ? "No proxy configured"
              : "未配置代理",
        status_code: args?.id === "env-proxy" ? 200 : null,
        ip: args?.id === "env-proxy" ? "203.0.113.20" : null,
        timezone_id:
          args?.id === "env-proxy" ? "America/Los_Angeles" : "UTC",
      } as TResult;
    case COMMANDS.openEnvironmentProfileDir:
      return undefined as TResult;
    case COMMANDS.listTasks:
      return tasks as TResult;
    case COMMANDS.saveTask:
      return {
        ...(args?.input as AutomationTaskDraft),
        id: (args?.input as AutomationTaskDraft | undefined)?.id ?? "task-preview",
        created_at: mockNow,
        updated_at: mockNow,
      } as TResult;
    case COMMANDS.validateTaskScript:
      return { valid: true, errors: [], warnings: [] } as TResult;
    case COMMANDS.runTask:
      mockRuns = [
        {
          id: "run-preview-success",
          batch_id: "batch-preview",
          task_id:
            (args?.input as { task_id?: string } | undefined)?.task_id ??
            "task-preview",
          environment_id:
            (args?.input as { environment_ids?: string[] } | undefined)
              ?.environment_ids?.[0] ?? "env-main",
          status: "succeeded",
          attempt: 1,
          queued_at: mockNow,
          started_at: mockNow,
          finished_at: mockNow,
          artifacts_dir: "/tmp/orbit-browser/runs/run-preview-success",
        },
        ...mockRuns,
      ];
      return {
        id: "batch-preview",
        task_id: (args?.input as { task_id?: string } | undefined)?.task_id ?? "task-preview",
        total_count: 1,
        queued_count: 0,
        running_count: 0,
        succeeded_count: 1,
        failed_count: 0,
        cancelled_count: 0,
        created_at: mockNow,
      } as TResult;
    case COMMANDS.listRuns:
      return mockRuns as TResult;
    case COMMANDS.getRunLogs:
      return [
        {
          id: "log-001",
          run_id: String(args?.runId ?? "run-001"),
          seq: 1,
          level: "info",
          message:
            language === "en-US"
              ? "Browser is ready. Starting script execution."
              : "浏览器已就绪，开始执行脚本。",
          created_at: mockNow,
        },
        {
          id: "log-002",
          run_id: String(args?.runId ?? "run-001"),
          seq: 2,
          level: "info",
          message:
            language === "en-US"
              ? "Page title captured and artifact written."
              : "页面标题已采集，产物写入完成。",
          created_at: mockNow,
        },
      ] as TResult;
    case COMMANDS.listRunArtifacts:
      return [
        {
          id: "artifact-001",
          run_id: String(args?.runId ?? "run-001"),
          kind: "json",
          label: "title.json",
          path: "/tmp/orbit-browser/runs/run-001/title.json",
          created_at: mockNow,
        },
        {
          id: "artifact-002",
          run_id: String(args?.runId ?? "run-001"),
          kind: "screenshot",
          label: "home.png",
          path: "/tmp/orbit-browser/runs/run-001/home.png",
          created_at: mockNow,
        },
      ] as TResult;
    case COMMANDS.deleteRun:
      mockRuns = mockRuns.filter((run) => run.id !== args?.runId);
      return undefined as TResult;
    case COMMANDS.getSettings:
      return {
        chrome_path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        default_concurrency: 2,
        default_locale: "zh-CN",
        default_timezone_id: "Asia/Shanghai",
        default_viewport_width: 1365,
        default_viewport_height: 860,
        data_dir: "~/Library/Application Support/orbit browser",
        updated_at: mockNow,
      } as TResult;
    case COMMANDS.saveSettings:
      return { ...(args?.input as Settings), updated_at: mockNow } as TResult;
    case COMMANDS.detectChrome:
    case COMMANDS.validateChromePath:
      return {
        found: true,
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        version: "Chrome 126",
        searched_paths: [],
      } as TResult;
    case COMMANDS.getDiagnostics:
      return {
        chrome: {
          path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          version: "Chrome 126",
          launchable: true,
          cdp_test_ok: true,
        },
        data: {
          data_dir: "~/Library/Application Support/orbit browser",
          sqlite_path: "~/Library/Application Support/orbit browser/orbit-browser.sqlite",
          profiles_total_size: 168_200_000,
          runs_total_size: 21_600_000,
        },
        runtime: {
          running_browser_count: 1,
          current_queue_concurrency: 2,
          stale_process_count: 0,
        },
        proxy: {
          last_test_status: "ok",
          last_test_at: mockNow,
          message:
            language === "en-US"
              ? "Last proxy check passed"
              : "最近一次代理检测通过",
        },
        recovery: {
          interrupted_run_count: 0,
          stale_lock_count: 0,
        },
        warnings: [],
        generated_at: mockNow,
      } as TResult;
    case COMMANDS.cleanupStaleSessions:
      return { cleaned: 1 } as TResult;
    case COMMANDS.cleanupTempFiles:
      return { cleaned: 3, freed_bytes: 2_048_000 } as TResult;
    case COMMANDS.openDataDir:
      return undefined as TResult;
    case COMMANDS.deleteEnvironment:
    case COMMANDS.deleteTask:
    case COMMANDS.cancelRun:
    case COMMANDS.cancelBatch:
    case COMMANDS.retryRun:
    case COMMANDS.openRunArtifactsDir:
    case COMMANDS.openRunArtifact:
      return undefined as TResult;
    default:
      throw new Error(`Browser preview does not support command: ${command}`);
  }
}

function normalizeAppError(error: unknown): AppError {
  if (typeof error === "object" && error !== null) {
    const maybeError = error as Partial<AppError>;
    if (typeof maybeError.message === "string") {
      return {
        code: maybeError.code ?? "unknown_error",
        message: maybeError.message,
        details: maybeError.details,
        retryable: maybeError.retryable,
      };
    }
  }

  return {
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

async function invokeCommand<TResult>(
  command: TauriCommand,
  args?: Record<string, unknown>,
): Promise<TResult> {
  if (!isTauriRuntime()) {
    return mockInvoke<TResult>(command, args);
  }

  try {
    return await invoke<TResult>(command, args ?? {});
  } catch (error) {
    throw normalizeAppError(error);
  }
}

function statusListToMap(
  statuses: Array<EnvironmentStatusDetail & { environment_id: string }>,
): EnvironmentStatusMap {
  return statuses.reduce<EnvironmentStatusMap>((acc, status) => {
    acc[status.environment_id] = status;
    return acc;
  }, {});
}

function matchesRunFilters(run: TaskRun, filters?: RunFilters): boolean {
  if (!filters) {
    return true;
  }
  return (
    (!filters.batch_id || run.batch_id === filters.batch_id) &&
    (!filters.task_id || run.task_id === filters.task_id) &&
    (!filters.environment_id || run.environment_id === filters.environment_id) &&
    (!filters.status || filters.status === "all" || run.status === filters.status)
  );
}

export const browserApi = {
  listEnvironments: () =>
    invokeCommand<Environment[]>(COMMANDS.listEnvironments),

  saveEnvironment: (environment: EnvironmentDraft) =>
    invokeCommand<Environment>(COMMANDS.saveEnvironment, { input: environment }),

  deleteEnvironment: async (environmentId: string, _deleteProfile = false) => {
    await invokeCommand<void>(COMMANDS.deleteEnvironment, { id: environmentId });
    return { deleted: true };
  },

  duplicateEnvironment: (environmentId: string) =>
    invokeCommand<Environment>(COMMANDS.duplicateEnvironment, { id: environmentId }),

  startEnvironment: async (environmentId: string) => {
    const status = await invokeCommand<
      EnvironmentStatusDetail & { environment_id: string }
    >(COMMANDS.startEnvironment, { id: environmentId });
    return statusListToMap([status]);
  },

  stopEnvironment: async (environmentId: string) => {
    const status = await invokeCommand<
      EnvironmentStatusDetail & { environment_id: string }
    >(COMMANDS.stopEnvironment, { id: environmentId });
    return statusListToMap([status]);
  },

  restartEnvironment: async (environmentId: string) => {
    const status = await invokeCommand<
      EnvironmentStatusDetail & { environment_id: string }
    >(COMMANDS.restartEnvironment, { id: environmentId });
    return statusListToMap([status]);
  },

  validateEnvironment: (environment: EnvironmentDraft) =>
    invokeCommand<void>(COMMANDS.validateEnvironment, { input: environment }),

  testEnvironmentProxy: (environmentId: string) =>
    invokeCommand<ProxyTestResult>(COMMANDS.testEnvironmentProxy, { id: environmentId }),

  openEnvironmentProfileDir: (environmentId: string) =>
    invokeCommand<void>(COMMANDS.openEnvironmentProfileDir, { id: environmentId }),

  getEnvironmentStatuses: async () => {
    const statuses = await invokeCommand<
      Array<EnvironmentStatusDetail & { environment_id: string }>
    >(COMMANDS.getEnvironmentStatuses);
    return statusListToMap(statuses);
  },

  listTasks: () => invokeCommand<AutomationTask[]>(COMMANDS.listTasks),

  saveTask: (task: AutomationTaskDraft) =>
    invokeCommand<AutomationTask>(COMMANDS.saveTask, { input: task }),

  deleteTask: async (taskId: string) => {
    await invokeCommand<void>(COMMANDS.deleteTask, { id: taskId });
    return { deleted: true };
  },

  validateTaskScript: (script: string) =>
    invokeCommand<TaskValidationResult>(COMMANDS.validateTaskScript, { script }),

  runTask: (
    taskId: string,
    environmentIds: string[],
    options: RunOptions,
  ) =>
    invokeCommand<RunBatch>(COMMANDS.runTask, {
      input: {
        task_id: taskId,
        environment_ids: environmentIds,
        options,
      },
    }),

  cancelRun: (runId: string) =>
    invokeCommand<void>(COMMANDS.cancelRun, { runId }),

  cancelBatch: (batchId: string) =>
    invokeCommand<void>(COMMANDS.cancelBatch, { batchId }),

  retryRun: (runId: string) =>
    invokeCommand<void>(COMMANDS.retryRun, { runId }),

  listRuns: async (filters?: RunFilters) => {
    const runs = await invokeCommand<TaskRun[]>(COMMANDS.listRuns);
    return runs.filter((run) => matchesRunFilters(run, filters));
  },

  getRunLogs: (runId: string) =>
    invokeCommand<RunLog[]>(COMMANDS.getRunLogs, { runId }),

  listRunArtifacts: (runId: string) =>
    invokeCommand<RunArtifact[]>(COMMANDS.listRunArtifacts, { runId }),

  deleteRun: async (runId: string) => {
    await invokeCommand<void>(COMMANDS.deleteRun, { runId });
    return { deleted: true };
  },

  openRunArtifact: (path: string) =>
    invokeCommand<void>(COMMANDS.openRunArtifact, { path }),

  openRunArtifactsDir: (runId: string) =>
    invokeCommand<void>(COMMANDS.openRunArtifactsDir, { runId }),

  getSettings: () => invokeCommand<Settings>(COMMANDS.getSettings),

  saveSettings: (settings: Settings) =>
    invokeCommand<Settings>(COMMANDS.saveSettings, { input: settings }),

  detectChrome: () =>
    invokeCommand<ChromeDetectionResult>(COMMANDS.detectChrome),

  validateChromePath: (path: string) =>
    invokeCommand<ChromeDetectionResult>(COMMANDS.validateChromePath, { path }),

  openDataDir: () => invokeCommand<void>(COMMANDS.openDataDir),

  getDiagnostics: () =>
    invokeCommand<Diagnostics>(COMMANDS.getDiagnostics),

  cleanupStaleSessions: () =>
    invokeCommand<CleanupResult>(COMMANDS.cleanupStaleSessions),

  cleanupTempFiles: () =>
    invokeCommand<CleanupResult>(COMMANDS.cleanupTempFiles),
};
