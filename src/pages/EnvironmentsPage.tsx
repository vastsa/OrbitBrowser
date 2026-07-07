import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  Copy,
  Edit2,
  FolderOpen,
  Globe2,
  Network,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Square,
  SquareStack,
  Tags,
  Trash2,
  Upload,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import {
  SelectControl,
  SelectField,
  TextareaField,
  TextField,
} from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { MetricTile, PageHeader, SkeletonRows } from "@/components/PageScaffold";
import { StatusBadge } from "@/components/StatusBadge";
import { useI18n } from "@/i18n";
import { browserApi } from "@/lib/tauri";
import {
  errorMessage,
  formatBytes,
  formatDateTime,
  normalizeProxy,
  normalizeTags,
  readRuntimeStatus,
} from "@/lib/format";
import { useUiStore } from "@/stores/uiStore";
import type {
  BrowserKind,
  Environment,
  EnvironmentDraft,
  ProxyConfig,
  ProxyKind,
  ProxyTestResult,
  Settings,
  TaskRun,
} from "@/types/domain";

const fallbackEnvironmentDefaults = {
  locale: "auto",
  timezone_id: "auto",
  viewport_width: 1280,
  viewport_height: 800,
};

const defaultProxyBypassList = ["localhost", "127.0.0.1", "::1"];
const proxyKinds = new Set<ProxyKind>([
  "none",
  "http",
  "https",
  "socks4",
  "socks5",
]);
const importPlaceholder =
  "name,group,tags,proxy_kind,proxy_host,proxy_port,locale,timezone,start_url";

type ImportPreview = {
  drafts: EnvironmentDraft[];
  errors: string[];
};

type BulkEditDraft = {
  group_id: string;
  tags: string;
  mode: "append" | "replace";
};

function createDefaultEnvironment(
  settings?: Settings,
  nextIndex = 1,
  labels = { name: "Environment", tag: "local" },
): EnvironmentDraft {
  const normalizedIndex = String(Math.max(nextIndex, 1)).padStart(2, "0");
  const settingsLocale = settings?.default_locale?.trim();
  const defaultLocale =
    settingsLocale && settingsLocale.toLowerCase() !== "zh-cn"
      ? settingsLocale
      : fallbackEnvironmentDefaults.locale;

  return {
    name: `${labels.name} ${normalizedIndex}`,
    group_id: "",
    tags: [labels.tag],
    notes: "",
    browser_kind: "chrome",
    chrome_path_override: "",
    profile_dir: "",
    proxy_config: { kind: "none", bypass_list: defaultProxyBypassList },
    locale: defaultLocale,
    timezone_id:
      settings?.default_timezone_id || fallbackEnvironmentDefaults.timezone_id,
    geolocation_latitude: undefined,
    geolocation_longitude: undefined,
    user_agent: "",
    platform: "",
    web_rtc_protection: true,
    viewport_width:
      settings?.default_viewport_width ||
      fallbackEnvironmentDefaults.viewport_width,
    viewport_height:
      settings?.default_viewport_height ||
      fallbackEnvironmentDefaults.viewport_height,
    device_scale_factor: 1,
    environment_mode: "standard",
    seed: "",
    headless: false,
    start_url: "about:blank",
  };
}

function toDraft(environment?: Environment): EnvironmentDraft {
  if (!environment) {
    return createDefaultEnvironment();
  }

  return {
    id: environment.id,
    name: environment.name,
    group_id: environment.group_id ?? "",
    tags: normalizeTags(environment),
    notes: environment.notes ?? "",
    browser_kind: environment.browser_kind,
    chrome_path_override: environment.chrome_path_override ?? "",
    profile_dir: environment.profile_dir ?? "",
    proxy_config: normalizeProxy(environment),
    locale: environment.locale,
    timezone_id: environment.timezone_id,
    geolocation_latitude: environment.geolocation_latitude,
    geolocation_longitude: environment.geolocation_longitude,
    user_agent: environment.user_agent ?? "",
    platform: environment.platform ?? "",
    web_rtc_protection: environment.web_rtc_protection,
    viewport_width: environment.viewport_width,
    viewport_height: environment.viewport_height,
    device_scale_factor: environment.device_scale_factor,
    environment_mode: environment.environment_mode,
    seed: environment.seed ?? "",
    headless: environment.headless,
    start_url: environment.start_url ?? "",
  };
}

function cleanOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeEnvironmentDraft(draft: EnvironmentDraft): EnvironmentDraft {
  const proxyKind = draft.proxy_config?.kind ?? "none";
  const proxyConfig: ProxyConfig =
    proxyKind === "none"
      ? {
          kind: "none",
          bypass_list:
            draft.proxy_config?.bypass_list?.filter(Boolean) ??
            defaultProxyBypassList,
        }
      : {
          kind: proxyKind,
          host: cleanOptionalText(draft.proxy_config?.host),
          port: draft.proxy_config?.port,
          username: cleanOptionalText(draft.proxy_config?.username),
          password: cleanOptionalText(draft.proxy_config?.password),
          bypass_list:
            draft.proxy_config?.bypass_list?.filter(Boolean) ??
            defaultProxyBypassList,
        };

  return {
    ...draft,
    name: draft.name.trim(),
    group_id: cleanOptionalText(draft.group_id),
    tags: (draft.tags ?? []).map((item) => item.trim()).filter(Boolean),
    notes: cleanOptionalText(draft.notes),
    chrome_path_override: cleanOptionalText(draft.chrome_path_override),
    profile_dir: cleanOptionalText(draft.profile_dir),
    proxy_config: proxyConfig,
    locale: draft.locale.trim() || fallbackEnvironmentDefaults.locale,
    timezone_id:
      cleanOptionalText(draft.timezone_id) ??
      fallbackEnvironmentDefaults.timezone_id,
    geolocation_latitude: draft.geolocation_latitude,
    geolocation_longitude: draft.geolocation_longitude,
    user_agent: cleanOptionalText(draft.user_agent),
    platform: cleanOptionalText(draft.platform),
    web_rtc_protection: draft.web_rtc_protection,
    environment_mode: draft.environment_mode ?? "standard",
    seed: cleanOptionalText(draft.seed),
    start_url: cleanOptionalText(draft.start_url),
  };
}

