import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FileJson2,
  FolderOpen,
  Play,
  RefreshCw,
  Rocket,
  Search,
  SquareStack,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile, PageHeader, SectionHeader } from "@/components/PageScaffold";
import { StatusBadge } from "@/components/StatusBadge";
import { useI18n } from "@/i18n";
import { errorMessage, formatDateTime, formatDuration, statusLabel } from "@/lib/format";
import { browserApi } from "@/lib/tauri";
import type {
  AutomationTask,
  AutomationTaskDraft,
  Environment,
  EnvironmentDraft,
  RunBatch,
  TaskRun,
} from "@/types/domain";

const quickStartTag = "quick-start";
const defaultProxyBypassList = ["localhost", "127.0.0.1", "::1"];

function isActiveRun(run: TaskRun) {
  return ["queued", "starting", "running", "cancel_requested"].includes(run.status);
}

function createQuickStartEnvironment(
  language: string,
  settingsLocale?: string | null,
  settingsTimezone?: string | null,
): EnvironmentDraft {
  const isEnglish = language === "en-US";
  return {
    name: isEnglish ? "Quick Start Environment" : "快速开始环境",
    group_id: isEnglish ? "quick-start" : "快速开始",
    tags: [quickStartTag, isEnglish ? "local" : "本机"],
    notes: isEnglish
      ? "Created by the first-run quick start flow."
      : "由首次使用快速开始流程创建。",
    browser_kind: "chrome",
    chrome_path_override: "",
    profile_dir: "",
    proxy_config: { kind: "none", bypass_list: defaultProxyBypassList },
    locale: settingsLocale || (isEnglish ? "en-US" : "zh-CN"),
    timezone_id: settingsTimezone || "auto",
    geolocation_latitude: undefined,
    geolocation_longitude: undefined,
    user_agent: "",
    platform: "",
    web_rtc_protection: true,
    viewport_width: 1280,
    viewport_height: 800,
    device_scale_factor: 1,
    environment_mode: "standard",
    seed: "",
    headless: false,
    start_url: "https://example.com",
  };
}

function createQuickStartTask(language: string): AutomationTaskDraft {
  const isEnglish = language === "en-US";
  return {
    name: isEnglish ? "Quick Start Smoke Task" : "快速开始 Smoke 任务",
    description: isEnglish
      ? "Opens example.com, records the title, emits JSON, and saves a screenshot."
      : "打开 example.com，记录标题，输出 JSON，并保存截图。",
    timeout_sec: 60,
    api_version: "v1",
    permissions: {
      screenshots: true,
      external_urls: ["<all_urls>"],
      clipboard: false,
    },
    script: [
      'await page.goto("https://example.com", { waitUntil: "load", timeout: 30000 });',
      "const title = await page.title();",
      "const url = await page.url();",
      'log.info(`Quick start page title: ${title}`);',
      'await run.outputJson("quick-start-result", { title, url, checkedAt: new Date().toISOString() });',
      'await page.screenshot("quick-start-home");',
    ].join("\n"),
  };
}

function findQuickStartEnvironment(environments: Environment[]) {
  return environments.find((environment) =>
    (environment.tags ?? []).includes(quickStartTag),
  );
}

function findQuickStartTask(tasks: AutomationTask[]) {
  return tasks.find((task) =>
    task.name.toLowerCase().includes("quick start") ||
    task.name.includes("快速开始"),
  );
}

