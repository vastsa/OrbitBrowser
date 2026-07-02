import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Search,
  TimerReset,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { SelectControl } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import {
  InfoRow,
  MetricTile,
  PageHeader,
  SectionHeader,
  SkeletonRows,
} from "@/components/PageScaffold";
import { StatusBadge } from "@/components/StatusBadge";
import { useI18n } from "@/i18n";
import {
  errorMessage,
  formatDateTime,
  formatDuration,
  statusLabel,
} from "@/lib/format";
import { browserApi } from "@/lib/tauri";
import { useUiStore } from "@/stores/uiStore";
import type { RunFilters, TaskRun, TaskRunStatus } from "@/types/domain";

const runStatuses: Array<TaskRunStatus | "all"> = [
  "all",
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
];

const activeRunStatuses: TaskRunStatus[] = [
  "queued",
  "starting",
  "running",
  "cancel_requested",
];

function isActiveRun(status: TaskRunStatus) {
  return activeRunStatuses.includes(status);
}

function localizeSystemLog(message: string, language: string): string {
  const pairs: Array<[string, string]> = [
    ["Browser is ready. Starting script execution.", "浏览器已就绪，开始执行脚本。"],
    ["Page title captured and artifact written.", "页面标题已采集，产物写入完成。"],
    ["Task execution timed out", "任务执行超时"],
  ];

  for (const [en, zh] of pairs) {
    if (message === en || message === zh) {
      return language === "en-US" ? en : zh;
    }
  }

  const prefixes: Array<[string, string]> = [
    ["Starting task: ", "开始执行任务："],
    ["Task completed: ", "任务完成："],
    ["Opening page: ", "打开页面："],
    ["Clicked element: ", "点击元素："],
    ["Typed text into: ", "输入文本："],
    ["Screenshot saved: ", "截图已保存："],
  ];

  for (const [enPrefix, zhPrefix] of prefixes) {
    if (message.startsWith(enPrefix)) {
      return `${language === "en-US" ? enPrefix : zhPrefix}${message.slice(enPrefix.length)}`;
    }
    if (message.startsWith(zhPrefix)) {
      return `${language === "en-US" ? enPrefix : zhPrefix}${message.slice(zhPrefix.length)}`;
    }
  }

  return message;
}