function parseTagsText(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProxyKind(value: string): ProxyKind {
  const normalized = value.trim().toLowerCase() as ProxyKind;
  return proxyKinds.has(normalized) ? normalized : "none";
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseImportRows(input: string): Array<Record<string, unknown>> {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return [];
  }
  const headers = splitCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase(),
  );
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce<Record<string, unknown>>((row, header, index) => {
      row[header] = cells[index] ?? "";
      return row;
    }, {});
  });
}

function readText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function readNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  const value = readText(row, keys);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function importRowsToDrafts(
  rows: Array<Record<string, unknown>>,
  base: EnvironmentDraft,
): ImportPreview {
  const errors: string[] = [];
  const drafts = rows
    .map((row, index) => {
      const name = readText(row, ["name", "名称"]);
      if (!name) {
        errors.push(`Row ${index + 1}: name is required`);
        return null;
      }
      const proxyKind = normalizeProxyKind(
        readText(row, ["proxy_kind", "proxy", "代理类型"]),
      );
      const proxyHost = readText(row, ["proxy_host", "host", "代理主机"]);
      const proxyPort = readNumber(row, ["proxy_port", "port", "代理端口"]);
      const importedTags = parseTagsText(readText(row, ["tags", "标签"]));
      const proxyConfig: ProxyConfig =
        proxyKind !== "none"
          ? {
              kind: proxyKind,
              host: proxyHost || undefined,
              port: proxyPort,
              username: readText(row, ["proxy_username", "username", "代理账号"]) || undefined,
              password: readText(row, ["proxy_password", "password", "代理密码"]) || undefined,
              bypass_list: defaultProxyBypassList,
            }
          : { kind: "none", bypass_list: defaultProxyBypassList };

      return sanitizeEnvironmentDraft({
        ...base,
        id: readText(row, ["id"]) || undefined,
        name,
        group_id: readText(row, ["group", "group_id", "分组"]) || undefined,
        tags: importedTags.length > 0 ? importedTags : base.tags ?? [],
        notes: readText(row, ["notes", "备注"]) || undefined,
        browser_kind:
          (readText(row, ["browser", "browser_kind", "浏览器"]) as BrowserKind) ||
          base.browser_kind,
        chrome_path_override:
          readText(row, ["chrome_path", "chrome_path_override", "chrome路径"]) ||
          undefined,
        proxy_config: proxyConfig,
        locale: readText(row, ["locale", "语言"]) || base.locale,
        timezone_id:
          readText(row, ["timezone", "timezone_id", "时区"]) ||
          base.timezone_id,
        viewport_width:
          readNumber(row, ["viewport_width", "width", "窗口宽度"]) ||
          base.viewport_width,
        viewport_height:
          readNumber(row, ["viewport_height", "height", "窗口高度"]) ||
          base.viewport_height,
        start_url:
          readText(row, ["start_url", "url", "启动地址"]) ||
          base.start_url,
        headless: parseBoolean(row.headless, base.headless),
      });
    })
    .filter(Boolean) as EnvironmentDraft[];

  return { drafts, errors };
}

function recentSuccessRate(environment: Environment, runs: TaskRun[]): number | null {
  const recent = runs
    .filter((run) => run.environment_id === environment.id)
    .filter((run) =>
      ["succeeded", "failed", "timed_out", "interrupted", "cancelled"].includes(run.status),
    )
    .slice(0, 10);
  if (recent.length === 0) {
    return null;
  }
  return recent.filter((run) => run.status === "succeeded").length / recent.length;
}