export function QuickStartPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { copy, language } = useI18n();
  const text = copy.quickStart;
  const [lastBatch, setLastBatch] = useState<RunBatch | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: browserApi.listEnvironments,
  });

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const runsQuery = useQuery({
    enabled: Boolean(lastBatch),
    queryKey: ["runs", "quick-start", lastBatch?.id],
    queryFn: () => browserApi.listRuns({ batch_id: lastBatch?.id, status: "all" }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some(isActiveRun) ? 2000 : false,
  });

  const latestRun = useMemo(() => {
    const runs = runsQuery.data ?? [];
    return runs[0] ?? null;
  }, [runsQuery.data]);

  const artifactsQuery = useQuery({
    enabled: Boolean(latestRun),
    queryKey: ["run-artifacts", latestRun?.id],
    queryFn: () => browserApi.listRunArtifacts(latestRun?.id ?? ""),
  });

  const logsQuery = useQuery({
    enabled: Boolean(latestRun),
    queryKey: ["run-logs", latestRun?.id],
    queryFn: () => browserApi.getRunLogs(latestRun?.id ?? ""),
  });

  const detectMutation = useMutation({
    mutationFn: browserApi.detectChrome,
    onSuccess: async (result) => {
      if (!result.path || !settingsQuery.data) {
        return;
      }
      await browserApi.saveSettings({
        ...settingsQuery.data,
        chrome_path: result.path,
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const detection = await browserApi.detectChrome();
      const settings = settingsQuery.data ?? (await browserApi.getSettings());
      if (detection.path) {
        await browserApi.saveSettings({ ...settings, chrome_path: detection.path });
      }

      const environments = environmentsQuery.data ?? (await browserApi.listEnvironments());
      const existingEnvironment = findQuickStartEnvironment(environments);
      const environment =
        existingEnvironment ??
        (await browserApi.saveEnvironment(
          createQuickStartEnvironment(
            language,
            settings.default_locale,
            settings.default_timezone_id,
          ),
        ));

      const tasks = tasksQuery.data ?? (await browserApi.listTasks());
      const existingTask = findQuickStartTask(tasks);
      const task =
        existingTask ??
        (await browserApi.saveTask(createQuickStartTask(language)));

      await browserApi.startEnvironment(environment.id);
      return browserApi.runTask(task.id, [environment.id], {
        auto_start_browser: true,
        close_browser_after_run: false,
        max_concurrency: 1,
        stop_on_first_error: true,
      });
    },
    onSuccess: async (batch) => {
      setLastBatch(batch);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["environments"] }),
        queryClient.invalidateQueries({ queryKey: ["environment-statuses"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });

  const retryFailedMutation = useMutation({
    mutationFn: async () => {
      const failedRuns = (runsQuery.data ?? []).filter((run) =>
        ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status),
      );
      await Promise.all(failedRuns.map((run) => browserApi.retryRun(run.id)));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const environments = environmentsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const quickEnvironment = findQuickStartEnvironment(environments);
  const quickTask = findQuickStartTask(tasks);
  const runs = runsQuery.data ?? [];
  const succeeded = runs.filter((run) => run.status === "succeeded").length;
  const failed = runs.filter((run) =>
    ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status),
  ).length;
  const active = runs.filter(isActiveRun).length;
  const chromeReady = Boolean(settingsQuery.data?.chrome_path);
  const dataReady = Boolean(settingsQuery.data?.data_dir);
  const hasFailure = failed > 0;
  const operationError =
    detectMutation.error ?? runMutation.error ?? retryFailedMutation.error;

  return (
    <div className="viewport-page grid-rows-[auto_minmax(0,1fr)]">
      <PageHeader
        actions={
          <>
            <Button
              disabled={detectMutation.isPending}
              icon={<Search className="h-4 w-4" />}
              onClick={() => detectMutation.mutate()}
            >
              {text.detectChrome}
            </Button>
            <Button
              disabled={runMutation.isPending}
              icon={<Play className="h-4 w-4" />}
              onClick={() => runMutation.mutate()}
              variant="primary"
            >
              {runMutation.isPending ? text.running : text.runDemo}
            </Button>
          </>
        }
        eyebrow={text.eyebrow}
        metrics={
          <>
            <MetricTile
              icon={<Search className="h-5 w-5" />}
              label={text.metrics.chrome}
              tone={chromeReady ? "green" : "amber"}
              value={chromeReady ? text.ready : text.pending}
            />
            <MetricTile
              icon={<SquareStack className="h-5 w-5" />}
              label={text.metrics.environment}
              tone={quickEnvironment ? "green" : "slate"}
              value={quickEnvironment ? text.ready : text.pending}
            />
            <MetricTile
              icon={<FileJson2 className="h-5 w-5" />}
              label={text.metrics.task}
              tone={quickTask ? "green" : "slate"}
              value={quickTask ? text.ready : text.pending}
            />
            <MetricTile
              icon={<CheckCircle2 className="h-5 w-5" />}
              label={text.metrics.result}
              tone={succeeded > 0 ? "green" : failed > 0 ? "amber" : "slate"}
              value={
                succeeded > 0
                  ? text.succeeded
                  : failed > 0
                    ? text.needsAttention
                    : text.pending
              }
            />
          </>
        }
        subtitle={text.subtitle}
        title={text.pageTitle}
      />

      <div className="scroll-panel grid min-h-0 gap-3 pr-1 xl:grid-cols-[minmax(0,1fr)_390px] xl:pr-0">
        <section className="panel p-4">
          <SectionHeader
            actions={
              <Button
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={() => {
                  void settingsQuery.refetch();
                  void environmentsQuery.refetch();
                  void tasksQuery.refetch();
                  void runsQuery.refetch();
                }}
              >
                {copy.common.refresh}
              </Button>
            }
            subtitle={text.workflowSubtitle}
            title={text.workflowTitle}
          />

          {operationError ? (
            <div className="mb-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
              {errorMessage(operationError)}
            </div>
          ) : null}

          <div className="grid gap-2">
            <StepRow
              description={
                chromeReady
                  ? settingsQuery.data?.chrome_path ?? text.chromeConfigured
                  : text.chromePending
              }
              done={chromeReady}
              index={1}
              title={text.steps.chrome}
            />
            <StepRow
              description={
                dataReady
                  ? settingsQuery.data?.data_dir ?? text.dataConfigured
                  : text.dataPending
              }
              done={dataReady}
              index={2}
              title={text.steps.data}
            />
            <StepRow
              description={quickEnvironment?.name ?? text.environmentPending}
              done={Boolean(quickEnvironment)}
              index={3}
              title={text.steps.environment}
            />
            <StepRow
              description={quickTask?.name ?? text.taskPending}
              done={Boolean(quickTask)}
              index={4}
              title={text.steps.task}
            />
            <StepRow
              description={
                latestRun
                  ? `${statusLabel(latestRun.status, language)}${
                      latestRun.error_message ? `: ${latestRun.error_message}` : ""
                    }`
                  : text.runPending
              }
              done={succeeded > 0}
              index={5}
              title={text.steps.run}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={runMutation.isPending}
              icon={<Play className="h-4 w-4" />}
              onClick={() => runMutation.mutate()}
              variant="primary"
            >
              {text.runDemo}
            </Button>
            <Button onClick={() => navigate("/environments")}>
              {text.openEnvironments}
            </Button>
            <Button onClick={() => navigate("/tasks")}>{text.openTasks}</Button>
            <Button onClick={() => navigate("/runs")}>{text.openRuns}</Button>
          </div>
        </section>

        <aside className="grid content-start gap-3">
          <section className="panel p-4">
            <SectionHeader
              actions={
                hasFailure ? (
                  <Button
                    disabled={retryFailedMutation.isPending}
                    icon={<RefreshCw className="h-4 w-4" />}
                    onClick={() => retryFailedMutation.mutate()}
                    size="sm"
                  >
                    {copy.common.retry}
                  </Button>
                ) : null
              }
              subtitle={text.resultSubtitle}
              title={text.resultTitle}
            />

            {!lastBatch ? (
              <EmptyState
                description={text.noResultDescription}
                icon={<Rocket className="h-5 w-5" />}
                title={text.noResultTitle}
              />
            ) : (
              <div className="grid gap-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <SummaryPill label={text.summary.active} value={active} />
                  <SummaryPill label={text.summary.succeeded} value={succeeded} />
                  <SummaryPill label={text.summary.failed} value={failed} />
                </div>

                {latestRun ? (
                  <div className="rounded-lg border border-line bg-ink-50 px-3 py-2 text-sm">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-medium text-ink-900">{text.latestRun}</span>
                      <StatusBadge status={latestRun.status} />
                    </div>
                    <dl className="grid gap-1 text-xs text-ink-500">
                      <div className="flex justify-between gap-3">
                        <dt>{copy.common.status}</dt>
                        <dd className="text-ink-900">
                          {statusLabel(latestRun.status, language)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>{text.duration}</dt>
                        <dd className="text-ink-900">
                          {formatDuration(latestRun.started_at, latestRun.finished_at)}
                        </dd>
                      </div>
                      {latestRun.finished_at ? (
                        <div className="flex justify-between gap-3">
                          <dt>{text.finishedAt}</dt>
                          <dd className="truncate text-ink-900">
                            {formatDateTime(latestRun.finished_at, language)}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                ) : null}

                <div className="grid gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-normal text-ink-500">
                    {copy.common.artifacts}
                  </h3>
                  {(artifactsQuery.data ?? []).length === 0 ? (
                    <p className="text-sm text-ink-500">{text.noArtifacts}</p>
                  ) : (
                    (artifactsQuery.data ?? []).map((artifact) => (
                      <button
                        className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left text-sm transition-colors duration-200 hover:border-brand-500 hover:bg-brand-50"
                        key={artifact.id}
                        onClick={() => browserApi.openRunArtifact(artifact.path)}
                        type="button"
                      >
                        <span className="min-w-0 truncate">{artifact.label}</span>
                        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">
                          {artifact.kind}
                        </span>
                      </button>
                    ))
                  )}
                </div>

                {latestRun ? (
                  <Button
                    icon={<FolderOpen className="h-4 w-4" />}
                    onClick={() => browserApi.openRunArtifactsDir(latestRun.id)}
                  >
                    {text.openArtifactFolder}
                  </Button>
                ) : null}
              </div>
            )}
          </section>

          <section className="panel p-4">
            <SectionHeader subtitle={text.logsSubtitle} title={copy.common.logs} />
            <div className="grid max-h-56 gap-2 overflow-auto pr-1">
              {(logsQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-ink-500">{text.noLogs}</p>
              ) : (
                (logsQuery.data ?? []).map((log) => (
                  <div
                    className="rounded-md border border-line bg-white px-3 py-2 text-xs"
                    key={log.id}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <StatusBadge status={log.level} />
                      <span className="text-ink-500">
                        #{log.seq} {formatDateTime(log.created_at, language)}
                      </span>
                    </div>
                    <p className="selectable text-ink-800">{log.message}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function StepRow({
  description,
  done,
  index,
  title,
}: {
  description: string;
  done: boolean;
  index: number;
  title: string;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-white px-3 py-3 sm:grid-cols-[40px_minmax(0,1fr)_24px] sm:items-center">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-100 text-sm font-semibold text-ink-700">
        {index}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        <div className="selectable mt-0.5 truncate text-xs text-ink-500">
          {description}
        </div>
      </div>
      {done ? (
        <CheckCircle2 className="h-5 w-5 text-ok" />
      ) : (
        <XCircle className="h-5 w-5 text-ink-300" />
      )}
    </div>
  );
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-white px-2 py-2">
      <div className="mono-tabular text-lg font-semibold text-ink-900">{value}</div>
      <div className="truncate text-xs text-ink-500">{label}</div>
    </div>
  );
}