export function RunsPage() {
  const queryClient = useQueryClient();
  const { copy, language } = useI18n();
  const text = copy.runs;
  const [taskId, setTaskId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [selectedRun, setSelectedRun] = useState<TaskRun | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRun | null>(null);
  const [detailTab, setDetailTab] = useState<"logs" | "artifacts">("logs");
  const runStatus = useUiStore((state) => state.runStatus);
  const setRunStatus = useUiStore((state) => state.setRunStatus);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: browserApi.listEnvironments,
  });

  const filters = useMemo<RunFilters>(
    () => ({
      task_id: taskId || undefined,
      environment_id: environmentId || undefined,
      status: runStatus,
    }),
    [environmentId, runStatus, taskId],
  );

  const runsQuery = useQuery({
    queryKey: ["runs", filters],
    queryFn: () => browserApi.listRuns(filters),
    refetchInterval: runStatus === "running" || runStatus === "queued" ? 2500 : false,
  });

  const logsQuery = useQuery({
    enabled: Boolean(selectedRun),
    queryKey: ["run-logs", selectedRun?.id],
    queryFn: () => browserApi.getRunLogs(selectedRun?.id ?? ""),
    refetchInterval: selectedRun?.status === "running" ? 2000 : false,
  });

  const artifactsQuery = useQuery({
    enabled: Boolean(selectedRun),
    queryKey: ["run-artifacts", selectedRun?.id],
    queryFn: () => browserApi.listRunArtifacts(selectedRun?.id ?? ""),
  });

  const refreshRuns = () => {
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["run-logs"] });
    void queryClient.invalidateQueries({ queryKey: ["run-artifacts"] });
  };

  const cancelRunMutation = useMutation({
    mutationFn: browserApi.cancelRun,
    onSuccess: refreshRuns,
  });

  const cancelBatchMutation = useMutation({
    mutationFn: browserApi.cancelBatch,
    onSuccess: refreshRuns,
  });

  const retryRunMutation = useMutation({
    mutationFn: browserApi.retryRun,
    onSuccess: refreshRuns,
  });

  const deleteRunMutation = useMutation({
    mutationFn: browserApi.deleteRun,
    onSuccess: (_result, runId) => {
      if (selectedRun?.id === runId) {
        setSelectedRun(null);
      }
      setDeleteTarget(null);
      refreshRuns();
    },
  });

  const openArtifactsDirMutation = useMutation({
    mutationFn: browserApi.openRunArtifactsDir,
  });

  const openArtifactMutation = useMutation({
    mutationFn: browserApi.openRunArtifact,
  });

  const handleRunRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    run: TaskRun,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    setSelectedRun(run);
  };

  const taskName = (id: string) =>
    tasksQuery.data?.find((task) => task.id === id)?.name ?? id;
  const environmentName = (id: string) =>
    environmentsQuery.data?.find((environment) => environment.id === id)?.name ??
    id;
  const runs = runsQuery.data ?? [];
  const activeCount = runs.filter((run) => isActiveRun(run.status)).length;
  const succeededCount = runs.filter((run) => run.status === "succeeded").length;
  const failedCount = runs.filter((run) =>
    ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status),
  ).length;

  return (
    <div className="viewport-page grid-rows-[auto_minmax(0,1fr)]">
      <PageHeader
        actions={
          <Button
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void runsQuery.refetch()}
          >
            {copy.common.refresh}
          </Button>
        }
        eyebrow={text.eyebrow}
        metrics={
          <>
            <MetricTile
              icon={<Activity className="h-5 w-5" />}
              label={text.metrics.runs}
              tone="blue"
              value={String(runs.length)}
            />
            <MetricTile
              icon={<TimerReset className="h-5 w-5" />}
              label={text.metrics.active}
              tone={activeCount > 0 ? "green" : "slate"}
              value={String(activeCount)}
            />
            <MetricTile
              icon={<CheckCircle2 className="h-5 w-5" />}
              label={text.metrics.succeeded}
              tone="green"
              value={String(succeededCount)}
            />
            <MetricTile
              icon={<XCircle className="h-5 w-5" />}
              label={text.metrics.attention}
              tone={failedCount > 0 ? "amber" : "slate"}
              value={String(failedCount)}
            />
          </>
        }
        subtitle={text.subtitle}
        title={text.pageTitle}
      />

      <div className="scroll-panel grid min-h-0 min-w-0 gap-3 pr-1 xl:grid-cols-[minmax(0,1fr)_390px] xl:overflow-hidden xl:pr-0">
      <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="panel shrink-0 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <SelectControl
                leadingIcon={<Search className="h-4 w-4" />}
                onChange={(event) => setTaskId(event.target.value)}
                value={taskId}
              >
                <option value="">{copy.common.allTasks}</option>
                {(tasksQuery.data ?? []).map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.name}
                  </option>
                ))}
              </SelectControl>
            </div>
            <SelectControl
              wrapperClassName="w-full sm:w-44"
              onChange={(event) => setEnvironmentId(event.target.value)}
              value={environmentId}
            >
              <option value="">{copy.common.allEnvironments}</option>
              {(environmentsQuery.data ?? []).map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </SelectControl>
            <SelectControl
              wrapperClassName="w-full sm:w-40"
              onChange={(event) =>
                setRunStatus(event.target.value as TaskRunStatus | "all")
              }
              value={runStatus}
            >
              {runStatuses.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? copy.common.allStatuses : statusLabel(status, language)}
                </option>
              ))}
            </SelectControl>
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void runsQuery.refetch()}
            >
              {copy.common.refresh}
            </Button>
          </div>
        </div>

        {runsQuery.isLoading ? (
          <section className="panel table-scroll">
            <SkeletonRows rows={8} />
          </section>
        ) : runsQuery.isError ? (
          <EmptyState
            description={errorMessage(runsQuery.error)}
            icon={<FileText className="h-5 w-5" />}
            title={text.loadFailed}
          />
        ) : runs.length === 0 ? (
          <EmptyState
            description={text.emptyDescription}
            icon={<FileText className="h-5 w-5" />}
            title={text.emptyTitle}
          />
        ) : (
          <section className="panel table-scroll">
            <table className="w-full border-collapse">
              <thead className="table-header">
                <tr>
                  <th className="px-4 py-3">{text.table.task}</th>
                  <th className="px-4 py-3">{text.table.environment}</th>
                  <th className="px-4 py-3">{copy.common.status}</th>
                  <th className="px-4 py-3">{text.table.started}</th>
                  <th className="px-4 py-3">{text.table.duration}</th>
                  <th className="px-4 py-3">{text.table.error}</th>
                  <th className="table-action-header">{copy.common.actions}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    aria-pressed={selectedRun?.id === run.id}
                    className={`cursor-pointer outline-none transition-colors duration-150 hover:bg-ink-50 focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                      selectedRun?.id === run.id ? "bg-blue-50" : ""
                    }`}
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    onKeyDown={(event) => handleRunRowKeyDown(event, run)}
                    role="button"
                    tabIndex={0}
                  >
                    <td className="table-cell font-medium text-ink-900">
                      {taskName(run.task_id)}
                    </td>
                    <td className="table-cell text-ink-700">
                      {environmentName(run.environment_id)}
                    </td>
                    <td className="table-cell">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="table-cell text-ink-700">
                      {formatDateTime(run.started_at ?? run.queued_at, language)}
                    </td>
                    <td className="table-cell text-ink-700">
                      {formatDuration(run.started_at, run.finished_at)}
                    </td>
                    <td className="table-cell max-w-xs truncate text-ink-700">
                      {run.error_message || "-"}
                    </td>
                    <td className="table-action-cell">
                      <div className="flex justify-end gap-2">
                        <Button
                          className="h-8"
                          icon={<FileText className="h-4 w-4" />}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedRun(run);
                          }}
                          variant="ghost"
                        >
                          {copy.common.details}
                        </Button>
                        <Button
                          className="h-8"
                          disabled={isActiveRun(run.status)}
                          icon={<Trash2 className="h-4 w-4" />}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteRunMutation.reset();
                            setDeleteTarget(run);
                          }}
                          title={
                            isActiveRun(run.status)
                              ? text.cancelFirst
                              : text.deleteRun
                          }
                          variant="ghost"
                        >
                          {copy.common.delete}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </section>

      <aside className="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">{text.runDetails}</h2>
          <p className="selectable mt-1 truncate text-xs text-ink-500">
            {selectedRun ? selectedRun.id : text.noRunSelected}
          </p>
        </div>

        {selectedRun ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-line p-3 text-sm">
              <div className="mb-2 flex flex-wrap gap-2">
                {isActiveRun(selectedRun.status) ? (
                  <Button
                    className="h-8"
                    disabled={cancelRunMutation.isPending}
                    icon={<XCircle className="h-4 w-4" />}
                    onClick={() => cancelRunMutation.mutate(selectedRun.id)}
                    variant="danger"
                  >
                    {copy.common.cancel}
                  </Button>
                ) : null}
                {selectedRun.batch_id && isActiveRun(selectedRun.status) ? (
                  <Button
                    className="h-8"
                    disabled={cancelBatchMutation.isPending}
                    icon={<XCircle className="h-4 w-4" />}
                    onClick={() =>
                      cancelBatchMutation.mutate(selectedRun.batch_id ?? "")
                    }
                    variant="danger"
                  >
                    {text.cancelBatch}
                  </Button>
                ) : null}
                {["failed", "timed_out", "interrupted", "cancelled"].includes(
                  selectedRun.status,
                ) ? (
                  <Button
                    className="h-8"
                    disabled={retryRunMutation.isPending}
                    icon={<RotateCcw className="h-4 w-4" />}
                    onClick={() => retryRunMutation.mutate(selectedRun.id)}
                  >
                    {copy.common.retry}
                  </Button>
                ) : null}
                <Button
                  className="h-8"
                  disabled={openArtifactsDirMutation.isPending}
                  icon={<FolderOpen className="h-4 w-4" />}
                  onClick={() => openArtifactsDirMutation.mutate(selectedRun.id)}
                >
                  {text.artifactFolder}
                </Button>
                <Button
                  className="h-8"
                  disabled={isActiveRun(selectedRun.status)}
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => {
                    deleteRunMutation.reset();
                    setDeleteTarget(selectedRun);
                  }}
                  title={
                    isActiveRun(selectedRun.status)
                      ? text.cancelFirst
                      : text.deleteRun
                  }
                  variant="danger"
                >
                  {copy.common.delete}
                </Button>
              </div>
              {(cancelRunMutation.error ||
                cancelBatchMutation.error ||
                retryRunMutation.error ||
                openArtifactsDirMutation.error ||
                deleteRunMutation.error) && (
                <div className="rounded-md bg-red-50 p-2 text-xs text-danger">
                  {errorMessage(
                    cancelRunMutation.error ??
                      cancelBatchMutation.error ??
                      retryRunMutation.error ??
                      openArtifactsDirMutation.error ??
                      deleteRunMutation.error,
                  )}
                </div>
              )}
              <InfoRow label={copy.common.status} value={<StatusBadge status={selectedRun.status} />} />
              <InfoRow label={copy.common.task} value={taskName(selectedRun.task_id)} />
              <InfoRow
                label={copy.common.environment}
                value={environmentName(selectedRun.environment_id)}
              />
              <InfoRow label={text.info.batch} value={selectedRun.batch_id || "-"} />
              <InfoRow label={text.info.artifacts} value={selectedRun.artifacts_dir || "-"} />
            </div>

            <div className="shrink-0 border-b border-line px-3 py-2">
              <div className="grid grid-cols-2 rounded-lg border border-line bg-ink-50 p-1">
                <button
                  className={`h-8 cursor-pointer rounded-md text-sm font-medium transition-colors duration-200 ${
                    detailTab === "logs"
                      ? "bg-white text-ink-900 shadow-panel"
                      : "text-ink-500 hover:text-ink-900"
                  }`}
                  onClick={() => setDetailTab("logs")}
                  type="button"
                >
                  {copy.common.logs} {logsQuery.data?.length ?? 0}
                </button>
                <button
                  className={`h-8 cursor-pointer rounded-md text-sm font-medium transition-colors duration-200 ${
                    detailTab === "artifacts"
                      ? "bg-white text-ink-900 shadow-panel"
                      : "text-ink-500 hover:text-ink-900"
                  }`}
                  onClick={() => setDetailTab("artifacts")}
                  type="button"
                >
                  {copy.common.artifacts} {artifactsQuery.data?.length ?? 0}
                </button>
              </div>
            </div>

            <div className="scroll-panel flex-1 p-3">
              {detailTab === "logs" ? (
                logsQuery.isError ? (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-danger">
                    {errorMessage(logsQuery.error)}
                  </div>
                ) : (logsQuery.data ?? []).length === 0 ? (
                  <div className="text-sm text-ink-500">{text.noLogs}</div>
                ) : (
                  <div className="grid gap-2">
                    {(logsQuery.data ?? []).map((log) => (
                      <div
                        className="rounded-md border border-line bg-ink-50 p-2.5"
                        key={log.id}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <StatusBadge status={log.level} />
                          <span className="text-xs text-ink-500">
                            #{log.seq} {formatDateTime(log.created_at, language)}
                          </span>
                        </div>
                        <p className="selectable whitespace-pre-wrap text-sm text-ink-900">
                          {localizeSystemLog(log.message, language)}
                        </p>
                      </div>
                    ))}
                  </div>
                )
              ) : (artifactsQuery.data ?? []).length === 0 ? (
                <div className="text-sm text-ink-500">{text.noArtifacts}</div>
              ) : (
                <div className="grid gap-2">
                  {(artifactsQuery.data ?? []).map((artifact) => (
                    <div
                      className="rounded-md border border-line px-3 py-2"
                      key={artifact.id}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="selectable font-medium text-ink-900">
                          {artifact.label}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-ink-500">
                            {artifact.kind}
                          </span>
                          <Button
                            aria-label={text.openArtifact}
                            className="h-7 px-2"
                            disabled={openArtifactMutation.isPending}
                            icon={<ExternalLink className="h-3.5 w-3.5" />}
                            onClick={() => openArtifactMutation.mutate(artifact.path)}
                            variant="ghost"
                          />
                        </div>
                      </div>
                      <p className="selectable mt-1 truncate text-xs text-ink-500">
                        {artifact.path}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            description={text.emptyDetailDescription}
            icon={<FileText className="h-5 w-5" />}
            title={text.emptyDetailTitle}
          />
        )}
      </aside>
      </div>
      <Modal
        footer={
          <>
            <Button
              onClick={() => {
                deleteRunMutation.reset();
                setDeleteTarget(null);
              }}
            >
              {copy.common.cancel}
            </Button>
            <Button
              disabled={deleteRunMutation.isPending}
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                if (deleteTarget) {
                  deleteRunMutation.mutate(deleteTarget.id);
                }
              }}
              variant="danger"
            >
              {text.deleteButton}
            </Button>
          </>
        }
        onClose={() => {
          deleteRunMutation.reset();
          setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        widthClass="max-w-lg"
      >
        <p className="text-sm leading-6 text-ink-700">
          {text.deleteBody}
        </p>
        <p className="selectable mt-3 truncate rounded-xl bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.id}
        </p>
        {deleteRunMutation.error ? (
          <div className="mt-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
            {errorMessage(deleteRunMutation.error)}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
