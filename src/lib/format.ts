import type {
  Environment,
  EnvironmentRuntimeStatus,
  EnvironmentStatusDetail,
  EnvironmentStatusMap,
  ProxyConfig,
  TaskRunStatus,
} from "@/types/domain";
import { getStatusLabel } from "@/i18n";
import type { AppLanguage } from "@/stores/uiStore";

const languageStorageKey = "orbit-browser.language";

const localizedErrors: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": {
    artifact_not_found: "运行产物不存在",
    cdp_connect_failed: "CDP 连接失败",
    cdp_timeout: "等待 Chrome CDP 端口就绪超时",
    chrome_invalid_path: "Chrome 路径无效",
    chrome_not_running: "环境未运行，请先启动浏览器或开启自动启动",
    chrome_start_failed: "Chrome 启动失败",
    environment_not_found: "环境不存在或已删除",
    open_path_failed: "打开路径失败",
    profile_locked: "Profile 正被其他 Chrome 进程占用",
    proxy_connect_failed: "代理连接失败",
    proxy_invalid: "代理配置无效",
    script_compile_error: "脚本不能为空或无法编译",
    script_runtime_error: "脚本运行失败",
    task_cancelled: "任务已取消",
    task_not_found: "任务或运行记录不存在",
    task_timeout: "任务执行超时",
    validation_error: "输入内容不符合要求",
  },
  "en-US": {
    artifact_not_found: "Run artifact does not exist",
    cdp_connect_failed: "CDP connection failed",
    cdp_timeout: "Timed out waiting for Chrome CDP port",
    chrome_invalid_path: "Chrome path is invalid",
    chrome_not_running: "Environment is not running. Start the browser first or enable auto-start.",
    chrome_start_failed: "Chrome failed to start",
    environment_not_found: "Environment does not exist or was deleted",
    open_path_failed: "Failed to open path",
    profile_locked: "Profile is already used by another Chrome process",
    proxy_connect_failed: "Proxy connection failed",
    proxy_invalid: "Proxy configuration is invalid",
    script_compile_error: "Script is empty or cannot be compiled",
    script_runtime_error: "Script runtime failed",
    task_cancelled: "Task was cancelled",
    task_not_found: "Task or run does not exist",
    task_timeout: "Task execution timed out",
    validation_error: "Input is invalid",
  },
};

function activeLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  return window.localStorage.getItem(languageStorageKey) === "en-US"
    ? "en-US"
    : "zh-CN";
}

export function formatDateTime(value?: string | null, locale?: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) {
    return "-";
  }

  const diff = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(diff) || diff < 0) {
    return "-";
  }

  const seconds = Math.round(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatBytes(value?: number): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "-";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

export function normalizeTags(environment: Environment): string[] {
  if (Array.isArray(environment.tags)) {
    return environment.tags;
  }

  if (!environment.tags_json) {
    return [];
  }

  try {
    const parsed = JSON.parse(environment.tags_json);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function normalizeProxy(environment: Environment): ProxyConfig {
  if (environment.proxy_config) {
    return environment.proxy_config;
  }

  if (!environment.proxy_config_json) {
    return { kind: "none" };
  }

  try {
    const parsed = JSON.parse(environment.proxy_config_json) as ProxyConfig;
    return parsed.kind ? parsed : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

export function readRuntimeStatus(
  statuses: EnvironmentStatusMap | undefined,
  environmentId: string,
): EnvironmentStatusDetail {
  const value = statuses?.[environmentId];
  if (!value) {
    return { status: "unknown" };
  }

  return typeof value === "string" ? { status: value } : value;
}

export function statusLabel(
  status: EnvironmentRuntimeStatus | TaskRunStatus,
  language: AppLanguage = "zh-CN",
): string {
  return getStatusLabel(status, language);
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const localized = localizedErrors[activeLanguage()][code];
      if (localized) {
        return localized;
      }
    }

    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }

  return error instanceof Error ? error.message : String(error);
}
