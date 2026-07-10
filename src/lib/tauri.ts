import { invoke } from "@tauri-apps/api/core";

import type {
  AppError,
  AutomationTask,
  AutomationTaskDraft,
  CamoufoxDetectionResult,
  ChromeDetectionResult,
  Diagnostics,
  Environment,
  EnvironmentDraft,
  EnvironmentStatusDetail,
  EnvironmentStatusMap,
  CleanupResult,
  AgentArtifactContent,
  AgentArtifactRef,
  AgentBrowserActionInput,
  AgentHistorySession,
  AgentHistorySnapshot,
  AgentRecordingSummary,
  BrowserContextSnapshot,
  ProxyTestResult,
  RunArtifact,
  RunArtifactContent,
  RunBatch,
  RunFilters,
  RunLog,
  RunOptions,
  ReadAgentArtifactInput,
  SaveAgentArtifactInput,
  SaveAgentHistoryInput,
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
  readRunArtifact: "read_run_artifact",
  deleteRun: "delete_run",
  deleteRuns: "delete_runs",
  openRunArtifact: "open_run_artifact",
  openRunArtifactsDir: "open_run_artifacts_dir",
  getSettings: "get_settings",
  saveSettings: "save_settings",
  detectChrome: "detect_chrome",
  validateChromePath: "validate_chrome_path",
  detectCamoufox: "detect_camoufox",
  validateCamoufoxPythonPath: "validate_camoufox_python_path",
  installCamoufox: "install_camoufox",
  openDataDir: "open_data_dir",
  getDiagnostics: "get_diagnostics",
  cleanupStaleSessions: "cleanup_stale_sessions",
  cleanupTempFiles: "cleanup_temp_files",
  agentBrowserAction: "agent_browser_action",
  listAgentHistories: "list_agent_histories",
  getAgentHistory: "get_agent_history",
  saveAgentHistory: "save_agent_history",
  deleteAgentHistory: "delete_agent_history",
  saveAgentArtifact: "save_agent_artifact",
  readAgentArtifact: "read_agent_artifact",
  agentStartBrowserRecording: "agent_start_browser_recording",
  agentStopBrowserRecording: "agent_stop_browser_recording",
  agentGetBrowserRecording: "agent_get_browser_recording",
} as const;

export type TauriCommand = (typeof COMMANDS)[keyof typeof COMMANDS];

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const mockNow = new Date().toISOString();

let mockEnvironments: Environment[] = [];
let mockTasks: AutomationTask[] = [];
const mockAgentHistories: Record<
  string,
  Record<string, AgentHistorySnapshot>
> = {};

type PreviewLanguage = "zh-CN" | "en-US";

function previewLanguage(): PreviewLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  return window.localStorage.getItem("orbit-browser.language") === "en-US"
    ? "en-US"
    : "zh-CN";
}

let mockRuns: TaskRun[] = [];

