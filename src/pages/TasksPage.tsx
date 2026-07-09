import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Play,
  Plus,
  Save,
  Server,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TextareaField, TextField } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import {
  SectionHeader,
  SkeletonRows,
} from "@/components/PageScaffold";
import { StatusBadge } from "@/components/StatusBadge";
import { copy as i18nCopy, useI18n } from "@/i18n";
import { errorMessage, formatDateTime, statusLabel } from "@/lib/format";
import { browserApi } from "@/lib/tauri";
import { useUiStore } from "@/stores/uiStore";
import type {
  AutomationTask,
  AutomationTaskDraft,
  Environment,
  RunBatch,
  RunOptions,
} from "@/types/domain";

type TaskCopy = (typeof i18nCopy)[keyof typeof i18nCopy]["tasks"];

function createScriptTemplates(text: TaskCopy) {
  return [
    {
      name: text.templates.screenshot,
      script: `await page.goto("https://example.com", { waitUntil: "load", timeout: 30000 });\nawait page.screenshot("home");\nlog.info("${text.templateLogs.screenshotSaved}");`,
    },
    {
      name: text.templates.title,
      script: `await page.goto("https://example.com");\nconst title = await page.title();\nlog.info(\`${text.templateLogs.pageTitle}: \${title}\`);\nawait run.outputJson("title", { title });`,
    },
    {
      name: text.templates.wait,
      script: `await page.goto("https://example.com");\nawait page.wait("h1", { timeout: 10000 });\nlog.info("${text.templateLogs.elementVisible}");`,
    },
    {
      name: text.templates.form,
      script: `await page.goto("https://example.com/form");\nawait page.type("#email", env.email);\nawait page.click("button[type=submit]");\nawait page.screenshot("submitted");`,
    },
    {
      name: text.templates.batch,
      script: `const urls = ["https://example.com", "https://example.org"];\nfor (const url of urls) {\n  await page.goto(url);\n  log.info(await page.title());\n}`,
    },
    {
      name: text.templates.loginState,
      script: `await page.goto("https://example.com", { waitUntil: "load" });\nconst state = await page.evaluate(() => {\n  const text = document.body?.innerText?.toLowerCase() ?? "";\n  return {\n    url: location.href,\n    title: document.title,\n    hasLoginText: /sign in|log in|login|登录/.test(text),\n    hasLogoutText: /sign out|log out|logout|退出/.test(text),\n  };\n});\nlog.info("${text.templateLogs.loginStateChecked}");\nawait run.outputJson("login-state", state);`,
    },
  ];
}

function createDefaultTask(script: string): AutomationTaskDraft {
  return {
    name: "",
    description: "",
    script,
    timeout_sec: 60,
    api_version: "v1",
    permissions: {
      screenshots: true,
      external_urls: ["<all_urls>"],
      clipboard: true,
    },
  };
}

const defaultTask = createDefaultTask(
  createScriptTemplates(i18nCopy["zh-CN"].tasks)[0].script,
);

const defaultRunOptions: RunOptions = {
  auto_start_browser: true,
  close_browser_after_run: false,
  max_concurrency: 2,
  stop_on_first_error: false,
};

function toDraft(
  task?: AutomationTask,
  defaultScript = defaultTask.script,
): AutomationTaskDraft {
  if (!task) {
    return createDefaultTask(defaultScript);
  }

  return {
    id: task.id,
    name: task.name,
    description: task.description ?? "",
    script: task.script,
    timeout_sec: task.timeout_sec,
    api_version: task.api_version,
    permissions: task.permissions ?? {
      screenshots: true,
      external_urls: ["<all_urls>"],
      clipboard: true,
    },
  };
}

