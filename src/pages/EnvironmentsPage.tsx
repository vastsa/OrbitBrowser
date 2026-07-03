import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Edit2,
  FolderOpen,
  Globe2,
  Layers3,
  Network,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  SquareStack,
  Trash2,
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
} from "@/types/domain";

const fallbackEnvironmentDefaults = {
  locale: "auto",
  timezone_id: "auto",
  viewport_width: 1280,
  viewport_height: 800,
};

const defaultProxyBypassList = ["localhost", "127.0.0.1", "::1"];

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

export function EnvironmentsPage() {
  const queryClient = useQueryClient();
  const { copy, format, language } = useI18n();
  const text = copy.environments;
  const [editing, setEditing] = useState<EnvironmentDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
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

  const busy =
    saveMutation.isPending ||
    deleteMutation.isPending ||
    duplicateMutation.isPending ||
    startMutation.isPending ||
    stopMutation.isPending ||
    restartMutation.isPending;
  const operationError =
    deleteMutation.error ??
    duplicateMutation.error ??
    startMutation.error ??
    stopMutation.error ??
    restartMutation.error ??
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
              icon={<Layers3 className="h-5 w-5" />}
              label={text.metrics.groups}
              tone="cyan"
              value={String(groups.length)}
            />
            <MetricTile
              icon={<Network className="h-5 w-5" />}
              label={text.metrics.proxied}
              tone="amber"
              value={String(proxiedCount)}
            />
          </>
        }
        subtitle={text.subtitle}
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
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setEditing(createNewDraft())}
            variant="primary"
          >
            {text.newEnvironment}
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
              <col className="w-[230px]" />
              <col className="w-[120px]" />
              <col className="w-[210px]" />
              <col className="w-[120px]" />
              <col className="w-[180px]" />
              <col className="w-[140px]" />
              <col className="w-[110px]" />
              <col className="w-[130px]" />
              <col className="w-[220px]" />
            </colgroup>
            <thead className="table-header">
              <tr>
                <th className="px-4 py-3">{text.table.name}</th>
                <th className="px-4 py-3">{text.table.group}</th>
                <th className="px-4 py-3">{text.table.proxy}</th>
                <th className="px-4 py-3">{text.table.locale}</th>
                <th className="px-4 py-3">{text.table.timezone}</th>
                <th className="px-4 py-3">{text.table.viewport}</th>
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
                return (
                  <tr key={environment.id} className="table-row-hover">
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