function mockInvoke<TResult>(
  command: TauriCommand,
  args?: Record<string, unknown>,
): TResult {
  const language = previewLanguage();

  switch (command) {
    case COMMANDS.listEnvironments:
      return mockEnvironments as TResult;
    case COMMANDS.getEnvironmentStatuses:
      return mockEnvironments.map((environment) => ({
        environment_id: environment.id,
        status: "stopped",
        last_seen_at: mockNow,
      })) as TResult;
    case COMMANDS.saveEnvironment: {
      const environment = {
        ...(args?.input as EnvironmentDraft),
        id:
          (args?.input as EnvironmentDraft | undefined)?.id ??
          crypto.randomUUID(),
        created_at: mockNow,
        updated_at: mockNow,
      } as Environment;
      mockEnvironments = [
        environment,
        ...mockEnvironments.filter((item) => item.id !== environment.id),
      ];
      return environment as TResult;
    }
    case COMMANDS.duplicateEnvironment: {
      const source = mockEnvironments.find((item) => item.id === args?.id);
      if (!source) {
        return undefined as TResult;
      }
      const environment = {
        ...source,
        id: crypto.randomUUID(),
        name:
          language === "en-US" ? `${source.name} Copy` : `${source.name}副本`,
        created_at: mockNow,
        updated_at: mockNow,
      };
      mockEnvironments = [environment, ...mockEnvironments];
      return environment as TResult;
    }
    case COMMANDS.deleteEnvironment:
      mockEnvironments = mockEnvironments.filter(
        (item) => item.id !== args?.id,
      );
      return undefined as TResult;
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
    case COMMANDS.testEnvironmentProxy: {
      const environment = mockEnvironments.find((item) => item.id === args?.id);
      const proxyConfigured =
        environment?.proxy_config && environment.proxy_config.kind !== "none";
      return {
        ok: true,
        message: proxyConfigured
          ? language === "en-US"
            ? "Proxy configured"
            : "代理已配置"
          : language === "en-US"
            ? "No proxy configured"
            : "未配置代理",
        status_code: proxyConfigured ? 200 : null,
        ip: null,
        timezone_id: environment?.timezone_id ?? null,
      } as TResult;
    }
    case COMMANDS.openEnvironmentProfileDir:
      return undefined as TResult;
    case COMMANDS.listTasks:
      return mockTasks as TResult;
    case COMMANDS.saveTask: {
      const task = {
        ...(args?.input as AutomationTaskDraft),
        id:
          (args?.input as AutomationTaskDraft | undefined)?.id ??
          crypto.randomUUID(),
        created_at: mockNow,
        updated_at: mockNow,
      } as AutomationTask;
      mockTasks = [task, ...mockTasks.filter((item) => item.id !== task.id)];
      return task as TResult;
    }
    case COMMANDS.deleteTask:
      mockTasks = mockTasks.filter((item) => item.id !== args?.id);
      return undefined as TResult;
    case COMMANDS.validateTaskScript:
      return { valid: true, errors: [], warnings: [] } as TResult;
    case COMMANDS.runTask:
      mockRuns = [
        {
          id: "run-preview-success",
          batch_id: "batch-preview",
          task_id:
            (args?.input as { task_id?: string } | undefined)?.task_id ??
            mockTasks[0]?.id ??
            "task-preview",
          environment_id:
            (args?.input as { environment_ids?: string[] } | undefined)
              ?.environment_ids?.[0] ??
            mockEnvironments[0]?.id ??
            "env-preview",
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
        task_id:
          (args?.input as { task_id?: string } | undefined)?.task_id ??
          mockTasks[0]?.id ??
          "task-preview",
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
    case COMMANDS.readRunArtifact:
      return {
        path: String(
          args?.path ?? "/tmp/orbit-browser/runs/run-001/title.json",
        ),
        label: "title.json",
        kind: "json",
        content: JSON.stringify({ title: "Example Domain" }, null, 2),
        bytes: 31,
        truncated: false,
      } as TResult;
    case COMMANDS.deleteRun:
      mockRuns = mockRuns.filter((run) => run.id !== args?.runId);
      return undefined as TResult;
    case COMMANDS.deleteRuns: {
      const runIds = new Set(args?.runIds as string[] | undefined);
      mockRuns = mockRuns.filter((run) => !runIds.has(run.id));
      return undefined as TResult;
    }
    case COMMANDS.getSettings:
      return {
        chrome_path:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        camoufox_python_path: "/usr/bin/python3",
        default_concurrency: 2,
        default_locale: "zh-CN",
        default_timezone_id: "Asia/Shanghai",
        default_viewport_width: 1365,
        default_viewport_height: 860,
        data_dir: "~/Library/Application Support/orbit browser",
        aigc_base_url: "https://api.openai.com/v1",
        aigc_model: "gpt-4o-mini",
        aigc_api_key: "",
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
    case COMMANDS.detectCamoufox:
    case COMMANDS.validateCamoufoxPythonPath:
    case COMMANDS.installCamoufox:
      return {
        found: true,
        python_path: "/usr/bin/python3",
        version: "0.4.11",
        searched_paths: ["/usr/bin/python3"],
      } as TResult;
    case COMMANDS.agentBrowserAction:
      return {
        url: "https://example.com",
        title: "Example Domain",
        screenshot_base64: null,
        html_excerpt: "<html><body>Example Domain</body></html>",
        visible_text:
          "Example Domain\nThis domain is for use in illustrative examples.",
        interactive_elements: [
          { kind: "link", label: "More information", selector: "a" },
        ],
        console_entries: [],
        network_entries: [
          { method: "GET", url: "https://example.com", status: 200 },
        ],
      } as TResult;
    case COMMANDS.listAgentHistories: {
      const environmentId = String(args?.environmentId ?? "preview");
      return Object.values(mockAgentHistories[environmentId] ?? {})
        .map((snapshot) => ({
          environment_id: snapshot.environment_id,
          session_id: snapshot.session_id,
          title: snapshot.title,
          created_at: snapshot.created_at,
          updated_at: snapshot.updated_at,
          message_count: snapshot.messages.length,
          path: snapshot.path,
        }))
        .sort((left, right) =>
          String(right.updated_at ?? "").localeCompare(
            String(left.updated_at ?? ""),
          ),
        ) as TResult;
    }
    case COMMANDS.getAgentHistory: {
      const environmentId = String(args?.environmentId ?? "preview");
      const sessionId = String(args?.sessionId ?? "default");
      return (mockAgentHistories[environmentId]?.[sessionId] ?? {
        environment_id: environmentId,
        session_id: sessionId,
        title: "新对话",
        messages: [],
        api_messages: [],
        created_at: null,
        updated_at: null,
        path: `/tmp/orbit-browser/agent-history/${environmentId}/${sessionId}.jsonl`,
      }) as TResult;
    }
    case COMMANDS.saveAgentHistory: {
      const input = args?.input as SaveAgentHistoryInput | undefined;
      const environmentId = input?.environment_id ?? "preview";
      const sessionId = input?.session_id ?? crypto.randomUUID();
      const firstUserMessage = input?.messages.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          (message as { role?: unknown }).role === "user",
      ) as { content?: unknown } | undefined;
      mockAgentHistories[environmentId] ??= {};
      mockAgentHistories[environmentId][sessionId] = {
        environment_id: environmentId,
        session_id: sessionId,
        title:
          typeof firstUserMessage?.content === "string" &&
          firstUserMessage.content.trim()
            ? firstUserMessage.content.trim().slice(0, 40)
            : "新对话",
        messages: input?.messages ?? [],
        api_messages: input?.api_messages ?? [],
        created_at:
          mockAgentHistories[environmentId][sessionId]?.created_at ?? mockNow,
        updated_at: mockNow,
        path: `/tmp/orbit-browser/agent-history/${environmentId}/${sessionId}.jsonl`,
      };
      return mockAgentHistories[environmentId][sessionId] as TResult;
    }
    case COMMANDS.deleteAgentHistory: {
      const environmentId = String(args?.environmentId ?? "preview");
      const sessionId = String(args?.sessionId ?? "");
      if (mockAgentHistories[environmentId]) {
        delete mockAgentHistories[environmentId][sessionId];
      }
      return undefined as TResult;
    }
    case COMMANDS.agentStartBrowserRecording:
    case COMMANDS.agentGetBrowserRecording:
      return {
        environment_id: String(args?.environmentId ?? "preview"),
        is_recording: true,
        started_at: mockNow,
        total_events: 1,
        total_requests: 1,
        total_responses: 0,
        events: [
          {
            kind: "request",
            method: "GET",
            url: "https://example.com",
            resource_type: "Document",
            timestamp: mockNow,
          },
        ],
      } as TResult;
    case COMMANDS.agentStopBrowserRecording:
      return {
        environment_id: String(args?.environmentId ?? "preview"),
        is_recording: false,
        started_at: mockNow,
        stopped_at: mockNow,
        total_events: 0,
        total_requests: 0,
        total_responses: 0,
        events: [],
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
          data_dir: null,
          sqlite_path: null,
          profiles_total_size: 0,
          runs_total_size: 0,
        },
        runtime: {
          running_browser_count: 0,
          current_queue_concurrency: 0,
          stale_process_count: 0,
        },
        proxy: {
          last_test_status: null,
          last_test_at: null,
          message: null,
        },
        recovery: {
          interrupted_run_count: 0,
          stale_lock_count: 0,
        },
        warnings: [],
        generated_at: mockNow,
      } as TResult;
    case COMMANDS.cleanupStaleSessions:
      return { cleaned: 0 } as TResult;
    case COMMANDS.cleanupTempFiles:
      return { cleaned: 0, freed_bytes: 0 } as TResult;
    case COMMANDS.openDataDir:
      return undefined as TResult;
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
    (!filters.environment_id ||
      run.environment_id === filters.environment_id) &&
    (!filters.status ||
      filters.status === "all" ||
      run.status === filters.status)
  );
}

export const browserApi = {
  listEnvironments: () =>
    invokeCommand<Environment[]>(COMMANDS.listEnvironments),

  saveEnvironment: (environment: EnvironmentDraft) =>
    invokeCommand<Environment>(COMMANDS.saveEnvironment, {
      input: environment,
    }),

  deleteEnvironment: async (environmentId: string, _deleteProfile = false) => {
    await invokeCommand<void>(COMMANDS.deleteEnvironment, {
      id: environmentId,
    });
    return { deleted: true };
  },

  duplicateEnvironment: (environmentId: string) =>
    invokeCommand<Environment>(COMMANDS.duplicateEnvironment, {
      id: environmentId,
    }),

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
    invokeCommand<ProxyTestResult>(COMMANDS.testEnvironmentProxy, {
      id: environmentId,
    }),

  openEnvironmentProfileDir: (environmentId: string) =>
    invokeCommand<void>(COMMANDS.openEnvironmentProfileDir, {
      id: environmentId,
    }),

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
    invokeCommand<TaskValidationResult>(COMMANDS.validateTaskScript, {
      script,
    }),

  runTask: (taskId: string, environmentIds: string[], options: RunOptions) =>
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

  readRunArtifact: (path: string, maxChars?: number) =>
    invokeCommand<RunArtifactContent>(COMMANDS.readRunArtifact, {
      path,
      maxChars,
    }),

  deleteRun: async (runId: string) => {
    await invokeCommand<void>(COMMANDS.deleteRun, { runId });
    return { deleted: true };
  },

  deleteRuns: async (runIds: string[]) => {
    await invokeCommand<void>(COMMANDS.deleteRuns, { runIds });
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

  detectCamoufox: () =>
    invokeCommand<CamoufoxDetectionResult>(COMMANDS.detectCamoufox),

  validateCamoufoxPythonPath: (path: string) =>
    invokeCommand<CamoufoxDetectionResult>(
      COMMANDS.validateCamoufoxPythonPath,
      { path },
    ),

  installCamoufox: (operationId: string) =>
    invokeCommand<CamoufoxDetectionResult>(COMMANDS.installCamoufox, {
      operationId,
    }),

  openDataDir: () => invokeCommand<void>(COMMANDS.openDataDir),

  getDiagnostics: () => invokeCommand<Diagnostics>(COMMANDS.getDiagnostics),

  cleanupStaleSessions: () =>
    invokeCommand<CleanupResult>(COMMANDS.cleanupStaleSessions),

  cleanupTempFiles: () =>
    invokeCommand<CleanupResult>(COMMANDS.cleanupTempFiles),

  agentBrowserAction: (input: AgentBrowserActionInput) =>
    invokeCommand<BrowserContextSnapshot | Record<string, unknown>>(
      COMMANDS.agentBrowserAction,
      { input },
    ),

  listAgentHistories: (environmentId: string) =>
    invokeCommand<AgentHistorySession[]>(COMMANDS.listAgentHistories, {
      environmentId,
    }),

  getAgentHistory: (environmentId: string, sessionId?: string) =>
    invokeCommand<AgentHistorySnapshot>(COMMANDS.getAgentHistory, {
      environmentId,
      sessionId,
    }),

  saveAgentHistory: (input: SaveAgentHistoryInput) =>
    invokeCommand<AgentHistorySnapshot>(COMMANDS.saveAgentHistory, { input }),

  deleteAgentHistory: (environmentId: string, sessionId: string) =>
    invokeCommand<void>(COMMANDS.deleteAgentHistory, {
      environmentId,
      sessionId,
    }),

  saveAgentArtifact: (input: SaveAgentArtifactInput) =>
    invokeCommand<AgentArtifactRef>(COMMANDS.saveAgentArtifact, { input }),

  readAgentArtifact: (input: ReadAgentArtifactInput) =>
    invokeCommand<AgentArtifactContent>(COMMANDS.readAgentArtifact, { input }),

  agentStartBrowserRecording: (environmentId: string) =>
    invokeCommand<AgentRecordingSummary>(COMMANDS.agentStartBrowserRecording, {
      environmentId,
    }),

  agentStopBrowserRecording: (environmentId: string) =>
    invokeCommand<AgentRecordingSummary>(COMMANDS.agentStopBrowserRecording, {
      environmentId,
    }),

  agentGetBrowserRecording: (environmentId: string) =>
    invokeCommand<AgentRecordingSummary>(COMMANDS.agentGetBrowserRecording, {
      environmentId,
    }),
};