export function TasksPage() {
  const navigate = useNavigate();
  const { copy, language } = useI18n();
  const text = copy.tasks;

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const tasks = tasksQuery.data ?? [];
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);

  useEffect(() => {
    setHeaderActions(
      <Button
        icon={<Plus className="h-4 w-4" />}
        onClick={() => navigate("/tasks/new")}
        variant="primary"
      >
        {text.newTask}
      </Button>,
    );

    return () => setHeaderActions(undefined);
  }, [navigate, setHeaderActions, text.newTask]);

  return (
    <div className="viewport-page grid-rows-[minmax(0,1fr)]">
      <section className="panel scroll-panel min-h-0 overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-semibold text-ink-900">{text.taskList}</h2>
          <span className="rounded-full bg-ink-100 px-2 py-1 text-xs font-medium text-ink-500">
            {tasks.length}
            {text.countUnit ? ` ${text.countUnit}` : ""}
          </span>
        </div>

        <div className="scroll-panel p-3">
          {tasksQuery.isLoading ? (
            <SkeletonRows rows={8} />
          ) : tasksQuery.isError ? (
            <div className="rounded-md bg-red-50 p-3 text-sm text-danger">
              {errorMessage(tasksQuery.error)}
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              action={
                <Button
                  icon={<Plus className="h-4 w-4" />}
                  onClick={() => navigate("/tasks/new")}
                  variant="primary"
                >
                  {text.newTask}
                </Button>
              }
              description={text.emptyDescription}
              icon={<ClipboardList className="h-5 w-5" />}
              title={text.emptyTitle}
            />
          ) : (
            <div className="grid gap-2">
              {tasks.map((task) => (
                <button
                  className="grid cursor-pointer gap-3 rounded-lg border border-line bg-white px-4 py-3 text-left transition-colors duration-200 hover:border-brand-500 hover:bg-brand-50 sm:grid-cols-[minmax(0,1fr)_180px_120px]"
                  key={task.id}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <ClipboardList className="h-4 w-4 shrink-0 text-ink-500" />
                      <span className="truncate text-sm font-medium text-ink-900">
                        {task.name}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-xs leading-5 text-ink-500">
                      {task.description || copy.common.noDescription}
                    </span>
                  </span>
                  <span className="grid content-center gap-1 text-xs text-ink-500">
                    <span>
                      {text.timeout}: {task.timeout_sec} {text.seconds}
                    </span>
                    <span>
                      {text.scriptLines}: {task.script.split("\n").length}
                    </span>
                  </span>
                  <span className="flex items-center justify-start sm:justify-end">
                    <span className="rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-600">
                      {task.updated_at || task.created_at
                        ? formatDateTime(
                            task.updated_at ?? task.created_at,
                            language,
                          )
                        : text.openTask}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { copy, format, language } = useI18n();
  const text = copy.tasks;
  const scriptTemplates = useMemo(() => createScriptTemplates(text), [text]);
  const defaultScript = scriptTemplates[0].script;
  const isNewTask = !taskId || taskId === "new";
  const [loadedTaskKey, setLoadedTaskKey] = useState("");
  const [draft, setDraft] = useState<AutomationTaskDraft>(() =>
    toDraft(undefined, defaultScript),
  );
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<string[]>(
    [],
  );
  const [runOptions, setRunOptions] = useState<RunOptions>(defaultRunOptions);
  const [deleteTarget, setDeleteTarget] = useState<AutomationTaskDraft | null>(
    null,
  );
  const [lastRunBatch, setLastRunBatch] = useState<RunBatch | null>(null);
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: browserApi.listEnvironments,
  });

  const recentRunsQuery = useQuery({
    enabled: Boolean(draft.id),
    queryKey: ["runs", "task", draft.id],
    queryFn: () =>
      browserApi.listRuns({
        task_id: draft.id,
        status: "all",
      }),
  });

  const saveMutation = useMutation({
    mutationFn: browserApi.saveTask,
    onSuccess: (task) => {
      setDraft(toDraft(task, defaultScript));
      setLoadedTaskKey(task.id);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/tasks/${task.id}`, { replace: isNewTask });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: browserApi.deleteTask,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      navigate("/tasks");
    },
  });

  const validateMutation = useMutation({
    mutationFn: browserApi.validateTaskScript,
  });

  const runMutation = useMutation({
    mutationFn: () =>
      browserApi.runTask(draft.id ?? "", selectedEnvironmentIds, runOptions),
    onSuccess: (batch) => {
      setLastRunBatch(batch);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["run-logs"] });
    },
  });

  const tasks = tasksQuery.data ?? [];
  const environments = environmentsQuery.data ?? [];
  const selectedEnvironments = useMemo(
    () =>
      environments.filter((environment) =>
        selectedEnvironmentIds.includes(environment.id),
      ),
    [environments, selectedEnvironmentIds],
  );
  const canRun = Boolean(draft.id) && selectedEnvironmentIds.length > 0;
  const taskMissing =
    !isNewTask &&
    !tasksQuery.isLoading &&
    Boolean(taskId) &&
    !tasks.some((task) => task.id === taskId);

  const updateDraft = <TKey extends keyof AutomationTaskDraft>(
    key: TKey,
    value: AutomationTaskDraft[TKey],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    setLoadedTaskKey("");
    setLastRunBatch(null);
  }, [taskId]);

  useEffect(() => {
    if (isNewTask) {
      if (loadedTaskKey !== "new") {
        setDraft(toDraft(undefined, defaultScript));
        setLoadedTaskKey("new");
      }
      return;
    }

    const currentTask = tasks.find((task) => task.id === taskId);
    if (currentTask && loadedTaskKey !== currentTask.id) {
      setDraft(toDraft(currentTask, defaultScript));
      setLoadedTaskKey(currentTask.id);
    }
  }, [defaultScript, isNewTask, loadedTaskKey, taskId, tasks]);

  useEffect(() => {
    if (taskMissing) {
      setHeaderActions(
        <Button
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate("/tasks")}
        >
          {text.backToList}
        </Button>,
      );
      return () => setHeaderActions(undefined);
    }

    setHeaderActions(
      <>
        <Button
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate("/tasks")}
        >
          {text.backToList}
        </Button>
        <Button
          disabled={!draft.script.trim() || validateMutation.isPending}
          icon={<CheckCircle2 className="h-4 w-4" />}
          onClick={() => validateMutation.mutate(draft.script)}
        >
          {text.validate}
        </Button>
        <Button
          disabled={saveMutation.isPending || !draft.name.trim()}
          icon={<Save className="h-4 w-4" />}
          onClick={() => saveMutation.mutate(draft)}
          variant="primary"
        >
          {text.saveTask}
        </Button>
        {draft.id ? (
          <Button
            disabled={deleteMutation.isPending}
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => setDeleteTarget(draft)}
            variant="danger"
          >
            {copy.common.delete}
          </Button>
        ) : null}
      </>,
    );

    return () => setHeaderActions(undefined);
  }, [
    copy.common.delete,
    deleteMutation.isPending,
    draft,
    navigate,
    saveMutation.isPending,
    setHeaderActions,
    taskMissing,
    text.backToList,
    text.saveTask,
    text.validate,
    validateMutation.isPending,
  ]);

  if (taskMissing) {
    return (
      <div className="viewport-page grid-rows-[minmax(0,1fr)]">
        <div className="scroll-panel">
          <EmptyState
            action={
              <Button onClick={() => navigate("/tasks")} variant="primary">
                {text.backToList}
              </Button>
            }
            description={text.taskNotFoundDescription}
            icon={<ClipboardList className="h-5 w-5" />}
            title={text.taskNotFoundTitle}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="viewport-page grid-rows-[minmax(0,1fr)]">
      <div className="scroll-panel grid min-h-0 min-w-0 content-start gap-4 pr-1 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start xl:pr-0">
        <div className="grid min-w-0 content-start gap-4">
          <section className="panel p-4">
            <SectionHeader
              title={draft.id ? text.editTitle : text.newTitle}
            />

            {(saveMutation.error ||
              deleteMutation.error ||
              validateMutation.error ||
              runMutation.error) && (
              <div className="mb-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
                {errorMessage(
                  saveMutation.error ??
                    deleteMutation.error ??
                    validateMutation.error ??
                    runMutation.error,
                )}
              </div>
            )}

            {validateMutation.data ? (
              <div
                className={`mb-3 rounded-md border px-3 py-2 text-sm ${
                  validateMutation.data.valid
                    ? "border-ok/20 bg-green-50 text-ok"
                    : "border-danger/20 bg-red-50 text-danger"
                }`}
              >
                {validateMutation.data.valid
                  ? text.validationPassed
                  : validateMutation.data.errors.join(text.validationJoiner)}
              </div>
            ) : null}

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
              <TextField
                label={text.taskName}
                onChange={(event) => updateDraft("name", event.target.value)}
                requiredMark
                value={draft.name}
              />
              <TextField
                label={text.timeout}
                min={5}
                onChange={(event) =>
                  updateDraft("timeout_sec", Number(event.target.value) || 60)
                }
                type="number"
                value={draft.timeout_sec}
              />
            </div>
            <div className="mt-3">
              <TextareaField
                label={text.description}
                onChange={(event) =>
                  updateDraft("description", event.target.value)
                }
                value={draft.description ?? ""}
              />
            </div>
          </section>

          <section className="panel flex min-w-0 flex-col overflow-hidden p-4">
            <SectionHeader
              actions={
                <div className="flex flex-wrap gap-2">
                  {scriptTemplates.map((template) => (
                    <Button
                      key={template.name}
                      onClick={() => updateDraft("script", template.script)}
                      size="sm"
                      variant="ghost"
                    >
                      {template.name}
                    </Button>
                  ))}
                </div>
              }
              title={text.scriptEditor}
            />
            <textarea
              className="control-focus h-[52vh] min-h-80 w-full max-w-full resize-none overflow-auto rounded-xl border border-ink-800 bg-ink-900 p-4 text-sm leading-6 text-ink-50 shadow-inner"
              data-code-editor="true"
              onChange={(event) => updateDraft("script", event.target.value)}
              spellCheck={false}
              value={draft.script}
            />
          </section>

        </div>

        <aside className="grid min-w-0 content-start gap-4">
          <section className="panel flex min-w-0 flex-col overflow-hidden p-4">
            <SectionHeader
              actions={
                <Button
                  disabled={!canRun || runMutation.isPending}
                  icon={<Play className="h-4 w-4" />}
                  onClick={() => runMutation.mutate()}
                  variant="primary"
                >
                  {copy.common.run}
                </Button>
              }
              subtitle={format(text.selectedEnvironments, {
                selected: selectedEnvironmentIds.length,
                total: environments.length,
              })}
              title={text.runTargets}
            />
            <div className="grid max-h-64 gap-2 overflow-auto pr-1">
              {lastRunBatch ? (
                <div className="rounded-xl border border-ok/20 bg-green-50 px-3 py-2 text-sm text-ok">
                  {format(text.batchCreated, {
                    id: lastRunBatch.id,
                    total: lastRunBatch.total_count,
                  })}
                </div>
              ) : null}
              {environments.map((environment: Environment) => (
                <label
                  className="flex cursor-pointer items-center justify-between rounded-md border border-line px-3 py-2 text-sm transition-colors duration-200 hover:border-brand-500 hover:bg-brand-50"
                  key={environment.id}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink-900">
                      {environment.name}
                    </span>
                    <span className="block truncate text-xs text-ink-500">
                      {environment.group_id || copy.common.defaultGroup}
                    </span>
                  </span>
                  <input
                    checked={selectedEnvironmentIds.includes(environment.id)}
                    className="h-4 w-4 shrink-0"
                    onChange={(event) => {
                      setSelectedEnvironmentIds((current) =>
                        event.target.checked
                          ? [...current, environment.id]
                          : current.filter((id) => id !== environment.id),
                      );
                    }}
                    type="checkbox"
                  />
                </label>
              ))}
              {environments.length === 0 ? (
                <EmptyState
                  description={text.noRunnableDescription}
                  icon={<Server className="h-5 w-5" />}
                  title={text.noRunnableTitle}
                />
              ) : null}
            </div>
            <div className="mt-4 grid shrink-0 gap-3">
              <TextField
                label={text.maxConcurrency}
                min={1}
                onChange={(event) =>
                  setRunOptions((current) => ({
                    ...current,
                    max_concurrency: Number(event.target.value) || 1,
                  }))
                }
                type="number"
                value={runOptions.max_concurrency}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                <input
                  checked={runOptions.stop_on_first_error}
                  className="h-4 w-4"
                  onChange={(event) =>
                    setRunOptions((current) => ({
                      ...current,
                      stop_on_first_error: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                {text.stopOnFirstError}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                <input
                  checked={runOptions.auto_start_browser}
                  className="h-4 w-4"
                  onChange={(event) =>
                    setRunOptions((current) => ({
                      ...current,
                      auto_start_browser: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                {text.autoStartBrowser}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
                <input
                  checked={runOptions.close_browser_after_run}
                  className="h-4 w-4"
                  onChange={(event) =>
                    setRunOptions((current) => ({
                      ...current,
                      close_browser_after_run: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                {text.closeAfterRun}
              </label>
            </div>
          </section>

          <section className="panel flex min-w-0 flex-col overflow-hidden p-4">
            <SectionHeader title={text.recentRuns} />
            <div className="grid max-h-72 gap-2 overflow-auto pr-1">
              {selectedEnvironments.length > 0 ? (
                <div className="rounded-md border border-ok/20 bg-green-50 px-3 py-2 text-xs text-ok">
                  {format(text.selectedCount, {
                    count: selectedEnvironments.length,
                  })}
                </div>
              ) : null}
              {(recentRunsQuery.data ?? []).slice(0, 6).map((run) => (
                <div className="rounded-md border border-line px-3 py-2" key={run.id}>
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={run.status} />
                    <span className="text-xs text-ink-500">
                      {formatDateTime(run.started_at ?? run.queued_at, language)}
                    </span>
                  </div>
                  <p className="mt-2 truncate text-xs text-ink-500">
                    {statusLabel(run.status, language)}
                    {run.error_message ? ` / ${run.error_message}` : ""}
                  </p>
                </div>
              ))}
              {draft.id && recentRunsQuery.data?.length === 0 ? (
                <div className="text-sm text-ink-500">{text.noRunHistory}</div>
              ) : null}
              {!draft.id ? (
                <div className="rounded-md border border-dashed border-ink-300 px-3 py-6 text-center text-sm text-ink-500">
                  {text.saveToShowHistory}
                </div>
              ) : null}
            </div>
          </section>

        </aside>
      </div>

      <Modal
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>
              {copy.common.cancel}
            </Button>
            <Button
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget?.id) {
                  deleteMutation.mutate(deleteTarget.id, {
                    onSuccess: () => setDeleteTarget(null),
                  });
                }
              }}
              variant="danger"
            >
              {text.deleteTask}
            </Button>
          </>
        }
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        widthClass="max-w-md"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm leading-6 text-ink-700">{text.deleteBody}</p>
        <p className="mt-3 truncate rounded-xl bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.name}
        </p>
      </Modal>
    </div>
  );
}
