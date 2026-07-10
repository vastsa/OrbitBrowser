import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  FileText,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { SelectControl } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import {
  InfoRow,
  SkeletonRows,
  TablePagination,
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

const retryableRunStatuses: TaskRunStatus[] = [
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
];

function isActiveRun(status: TaskRunStatus) {
  return activeRunStatuses.includes(status);
}

function localizeSystemLog(message: string, language: string): string {
  const pairs: Array<[string, string]> = [
    [
      "Browser is ready. Starting script execution.",
      "浏览器已就绪，开始执行脚本。",
    ],
    [
      "Page title captured and artifact written.",
      "页面标题已采集，产物写入完成。",
    ],
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"logs" | "artifacts">("logs");
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const runStatus = useUiStore((state) => state.runStatus);
  const setRunStatus = useUiStore((state) => state.setRunStatus);
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);

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
    refetchInterval:
      runStatus === "running" || runStatus === "queued" ? 2500 : false,
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
      setSelectedRunIds((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      setDeleteTarget(null);
      refreshRuns();
    },
  });

  const bulkCancelMutation = useMutation({
    mutationFn: async (runIds: string[]) => {
      await Promise.all(runIds.map((runId) => browserApi.cancelRun(runId)));
    },
    onSuccess: refreshRuns,
  });

  const bulkRetryMutation = useMutation({
    mutationFn: async (runIds: string[]) => {
      await Promise.all(runIds.map((runId) => browserApi.retryRun(runId)));
    },
    onSuccess: () => {
      setSelectedRunIds(new Set());
      refreshRuns();
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: browserApi.deleteRuns,
    onSuccess: (_result, runIds) => {
      if (selectedRun && runIds.includes(selectedRun.id)) {
        setSelectedRun(null);
      }
      setSelectedRunIds((current) => {
        const next = new Set(current);
        for (const runId of runIds) {
          next.delete(runId);
        }
        return next;
      });
      setBulkDeleteOpen(false);
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

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const taskName = (id: string) =>
    tasksQuery.data?.find((task) => task.id === id)?.name ?? id;
  const environmentName = (id: string) =>
    environmentsQuery.data?.find((environment) => environment.id === id)
      ?.name ?? id;
  const runs = runsQuery.data ?? [];
  const refetchRuns = runsQuery.refetch;
  const totalPages = Math.max(1, Math.ceil(runs.length / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = safePageIndex * pageSize;
  const pagedRuns = runs.slice(pageStart, pageStart + pageSize);
  const selectedRuns = runs.filter((run) => selectedRunIds.has(run.id));
  const selectedActiveRuns = selectedRuns.filter((run) =>
    isActiveRun(run.status),
  );
  const selectedRetryableRuns = selectedRuns.filter((run) =>
    retryableRunStatuses.includes(run.status),
  );
  const selectedDeletableRuns = selectedRuns.filter(
    (run) => !isActiveRun(run.status),
  );
  const allPageSelected =
    pagedRuns.length > 0 &&
    pagedRuns.every((run) => selectedRunIds.has(run.id));
  const activeCount = runs.filter((run) => isActiveRun(run.status)).length;
  const succeededCount = runs.filter(
    (run) => run.status === "succeeded",
  ).length;
  const failedCount = runs.filter((run) =>
    ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status),
  ).length;

  useEffect(() => {
    setPageIndex(0);
  }, [environmentId, pageSize, runStatus, taskId]);

  useEffect(() => {
    if (pageIndex >= totalPages) {
      setPageIndex(totalPages - 1);
    }
  }, [pageIndex, totalPages]);

  useEffect(() => {
    const visibleRunIds = new Set(runs.map((run) => run.id));
    setSelectedRunIds((current) => {
      const next = new Set(
        [...current].filter((runId) => visibleRunIds.has(runId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [runs]);

  useEffect(() => {
    setHeaderActions(
      <>
        <div className="hidden items-center divide-x divide-line rounded-md border border-line bg-ink-50 px-1 text-xs text-ink-500 xl:flex">
          <span className="px-2.5 py-1.5">
            {text.metrics.runs}: {runs.length}
          </span>
          <span className="px-2.5 py-1.5">
            {text.metrics.active}: {activeCount}
          </span>
          <span className="px-2.5 py-1.5">
            {text.metrics.succeeded}: {succeededCount}
          </span>
          <span className="px-2.5 py-1.5">
            {text.metrics.attention}: {failedCount}
          </span>
        </div>
        <Button
          icon={<RefreshCw className="h-4 w-4" />}
          onClick={() => void refetchRuns()}
        >
          {copy.common.refresh}
        </Button>
      </>,
    );

    return () => setHeaderActions(undefined);
  }, [
    activeCount,
    copy.common.refresh,
    failedCount,
    refetchRuns,
    runs.length,
    setHeaderActions,
    succeededCount,
    text.metrics.active,
    text.metrics.attention,
    text.metrics.runs,
    text.metrics.succeeded,
  ]);

  return (
    <div className="viewport-page grid-rows-[minmax(0,1fr)]">
      <div className="h-full min-h-0 min-w-0 pr-1">
        <section className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
          <div className="panel shrink-0 overflow-hidden p-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative min-w-[240px] flex-1 md:max-w-xl">
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
                    {status === "all"
                      ? copy.common.allStatuses
                      : statusLabel(status, language)}
                  </option>
                ))}
              </SelectControl>
            </div>

            <div className="-mx-3 -mb-3 mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-ink-50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
                <span className="border-r border-line pr-3 text-xs font-medium text-ink-500">
                  {text.bulk.selected.replace(
                    "{{count}}",
                    String(selectedRuns.length),
                  )}
                </span>
                <Button
                  disabled={pagedRuns.length === 0}
                  onClick={() => {
                    setSelectedRunIds((current) => {
                      const next = new Set(current);
                      for (const run of pagedRuns) {
                        next.add(run.id);
                      }
                      return next;
                    });
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {text.bulk.selectPage}
                </Button>
                <Button
                  disabled={selectedRuns.length === 0}
                  onClick={() => setSelectedRunIds(new Set())}
                  size="sm"
                  variant="ghost"
                >
                  {text.bulk.clear}
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={
                    selectedActiveRuns.length === 0 ||
                    bulkCancelMutation.isPending
                  }
                  icon={<XCircle className="h-4 w-4" />}
                  onClick={() =>
                    bulkCancelMutation.mutate(
                      selectedActiveRuns.map((run) => run.id),
                    )
                  }
                  size="sm"
                  variant="danger"
                >
                  {text.bulk.cancel.replace(
                    "{{count}}",
                    String(selectedActiveRuns.length),
                  )}
                </Button>
                <Button
                  disabled={
                    selectedRetryableRuns.length === 0 ||
                    bulkRetryMutation.isPending
                  }
                  icon={<RotateCcw className="h-4 w-4" />}
                  onClick={() =>
                    bulkRetryMutation.mutate(
                      selectedRetryableRuns.map((run) => run.id),
                    )
                  }
                  size="sm"
                >
                  {text.bulk.retry.replace(
                    "{{count}}",
                    String(selectedRetryableRuns.length),
                  )}
                </Button>
                <Button
                  disabled={selectedDeletableRuns.length === 0}
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => {
                    bulkDeleteMutation.reset();
                    setBulkDeleteOpen(true);
                  }}
                  size="sm"
                  variant="danger"
                >
                  {text.bulk.delete.replace(
                    "{{count}}",
                    String(selectedDeletableRuns.length),
                  )}
                </Button>
              </div>
            </div>

            {bulkCancelMutation.error ||
            bulkRetryMutation.error ||
            bulkDeleteMutation.error ? (
              <div
                className="mt-3 rounded-md border border-danger/20 bg-red-50 p-2 text-xs text-danger"
                role="alert"
              >
                {errorMessage(
                  bulkCancelMutation.error ??
                    bulkRetryMutation.error ??
                    bulkDeleteMutation.error,
                )}
              </div>
            ) : null}
          </div>

          {runsQuery.isLoading ? (
            <section className="panel table-scroll min-h-0">
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
            <section className="panel table-panel">
              <div className="table-scroll run-table-scroll">
                <table className="run-table border-collapse">
                  <thead className="table-header">
                    <tr>
                      <th className="px-4 py-3">
                        <input
                          aria-label={text.bulk.selectPage}
                          checked={allPageSelected}
                          className="h-4 w-4 cursor-pointer rounded border-line text-brand-600 focus:ring-brand-500"
                          onChange={(event) => {
                            setSelectedRunIds((current) => {
                              const next = new Set(current);
                              for (const run of pagedRuns) {
                                if (event.target.checked) {
                                  next.add(run.id);
                                } else {
                                  next.delete(run.id);
                                }
                              }
                              return next;
                            });
                          }}
                          type="checkbox"
                        />
                      </th>
                      <th className="px-4 py-3">{text.table.task}</th>
                      <th className="px-4 py-3">{text.table.environment}</th>
                      <th className="px-4 py-3">{copy.common.status}</th>
                      <th className="px-4 py-3">{text.table.started}</th>
                      <th className="px-4 py-3">{text.table.duration}</th>
                      <th className="px-4 py-3">{text.table.error}</th>
                      <th className="table-action-header">
                        {copy.common.actions}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRuns.map((run) => (
                      <tr
                        aria-pressed={selectedRun?.id === run.id}
                        className={`cursor-pointer outline-none transition-colors duration-150 hover:bg-ink-50 focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                          selectedRun?.id === run.id ? "bg-brand-50" : ""
                        }`}
                        key={run.id}
                        onClick={() => setSelectedRun(run)}
                        onKeyDown={(event) => handleRunRowKeyDown(event, run)}
                        role="button"
                        tabIndex={0}
                      >
                        <td className="table-cell">
                          <input
                            aria-label={text.bulk.selectRun}
                            checked={selectedRunIds.has(run.id)}
                            className="h-4 w-4 cursor-pointer rounded border-line text-brand-600 focus:ring-brand-500"
                            onChange={() => toggleRunSelection(run.id)}
                            onClick={(event) => event.stopPropagation()}
                            type="checkbox"
                          />
                        </td>
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
                          {formatDateTime(
                            run.started_at ?? run.queued_at,
                            language,
                          )}
                        </td>
                        <td className="table-cell text-ink-700">
                          {formatDuration(run.started_at, run.finished_at)}
                        </td>
                        <td className="table-cell text-ink-700">
                          {run.error_message || "-"}
                        </td>
                        <td className="table-action-cell">
                          <div className="flex justify-end gap-1">
                            <Button
                              aria-label={copy.common.delete}
                              className="h-7 px-1.5"
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
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination
                labels={copy.common.pagination}
                onPageIndexChange={setPageIndex}
                onPageSizeChange={setPageSize}
                pageIndex={safePageIndex}
                pageSize={pageSize}
                totalCount={runs.length}
              />
            </section>
          )}
        </section>
      </div>

      <Modal
        onClose={() => setSelectedRun(null)}
        open={Boolean(selectedRun) && !deleteTarget}
        title={text.runDetails}
        widthClass="max-w-5xl"
      >
        {selectedRun ? (
          <div className="grid max-h-[72vh] min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden">
            <div className="grid gap-3 rounded-md border border-line bg-ink-50 p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink-500">
                    {text.runDetails}
                  </p>
                  <p className="selectable mt-1 break-all text-sm font-semibold text-ink-900">
                    {selectedRun.id}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
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
                  {retryableRunStatuses.includes(selectedRun.status) ? (
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
                    onClick={() =>
                      openArtifactsDirMutation.mutate(selectedRun.id)
                    }
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
              </div>

              {(cancelRunMutation.error ||
                cancelBatchMutation.error ||
                retryRunMutation.error ||
                openArtifactsDirMutation.error ||
                deleteRunMutation.error) && (
                <div
                  className="rounded-md bg-red-50 p-2 text-xs text-danger"
                  role="alert"
                >
                  {errorMessage(
                    cancelRunMutation.error ??
                      cancelBatchMutation.error ??
                      retryRunMutation.error ??
                      openArtifactsDirMutation.error ??
                      deleteRunMutation.error,
                  )}
                </div>
              )}

              <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
                <InfoRow
                  label={copy.common.status}
                  value={<StatusBadge status={selectedRun.status} />}
                />
                <InfoRow
                  label={copy.common.task}
                  value={taskName(selectedRun.task_id)}
                />
                <InfoRow
                  label={copy.common.environment}
                  value={environmentName(selectedRun.environment_id)}
                />
                <InfoRow
                  label={text.info.batch}
                  value={selectedRun.batch_id || "-"}
                />
                <InfoRow
                  label={text.info.artifacts}
                  value={selectedRun.artifacts_dir || "-"}
                />
              </div>
            </div>

            <div className="flex border-b border-line">
              <button
                className={`h-9 flex-1 cursor-pointer border-b-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                  detailTab === "logs"
                    ? "border-brand-600 text-ink-900"
                    : "border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-900"
                }`}
                onClick={() => setDetailTab("logs")}
                type="button"
              >
                {copy.common.logs} {logsQuery.data?.length ?? 0}
              </button>
              <button
                className={`h-9 flex-1 cursor-pointer border-b-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                  detailTab === "artifacts"
                    ? "border-brand-600 text-ink-900"
                    : "border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-900"
                }`}
                onClick={() => setDetailTab("artifacts")}
                type="button"
              >
                {copy.common.artifacts} {artifactsQuery.data?.length ?? 0}
              </button>
            </div>

            <div className="scroll-panel min-h-0 rounded-md border border-line px-3">
              {detailTab === "logs" ? (
                logsQuery.isError ? (
                  <div
                    className="rounded-md bg-red-50 p-3 text-sm text-danger"
                    role="alert"
                  >
                    {errorMessage(logsQuery.error)}
                  </div>
                ) : (logsQuery.data ?? []).length === 0 ? (
                  <div className="py-3 text-sm text-ink-500">{text.noLogs}</div>
                ) : (
                  <div className="divide-y divide-line">
                    {(logsQuery.data ?? []).map((log) => (
                      <div
                        className="py-3"
                        key={log.id}
                      >
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <StatusBadge status={log.level} />
                          <span className="shrink-0 text-xs text-ink-500">
                            #{log.seq}{" "}
                            {formatDateTime(log.created_at, language)}
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
                <div className="py-3 text-sm text-ink-500">{text.noArtifacts}</div>
              ) : (
                <div className="divide-y divide-line">
                  {(artifactsQuery.data ?? []).map((artifact) => (
                    <div
                      className="py-3"
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
                            onClick={() =>
                              openArtifactMutation.mutate(artifact.path)
                            }
                            variant="ghost"
                          />
                        </div>
                      </div>
                      <p className="selectable mt-1 break-all text-xs text-ink-500">
                        {artifact.path}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
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
        <p className="text-sm leading-6 text-ink-700">{text.deleteBody}</p>
        <p className="selectable mt-3 truncate rounded-md border border-line bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.id}
        </p>
        {deleteRunMutation.error ? (
          <div
            className="mt-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {errorMessage(deleteRunMutation.error)}
          </div>
        ) : null}
      </Modal>
      <Modal
        footer={
          <>
            <Button
              onClick={() => {
                bulkDeleteMutation.reset();
                setBulkDeleteOpen(false);
              }}
            >
              {copy.common.cancel}
            </Button>
            <Button
              disabled={bulkDeleteMutation.isPending}
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() =>
                bulkDeleteMutation.mutate(
                  selectedDeletableRuns.map((run) => run.id),
                )
              }
              variant="danger"
            >
              {text.bulk.confirmDelete.replace(
                "{{count}}",
                String(selectedDeletableRuns.length),
              )}
            </Button>
          </>
        }
        onClose={() => {
          bulkDeleteMutation.reset();
          setBulkDeleteOpen(false);
        }}
        open={bulkDeleteOpen}
        title={text.bulk.deleteTitle}
        widthClass="max-w-lg"
      >
        <p className="text-sm leading-6 text-ink-700">
          {text.bulk.deleteBody.replace(
            "{{count}}",
            String(selectedDeletableRuns.length),
          )}
        </p>
        {selectedRuns.length !== selectedDeletableRuns.length ? (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-warn">
            {text.bulk.activeSkipped.replace(
              "{{count}}",
              String(selectedRuns.length - selectedDeletableRuns.length),
            )}
          </p>
        ) : null}
        <div className="mt-3 max-h-40 overflow-y-auto rounded-md border border-line bg-ink-50 px-3 py-2 text-xs text-ink-700">
          {selectedDeletableRuns.map((run) => (
            <p className="selectable truncate" key={run.id}>
              {run.id}
            </p>
          ))}
        </div>
        {bulkDeleteMutation.error ? (
          <div
            className="mt-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {errorMessage(bulkDeleteMutation.error)}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