export function EnvironmentsPage() {
  const queryClient = useQueryClient();
  const { copy, format, language } = useI18n();
  const text = copy.environments;
  const [editing, setEditing] = useState<EnvironmentDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditDraft, setBulkEditDraft] = useState<BulkEditDraft>({
    group_id: "",
    tags: "",
    mode: "append",
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [proxyResults, setProxyResults] = useState<Record<string, string>>({});
  const search = useUiStore((state) => state.environmentSearch);
  const group = useUiStore((state) => state.environmentGroup);
  const tag = useUiStore((state) => state.environmentTag);
  const setSearch = useUiStore((state) => state.setEnvironmentSearch);
  const setGroup = useUiStore((state) => state.setEnvironmentGroup);
  const setTag = useUiStore((state) => state.setEnvironmentTag);

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: browserApi.listEnvironments,
  });

  const statusesQuery = useQuery({
    queryKey: ["environment-statuses"],
    queryFn: browserApi.getEnvironmentStatuses,
    refetchInterval: 3000,
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const runsQuery = useQuery({
    queryKey: ["runs", "environment-health"],
    queryFn: () => browserApi.listRuns({ status: "all" }),
  });

  const diagnosticsQuery = useQuery({
    queryKey: ["diagnostics"],
    queryFn: browserApi.getDiagnostics,
  });

  const createNewDraft = () =>
    createDefaultEnvironment(settingsQuery.data, environments.length + 1, {
      name: text.defaultName,
      tag: text.defaultTag,
    });

  const invalidateEnvironments = () => {
    void queryClient.invalidateQueries({ queryKey: ["environments"] });
    void queryClient.invalidateQueries({ queryKey: ["environment-statuses"] });
  };

  const saveMutation = useMutation({
    mutationFn: async (environment: EnvironmentDraft) => {
      const normalizedEnvironment = sanitizeEnvironmentDraft(environment);
      await browserApi.validateEnvironment(normalizedEnvironment);
      return browserApi.saveEnvironment(normalizedEnvironment);
    },
    onSuccess: () => {
      setEditing(null);
      invalidateEnvironments();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (environmentId: string) =>
      browserApi.deleteEnvironment(environmentId, false),
    onSuccess: invalidateEnvironments,
  });

  const duplicateMutation = useMutation({
    mutationFn: browserApi.duplicateEnvironment,
    onSuccess: invalidateEnvironments,
  });

  const startMutation = useMutation({
    mutationFn: browserApi.startEnvironment,
    onSuccess: invalidateEnvironments,
  });

  const stopMutation = useMutation({
    mutationFn: browserApi.stopEnvironment,
    onSuccess: invalidateEnvironments,
  });

  const restartMutation = useMutation({
    mutationFn: browserApi.restartEnvironment,
    onSuccess: invalidateEnvironments,
  });

  const openProfileMutation = useMutation({
    mutationFn: browserApi.openEnvironmentProfileDir,
  });

  const proxyResultText = (result: ProxyTestResult) => {
    const statusText = result.status_code
      ? format(text.proxyHttpStatus, { status: result.status_code })
      : "";
    const routeText =
      result.ip || result.timezone_id
        ? [result.ip, result.timezone_id].filter(Boolean).join(" / ")
        : "";

    if (result.ok && result.status_code) {
      return [text.proxyReachable, routeText, statusText]
        .filter(Boolean)
        .join(" / ");
    }

    if (result.ok) {
      return text.proxyNotConfigured;
    }

    return result.message;
  };

  const testProxyMutation = useMutation({
    mutationFn: browserApi.testEnvironmentProxy,
    onSuccess: (result, environmentId) => {
      setProxyResults((current) => ({
        ...current,
        [environmentId]: proxyResultText(result),
      }));
      void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    },
    onError: (error, environmentId) => {
      setProxyResults((current) => ({
        ...current,
        [environmentId]: errorMessage(error),
      }));
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async (drafts: EnvironmentDraft[]) => {
      for (const draft of drafts) {
        await browserApi.validateEnvironment(draft);
        await browserApi.saveEnvironment(draft);
      }
      return drafts.length;
    },
    onSuccess: () => {
      setImportOpen(false);
      setImportText("");
      invalidateEnvironments();
    },
  });

  const bulkOperationMutation = useMutation({
    mutationFn: async (operation: "start" | "stop" | "duplicate" | "delete" | "testProxy") => {
      const selected = environments.filter((environment) =>
        selectedIds.includes(environment.id),
      );
      for (const environment of selected) {
        if (operation === "start") {
          await browserApi.startEnvironment(environment.id);
        } else if (operation === "stop") {
          await browserApi.stopEnvironment(environment.id);
        } else if (operation === "duplicate") {
          await browserApi.duplicateEnvironment(environment.id);
        } else if (operation === "delete") {
          await browserApi.deleteEnvironment(environment.id, false);
        } else if (operation === "testProxy") {
          try {
            const result = await browserApi.testEnvironmentProxy(environment.id);
            setProxyResults((current) => ({
              ...current,
              [environment.id]: proxyResultText(result),
            }));
          } catch (error) {
            setProxyResults((current) => ({
              ...current,
              [environment.id]: errorMessage(error),
            }));
          }
        }
      }
    },
    onSuccess: (_result, operation) => {
      if (operation === "delete") {
        setSelectedIds([]);
        setBulkDeleteOpen(false);
      }
      invalidateEnvironments();
      void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const bulkEditMutation = useMutation({
    mutationFn: async (input: BulkEditDraft) => {
      const newTags = parseTagsText(input.tags);
      const selected = environments.filter((environment) =>
        selectedIds.includes(environment.id),
      );
      for (const environment of selected) {
        const currentTags = normalizeTags(environment);
        const tags =
          input.mode === "replace"
            ? newTags
            : Array.from(new Set([...currentTags, ...newTags]));
        await browserApi.saveEnvironment(
          sanitizeEnvironmentDraft({
            ...toDraft(environment),
            group_id: input.group_id.trim() || environment.group_id || "",
            tags,
          }),
        );
      }
    },
    onSuccess: () => {
      setBulkEditOpen(false);
      invalidateEnvironments();
    },
  });

  const environments = environmentsQuery.data ?? [];
  const groups = useMemo(
    () =>
      Array.from(
        new Set(environments.map((item) => item.group_id).filter(Boolean)),
      ) as string[],
    [environments],
  );
  const tags = useMemo(
    () => Array.from(new Set(environments.flatMap(normalizeTags))),
    [environments],
  );

  const filtered = environments.filter((environment) => {
    const environmentTags = normalizeTags(environment);
    const keyword = `${environment.name} ${environment.group_id ?? ""} ${environmentTags.join(" ")}`.toLowerCase();

    return (
      (!search || keyword.includes(search.toLowerCase())) &&
      (!group || environment.group_id === group) &&
      (!tag || environmentTags.includes(tag))
    );
  });
  const filteredIds = filtered.map((environment) => environment.id);
  const selectedEnvironments = environments.filter((environment) =>
    selectedIds.includes(environment.id),
  );
  const selectedCount = selectedEnvironments.length;
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.includes(id));
  const importPreview = useMemo<ImportPreview>(() => {
    try {
      return importRowsToDrafts(
        parseImportRows(importText),
        createDefaultEnvironment(settingsQuery.data, environments.length + 1, {
          name: text.defaultName,
          tag: text.defaultTag,
        }),
      );
    } catch (error) {
      return {
        drafts: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }, [environments.length, importText, settingsQuery.data, text.defaultName, text.defaultTag]);
  const healthByEnvironment = useMemo(() => {
    const runs = runsQuery.data ?? [];
    return environments.reduce<Record<string, { ok: boolean; message: string }>>(
      (acc, environment) => {
        const runtime = readRuntimeStatus(statusesQuery.data, environment.id);
        const proxy = normalizeProxy(environment);
        const proxyResult = proxyResults[environment.id];
        const successRate = recentSuccessRate(environment, runs);
        const issues: string[] = [];
        if (!settingsQuery.data?.chrome_path && !environment.chrome_path_override) {
          issues.push(text.health.chromeMissing);
        }
        if (runtime.status === "crashed") {
          issues.push(text.health.crashed);
        }
        if (proxy.kind !== "none" && !proxyResult) {
          issues.push(text.health.proxyUntested);
        }
        if (
          proxy.kind !== "none" &&
          proxyResult &&
          !proxyResult.includes(text.proxyReachable)
        ) {
          issues.push(text.health.proxyFailed);
        }
        if (successRate !== null && successRate < 0.6) {
          issues.push(text.health.lowSuccessRate);
        }
        if ((diagnosticsQuery.data?.recovery?.stale_lock_count ?? 0) > 0) {
          issues.push(text.health.profileLock);
        }
        const dataBytes =
          (diagnosticsQuery.data?.data?.profiles_total_size ?? 0) +
          (diagnosticsQuery.data?.data?.runs_total_size ?? 0);
        if (dataBytes > 5 * 1024 * 1024 * 1024) {
          issues.push(
            format(text.health.diskUsage, { size: formatBytes(dataBytes) }),
          );
        }
        acc[environment.id] = {
          ok: issues.length === 0,
          message:
            issues.length > 0
              ? issues.join(" / ")
              : successRate === null
                ? text.health.ready
                : format(text.health.successRate, {
                    rate: Math.round(successRate * 100),
                  }),
        };
        return acc;
      },
      {},
    );
  }, [
    environments,
    diagnosticsQuery.data,
    format,
    proxyResults,
    runsQuery.data,
    settingsQuery.data?.chrome_path,
    statusesQuery.data,
    text.health,
    text.proxyReachable,
  ]);
  const healthyCount = environments.filter(
    (environment) => healthByEnvironment[environment.id]?.ok,
  ).length;

  const busy =
    saveMutation.isPending ||
    deleteMutation.isPending ||
    duplicateMutation.isPending ||
    startMutation.isPending ||
    stopMutation.isPending ||
    restartMutation.isPending ||
    bulkImportMutation.isPending ||
    bulkOperationMutation.isPending ||
    bulkEditMutation.isPending;
  const operationError =
    deleteMutation.error ??
    duplicateMutation.error ??
    startMutation.error ??
    stopMutation.error ??
    restartMutation.error ??
    bulkImportMutation.error ??
    bulkOperationMutation.error ??
    bulkEditMutation.error ??
    openProfileMutation.error;
  const runningCount = environments.filter(
    (environment) =>
      readRuntimeStatus(statusesQuery.data, environment.id).status === "running",
  ).length;
  const proxiedCount = environments.filter(
    (environment) => normalizeProxy(environment).kind !== "none",
  ).length;

  return (
    <div className="viewport-page grid-rows-[auto_auto_auto_minmax(0,1fr)]">
      <PageHeader
        eyebrow={text.eyebrow}
        metrics={
          <>
            <MetricTile
              icon={<SquareStack className="h-5 w-5" />}
              label={text.metrics.total}
              tone="blue"
              value={String(environments.length)}
            />
            <MetricTile
              icon={<Power className="h-5 w-5" />}
              label={text.metrics.running}
              tone="green"
              value={String(runningCount)}
            />
            <MetricTile
              icon={<CheckSquare className="h-5 w-5" />}
              label={text.metrics.healthy}
              tone={healthyCount === environments.length ? "green" : "amber"}
              value={`${healthyCount}/${environments.length}`}
            />
            <MetricTile
              icon={<Network className="h-5 w-5" />}
              label={text.metrics.proxied}
              tone="amber"
              value={String(proxiedCount)}
            />
          </>
        }
        title={text.pageTitle}
      />

      <section className="panel shrink-0 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
            <input
              className="control-focus h-9 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={text.searchPlaceholder}
              value={search}
            />
          </div>
          <SelectControl
            wrapperClassName="w-full sm:w-44"
            onChange={(event) => setGroup(event.target.value)}
            value={group}
          >
            <option value="">{copy.common.allGroups}</option>
            {groups.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </SelectControl>
          <SelectControl
            wrapperClassName="w-full sm:w-44"
            onChange={(event) => setTag(event.target.value)}
            value={tag}
          >
            <option value="">{copy.common.allTags}</option>
            {tags.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </SelectControl>
          <Button
            icon={<Upload className="h-4 w-4" />}
            onClick={() => setImportOpen(true)}
          >
            {text.bulk.import}
          </Button>
          <Button
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setEditing(createNewDraft())}
            variant="primary"
          >
            {text.newEnvironment}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            icon={
              allFilteredSelected ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )
            }
            onClick={() =>
              setSelectedIds((current) =>
                allFilteredSelected
                  ? current.filter((id) => !filteredIds.includes(id))
                  : Array.from(new Set([...current, ...filteredIds])),
              )
            }
            size="sm"
          >
            {allFilteredSelected ? text.bulk.clearFiltered : text.bulk.selectFiltered}
          </Button>
          <span className="text-xs font-medium text-ink-500">
            {format(text.bulk.selected, { count: selectedCount })}
          </span>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Wifi className="h-4 w-4" />}
            onClick={() => bulkOperationMutation.mutate("testProxy")}
            size="sm"
          >
            {text.bulk.testProxy}
          </Button>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Play className="h-4 w-4" />}
            onClick={() => bulkOperationMutation.mutate("start")}
            size="sm"
          >
            {text.bulk.start}
          </Button>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Power className="h-4 w-4" />}
            onClick={() => bulkOperationMutation.mutate("stop")}
            size="sm"
          >
            {text.bulk.stop}
          </Button>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Copy className="h-4 w-4" />}
            onClick={() => bulkOperationMutation.mutate("duplicate")}
            size="sm"
          >
            {text.bulk.duplicate}
          </Button>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Tags className="h-4 w-4" />}
            onClick={() => {
              setBulkEditDraft({
                group_id: selectedEnvironments[0]?.group_id ?? "",
                tags: "",
                mode: "append",
              });
              setBulkEditOpen(true);
            }}
            size="sm"
          >
            {text.bulk.editTags}
          </Button>
          <Button
            disabled={selectedCount === 0 || busy}
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => setBulkDeleteOpen(true)}
            size="sm"
            variant="danger"
          >
            {text.bulk.delete}
          </Button>
        </div>
      </section>

      {operationError ? (
        <div className="rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
          {errorMessage(operationError)}
        </div>
      ) : null}

      {environmentsQuery.isLoading ? (
        <section className="panel scroll-panel">
          <SkeletonRows rows={6} />
        </section>
      ) : environmentsQuery.isError ? (
        <EmptyState
          description={errorMessage(environmentsQuery.error)}
          icon={<SquareStack className="h-5 w-5" />}
          title={text.loadFailed}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          action={
            <Button onClick={() => setEditing(createNewDraft())} variant="primary">
              {text.newEnvironment}
            </Button>
          }
          description={text.emptyDescription}
          icon={<SquareStack className="h-5 w-5" />}
          title={text.emptyTitle}
        />
      ) : (
        <section className="panel table-scroll environment-table-scroll min-h-0 min-w-0">
          <table className="w-full border-collapse">
            <colgroup>
              <col className="w-[46px]" />
              <col className="w-[230px]" />
              <col className="w-[120px]" />
              <col className="w-[210px]" />
              <col className="w-[120px]" />
              <col className="w-[180px]" />
              <col className="w-[140px]" />
              <col className="w-[180px]" />
              <col className="w-[110px]" />
              <col className="w-[130px]" />
              <col className="w-[220px]" />
            </colgroup>
            <thead className="table-header">
              <tr>
                <th className="px-4 py-3">
                  <input
                    checked={allFilteredSelected}
                    onChange={() =>
                      setSelectedIds((current) =>
                        allFilteredSelected
                          ? current.filter((id) => !filteredIds.includes(id))
                          : Array.from(new Set([...current, ...filteredIds])),
                      )
                    }
                    type="checkbox"
                  />
                </th>
                <th className="px-4 py-3">{text.table.name}</th>
                <th className="px-4 py-3">{text.table.group}</th>
                <th className="px-4 py-3">{text.table.proxy}</th>
                <th className="px-4 py-3">{text.table.locale}</th>
                <th className="px-4 py-3">{text.table.timezone}</th>
                <th className="px-4 py-3">{text.table.viewport}</th>
                <th className="px-4 py-3">{text.table.health}</th>
                <th className="px-4 py-3">{copy.common.status}</th>
                <th className="px-4 py-3">{text.table.updated}</th>
                <th className="table-action-header">{copy.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((environment) => {
                const proxy = normalizeProxy(environment);
                const runtime = readRuntimeStatus(
                  statusesQuery.data,
                  environment.id,
                );
                const health = healthByEnvironment[environment.id];
                return (
                  <tr key={environment.id} className="table-row-hover">
                    <td className="table-cell">
                      <input
                        checked={selectedIds.includes(environment.id)}
                        onChange={(event) =>
                          setSelectedIds((current) =>
                            event.target.checked
                              ? [...current, environment.id]
                              : current.filter((id) => id !== environment.id),
                          )
                        }
                        type="checkbox"
                      />
                    </td>
                    <td className="table-cell">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                          <Globe2 className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink-900">
                            {environment.name}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {normalizeTags(environment).length > 0 ? (
                              normalizeTags(environment).map((item) => (
                                <span
                                  className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500"
                                  key={item}
                                >
                                  {item}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-ink-500">{text.noTags}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="table-cell text-ink-700">
                      {environment.group_id || "-"}
                    </td>
                    <td className="table-cell text-ink-700">
                      <div className="max-w-56">
                        <div className="truncate">
                          {proxy.kind === "none"
                            ? text.noProxy
                            : `${proxy.kind}://${proxy.host ?? "-"}:${proxy.port ?? "-"}`}
                        </div>
                        {proxyResults[environment.id] ? (
                          <div className="mt-1 truncate text-xs text-ink-500">
                            {proxyResults[environment.id]}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="table-cell text-ink-700">
                      {environment.locale}
                    </td>
                    <td className="table-cell text-ink-700">
                      {environment.timezone_id}
                    </td>
                    <td className="table-cell text-ink-700">
                      <span className="mono-tabular">
                        {environment.viewport_width}x{environment.viewport_height}
                      </span>
                      <span className="ml-1 text-xs text-ink-500">
                        @{environment.device_scale_factor}
                      </span>
                    </td>
                    <td className="table-cell text-ink-700">
                      <div
                        className={`max-w-44 truncate rounded-md px-2 py-1 text-xs font-medium ${
                          health?.ok
                            ? "bg-green-50 text-ok"
                            : "bg-amber-50 text-warn"
                        }`}
                        title={health?.message}
                      >
                        {health?.message ?? text.health.ready}
                      </div>
                    </td>
                    <td className="table-cell">
                      <StatusBadge status={runtime.status} />
                    </td>
                    <td className="table-cell text-ink-700">
                      {formatDateTime(environment.updated_at, language)}
                    </td>
                    <td className="table-action-cell">
                      <div className="flex w-[196px] flex-wrap justify-end gap-1">
                        {runtime.status === "running" ? (
                          <Button
                            aria-label={text.actions.stop}
                            className="h-7 px-1.5"
                            disabled={busy}
                            icon={<Power className="h-4 w-4" />}
                            onClick={() => stopMutation.mutate(environment.id)}
                            variant="ghost"
                          />
                        ) : (
                          <Button
                            aria-label={text.actions.start}
                            className="h-7 px-1.5"
                            disabled={busy}
                            icon={<Play className="h-4 w-4" />}
                            onClick={() => startMutation.mutate(environment.id)}
                            variant="ghost"
                          />
                        )}
                        <Button
                          aria-label={text.actions.restart}
                          className="h-7 px-1.5"
                          disabled={busy}
                          icon={<RefreshCw className="h-4 w-4" />}
                          onClick={() => restartMutation.mutate(environment.id)}
                          variant="ghost"
                        />
                        <Button
                          aria-label={text.actions.testProxy}
                          className="h-7 px-1.5"
                          disabled={testProxyMutation.isPending}
                          icon={<Wifi className="h-4 w-4" />}
                          onClick={() => testProxyMutation.mutate(environment.id)}
                          variant="ghost"
                        />
                        <Button
                          aria-label={text.actions.openProfile}
                          className="h-7 px-1.5"
                          disabled={openProfileMutation.isPending}
                          icon={<FolderOpen className="h-4 w-4" />}
                          onClick={() => openProfileMutation.mutate(environment.id)}
                          variant="ghost"
                        />
                        <Button
                          aria-label={copy.common.edit}
                          className="h-7 px-1.5"
                          icon={<Edit2 className="h-4 w-4" />}
                          onClick={() => setEditing(toDraft(environment))}
                          variant="ghost"
                        />
                        <Button
                          aria-label={text.actions.duplicate}
                          className="h-7 px-1.5"
                          disabled={busy}
                          icon={<Copy className="h-4 w-4" />}
                          onClick={() => duplicateMutation.mutate(environment.id)}
                          variant="ghost"
                        />
                        <Button
                          aria-label={copy.common.delete}
                          className="h-7 px-1.5"
                          disabled={busy}
                          icon={<Trash2 className="h-4 w-4" />}
                          onClick={() => setDeleteTarget(environment)}
                          variant="ghost"
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <EnvironmentModal
        error={
          saveMutation.error ??
          openProfileMutation.error ??
          restartMutation.error ??
          testProxyMutation.error
        }
        environment={editing}
        pending={saveMutation.isPending}
        onClose={() => setEditing(null)}
        onSave={(value) => saveMutation.mutate(value)}
      />
      <Modal
        footer={
          <>
            <Button onClick={() => setImportOpen(false)}>{copy.common.cancel}</Button>
            <Button
              disabled={
                bulkImportMutation.isPending ||
                importPreview.drafts.length === 0 ||
                importPreview.errors.length > 0
              }
              onClick={() => bulkImportMutation.mutate(importPreview.drafts)}
              variant="primary"
            >
              {format(text.bulk.importConfirm, {
                count: importPreview.drafts.length,
              })}
            </Button>
          </>
        }
        open={importOpen}
        title={text.bulk.import}
        widthClass="max-w-3xl"
        onClose={() => setImportOpen(false)}
      >
        <div className="grid gap-3">
          <p className="text-sm leading-6 text-ink-600">
            {text.bulk.importHint}
          </p>
          <TextareaField
            label={text.bulk.importInput}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={importPlaceholder}
            value={importText}
          />
          <div className="grid gap-2 rounded-lg border border-line bg-ink-50 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink-900">{text.bulk.importPreview}</span>
              <span className="mono-tabular text-ink-500">
                {importPreview.drafts.length}
              </span>
            </div>
            {importPreview.errors.length > 0 ? (
              <div className="grid gap-1 text-danger">
                {importPreview.errors.map((error) => (
                  <div key={error}>{error}</div>
                ))}
              </div>
            ) : null}
            <div className="grid max-h-48 gap-1 overflow-auto">
              {importPreview.drafts.slice(0, 20).map((draft) => (
                <div
                  className="flex items-center justify-between gap-3 rounded bg-white px-2 py-1"
                  key={`${draft.id ?? draft.name}-${draft.name}`}
                >
                  <span className="truncate text-ink-800">{draft.name}</span>
                  <span className="truncate text-xs text-ink-500">
                    {draft.group_id || copy.common.defaultGroup}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
      <Modal
        footer={
          <>
            <Button onClick={() => setBulkEditOpen(false)}>{copy.common.cancel}</Button>
            <Button
              disabled={bulkEditMutation.isPending || selectedCount === 0}
              onClick={() => bulkEditMutation.mutate(bulkEditDraft)}
              variant="primary"
            >
              {text.bulk.apply}
            </Button>
          </>
        }
        open={bulkEditOpen}
        title={text.bulk.editTags}
        widthClass="max-w-md"
        onClose={() => setBulkEditOpen(false)}
      >
        <div className="grid gap-3">
          <p className="text-sm text-ink-600">
            {format(text.bulk.editHint, { count: selectedCount })}
          </p>
          <TextField
            label={text.fields.group}
            onChange={(event) =>
              setBulkEditDraft((current) => ({
                ...current,
                group_id: event.target.value,
              }))
            }
            value={bulkEditDraft.group_id}
          />
          <TextField
            label={text.fields.tags}
            onChange={(event) =>
              setBulkEditDraft((current) => ({
                ...current,
                tags: event.target.value,
              }))
            }
            value={bulkEditDraft.tags}
          />
          <SelectField
            label={text.bulk.tagMode}
            onChange={(event) =>
              setBulkEditDraft((current) => ({
                ...current,
                mode: event.target.value as BulkEditDraft["mode"],
              }))
            }
            value={bulkEditDraft.mode}
          >
            <option value="append">{text.bulk.appendTags}</option>
            <option value="replace">{text.bulk.replaceTags}</option>
          </SelectField>
        </div>
      </Modal>
      <Modal
        footer={
          <>
            <Button onClick={() => setBulkDeleteOpen(false)}>{copy.common.cancel}</Button>
            <Button
              disabled={bulkOperationMutation.isPending || selectedCount === 0}
              onClick={() => bulkOperationMutation.mutate("delete")}
              variant="danger"
            >
              {text.bulk.delete}
            </Button>
          </>
        }
        open={bulkDeleteOpen}
        title={text.bulk.delete}
        widthClass="max-w-md"
        onClose={() => setBulkDeleteOpen(false)}
      >
        <p className="text-sm leading-6 text-ink-700">
          {format(text.bulk.deleteBody, { count: selectedCount })}
        </p>
      </Modal>
      <Modal
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>{copy.common.cancel}</Button>
            <Button
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate(deleteTarget.id, {
                    onSuccess: () => setDeleteTarget(null),
                  });
                }
              }}
              variant="danger"
            >
              {text.deleteTitle}
            </Button>
          </>
        }
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        widthClass="max-w-md"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm leading-6 text-ink-700">
          {text.deleteBody}
        </p>
        <p className="mt-3 truncate rounded-xl bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.name}
        </p>
      </Modal>
    </div>
  );
}

interface EnvironmentModalProps {
  environment: EnvironmentDraft | null;
  error: unknown;
  pending: boolean;
  onClose: () => void;
  onSave: (environment: EnvironmentDraft) => void;
}

function EnvironmentModal({
  environment,
  error,
  pending,
  onClose,
  onSave,
}: EnvironmentModalProps) {
  const { copy } = useI18n();
  const text = copy.environments;
  const [draft, setDraft] = useState<EnvironmentDraft>(environment ?? toDraft());

  useEffect(() => {
    if (environment) {
      setDraft(environment);
    }
  }, [environment]);

  if (!environment) {
    return null;
  }

  const update = <TKey extends keyof EnvironmentDraft>(
    key: TKey,
    value: EnvironmentDraft[TKey],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const updateProxy = <TKey extends keyof ProxyConfig>(
    key: TKey,
    value: ProxyConfig[TKey],
  ) => {
    setDraft((current) => ({
      ...current,
      proxy_config: {
        kind: "none",
        ...current.proxy_config,
        [key]: value,
      } as ProxyConfig,
    }));
  };

  return (
    <Modal
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button
            disabled={pending || !draft.name.trim()}
            onClick={() => onSave(draft)}
            variant="primary"
          >
            {text.saveEnvironment}
          </Button>
        </>
      }
      open
      title={draft.id ? text.editTitle : text.newTitle}
      widthClass="max-w-4xl"
      onClose={onClose}
    >
      <div className="grid gap-5">
        {error ? (
          <div className="rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
            {errorMessage(error)}
          </div>
        ) : null}

        <section className="grid gap-3">
          <h3 className="text-sm font-semibold text-ink-900">{text.sections.basics}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              hint={text.fields.nameHint}
              label={text.fields.name}
              onChange={(event) => update("name", event.target.value)}
              requiredMark
              value={draft.name}
            />
            <TextField
              hint={text.fields.groupHint}
              label={text.fields.group}
              onChange={(event) => update("group_id", event.target.value)}
              value={draft.group_id ?? ""}
            />
            <TextField
              hint={text.fields.tagsHint}
              label={text.fields.tags}
              onChange={(event) =>
                update(
                  "tags",
                  event.target.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
              }
              value={(draft.tags ?? []).join(", ")}
            />
          </div>
          <TextareaField
            label={text.fields.notes}
            onChange={(event) => update("notes", event.target.value)}
            value={draft.notes ?? ""}
          />
        </section>

        <section className="grid gap-3">
          <h3 className="text-sm font-semibold text-ink-900">{text.sections.browser}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <SelectField
              label={copy.common.browser}
              onChange={(event) =>
                update("browser_kind", event.target.value as BrowserKind)
              }
              value={draft.browser_kind}
            >
              <option value="chrome">Chrome</option>
              <option value="chromium">Chromium</option>
            </SelectField>
            <TextField
              label={text.fields.startUrl}
              onChange={(event) => update("start_url", event.target.value)}
              value={draft.start_url ?? ""}
            />
            <TextField
              hint={text.fields.chromePathHint}
              label={text.fields.chromePathOverride}
              onChange={(event) =>
                update("chrome_path_override", event.target.value)
              }
              value={draft.chrome_path_override ?? ""}
            />
            <TextField
              hint={text.fields.profileHint}
              label={text.fields.profileDir}
              onChange={(event) => update("profile_dir", event.target.value)}
              value={draft.profile_dir ?? ""}
            />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-700">
            <input
              checked={draft.headless}
              className="h-4 w-4"
              onChange={(event) => update("headless", event.target.checked)}
              type="checkbox"
            />
            Headless
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-700">
            <input
              checked={draft.web_rtc_protection}
              className="h-4 w-4"
              onChange={(event) =>
                update("web_rtc_protection", event.target.checked)
              }
              type="checkbox"
            />
            {text.fields.webRtcProtection}
          </label>
        </section>

        <section className="grid gap-3">
          <h3 className="text-sm font-semibold text-ink-900">{text.sections.proxy}</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <SelectField
              label={text.fields.proxyType}
              onChange={(event) =>
                updateProxy("kind", event.target.value as ProxyKind)
              }
              value={draft.proxy_config?.kind ?? "none"}
            >
              <option value="none">{text.fields.proxyNone}</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks4">SOCKS4</option>
              <option value="socks5">SOCKS5</option>
            </SelectField>
            <TextField
              hint={text.fields.hostHint}
              label={text.fields.host}
              onChange={(event) => updateProxy("host", event.target.value)}
              value={draft.proxy_config?.host ?? ""}
            />
            <TextField
              label={text.fields.port}
              min={0}
              onChange={(event) =>
                updateProxy("port", Number(event.target.value) || undefined)
              }
              type="number"
              value={draft.proxy_config?.port ?? ""}
            />
            <TextField
              label={text.fields.username}
              onChange={(event) => updateProxy("username", event.target.value)}
              value={draft.proxy_config?.username ?? ""}
            />
            <TextField
              label={text.fields.password}
              onChange={(event) => updateProxy("password", event.target.value)}
              type="password"
              value={draft.proxy_config?.password ?? ""}
            />
          </div>
          <TextField
            label={text.fields.bypassList}
            onChange={(event) =>
              updateProxy(
                "bypass_list",
                event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
            value={(draft.proxy_config?.bypass_list ?? []).join(", ")}
          />
        </section>

        <section className="grid gap-3">
          <h3 className="text-sm font-semibold text-ink-900">{text.sections.runtime}</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <TextField
              hint={text.fields.localeHint}
              label={text.fields.locale}
              onChange={(event) => update("locale", event.target.value)}
              value={draft.locale}
            />
            <TextField
              hint={text.fields.timezoneHint}
              label={copy.common.timezone}
              onChange={(event) => update("timezone_id", event.target.value)}
              value={draft.timezone_id}
            />
            <TextField
              hint={text.fields.latitudeHint}
              label={text.fields.latitude}
              max={90}
              min={-90}
              onChange={(event) =>
                update("geolocation_latitude", parseOptionalNumber(event.target.value))
              }
              step="any"
              type="number"
              value={draft.geolocation_latitude ?? ""}
            />
            <TextField
              hint={text.fields.longitudeHint}
              label={text.fields.longitude}
              max={180}
              min={-180}
              onChange={(event) =>
                update("geolocation_longitude", parseOptionalNumber(event.target.value))
              }
              step="any"
              type="number"
              value={draft.geolocation_longitude ?? ""}
            />
            <TextField
              label={text.fields.viewportWidth}
              min={320}
              onChange={(event) =>
                update("viewport_width", Number(event.target.value) || 1280)
              }
              type="number"
              value={draft.viewport_width}
            />
            <TextField
              label={text.fields.viewportHeight}
              min={240}
              onChange={(event) =>
                update("viewport_height", Number(event.target.value) || 800)
              }
              type="number"
              value={draft.viewport_height}
            />
            <TextField
              label={text.fields.scaleFactor}
              min={0.5}
              onChange={(event) =>
                update("device_scale_factor", Number(event.target.value) || 1)
              }
              step={0.25}
              type="number"
              value={draft.device_scale_factor}
            />
            <TextField
              hint={text.fields.platformHint}
              label={text.fields.platform}
              onChange={(event) => update("platform", event.target.value)}
              value={draft.platform ?? ""}
            />
            <TextField
              hint={text.fields.seedHint}
              label={text.fields.seed}
              onChange={(event) => update("seed", event.target.value)}
              value={draft.seed ?? ""}
            />
          </div>
          <TextareaField
            hint={text.fields.userAgentHint}
            label={text.fields.userAgent}
            onChange={(event) => update("user_agent", event.target.value)}
            value={draft.user_agent ?? ""}
          />
        </section>
      </div>
    </Modal>
  );
}
