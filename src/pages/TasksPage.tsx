import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ClipboardList,
  Edit2,
  History,
  Play,
  Plus,
  Save,
  Search,
  Server,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/Button";
import { CodeEditor } from "@/components/CodeEditor";
import { EmptyState } from "@/components/EmptyState";
import { TextField } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import {
  SkeletonRows,
  TablePagination,
} from "@/components/PageScaffold";
import {
  COLLAPSED_SIDE_PANEL_HEIGHT,
  MIN_SIDE_PANEL_HEIGHT,
  ResizableSidePanel,
  clampSidePanelHeight,
} from "@/components/ResizableSidePanel";
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
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const tasks = tasksQuery.data ?? [];
  const normalizedSearch = search.trim().toLowerCase();
  const filteredTasks = useMemo(() => {
    if (!normalizedSearch) {
      return tasks;
    }

    return tasks.filter((task) =>
      [task.name, task.description ?? "", task.script, task.api_version]
        .join("\n")
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [normalizedSearch, tasks]);
  const totalPages = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = safePageIndex * pageSize;
  const pagedTasks = filteredTasks.slice(pageStart, pageStart + pageSize);
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);

  const openTask = (taskId: string) => navigate(`/tasks/${taskId}`);

  useEffect(() => {
    setPageIndex(0);
  }, [normalizedSearch, pageSize]);

  useEffect(() => {
    if (pageIndex >= totalPages) {
      setPageIndex(totalPages - 1);
    }
  }, [pageIndex, totalPages]);

  useEffect(() => {
    setHeaderActions(
      <>
        <div className="hidden items-center rounded-md border border-line bg-ink-50 px-3 py-1.5 text-xs font-medium text-ink-500 sm:flex">
          {tasks.length}
          {text.countUnit ? ` ${text.countUnit}` : ""}
        </div>
        <Button
          icon={<Plus className="h-4 w-4" />}
          onClick={() => navigate("/tasks/new")}
          variant="primary"
        >
          {text.newTask}
        </Button>
      </>,
    );

    return () => setHeaderActions(undefined);
  }, [navigate, setHeaderActions, tasks.length, text.countUnit, text.newTask]);

  return (
    <div className="viewport-page task-page-layout">
      <section className="panel shrink-0 overflow-hidden p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="task-search-field relative flex-1 md:max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
            <input
              aria-label={text.searchPlaceholder}
              className="control-focus h-9 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={text.searchPlaceholder}
              value={search}
            />
          </div>
          <span className="rounded-md border border-line bg-ink-50 px-2 py-1 text-xs font-medium text-ink-500">
            {filteredTasks.length} / {tasks.length}
          </span>
        </div>
      </section>

      {tasksQuery.isLoading ? (
        <section className="panel min-h-0 overflow-hidden">
          <SkeletonRows rows={8} />
        </section>
      ) : tasksQuery.isError ? (
        <EmptyState
          description={errorMessage(tasksQuery.error)}
          icon={<ClipboardList className="h-5 w-5" />}
          title={text.loadFailed}
        />
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
      ) : filteredTasks.length === 0 ? (
        <EmptyState
          action={
            <Button onClick={() => setSearch("")}>{text.clearFilter}</Button>
          }
          description={text.noMatchDescription}
          icon={<Search className="h-5 w-5" />}
          title={text.noMatchTitle}
        />
      ) : (
        <section className="panel table-panel">
          <div className="table-scroll task-table-scroll">
            <table className="task-table border-collapse">
              <thead className="table-header">
                <tr>
                  <th className="px-4 py-3">{text.table.task}</th>
                  <th className="px-4 py-3">{text.table.apiVersion}</th>
                  <th className="px-4 py-3">{text.table.timeout}</th>
                  <th className="px-4 py-3">{text.table.scriptLines}</th>
                  <th className="px-4 py-3">{text.table.updated}</th>
                  <th className="table-action-header">
                    {copy.common.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedTasks.map((task) => (
                  <tr
                    className="task-table-row"
                    key={task.id}
                  >
                    <td className="table-cell">
                      <button
                        className="task-row-link flex w-full min-w-0 items-start gap-3 text-left"
                        onClick={() => openTask(task.id)}
                        type="button"
                      >
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-100 text-ink-500">
                          <ClipboardList className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink-900">
                            {task.name}
                          </div>
                          <div className="mt-1 truncate text-xs text-ink-500">
                            {task.description || copy.common.noDescription}
                          </div>
                        </div>
                      </button>
                    </td>
                    <td className="table-cell text-ink-700">
                      <span className="rounded-md bg-ink-100 px-2 py-1 text-xs font-medium text-ink-600">
                        {task.api_version}
                      </span>
                    </td>
                    <td className="table-cell mono-tabular text-ink-700">
                      {task.timeout_sec} {text.seconds}
                    </td>
                    <td className="table-cell mono-tabular text-ink-700">
                      {task.script.split("\n").length}
                    </td>
                    <td className="table-cell text-ink-700">
                      {task.updated_at || task.created_at
                        ? formatDateTime(
                            task.updated_at ?? task.created_at,
                            language,
                          )
                        : "-"}
                    </td>
                    <td className="table-action-cell">
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={copy.common.edit}
                          className="h-7 px-1.5"
                          icon={<Edit2 className="h-4 w-4" />}
                          onClick={() => openTask(task.id)}
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
            totalCount={filteredTasks.length}
          />
        </section>
      )}
    </div>
  );
}


type TaskSidePanelKey = "info" | "targets" | "history";
type TaskSidePanelHeights = Record<TaskSidePanelKey, number>;
type TaskCollapsedPanels = Record<TaskSidePanelKey, boolean>;

const TASK_SIDE_PANEL_GAP = 12;
const TASK_SIDE_PANEL_KEYS: TaskSidePanelKey[] = ["info", "targets", "history"];

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
  const [sidePanelHeights, setSidePanelHeights] = useState<TaskSidePanelHeights>({
    info: 280,
    targets: 360,
    history: 260,
  });
  const [preferredSidePanelHeights, setPreferredSidePanelHeights] =
    useState<TaskSidePanelHeights>({
      info: 280,
      targets: 360,
      history: 260,
    });
  const [collapsedSidePanels, setCollapsedSidePanels] =
    useState<TaskCollapsedPanels>({
      info: false,
      targets: false,
      history: false,
    });
  const [sidePanelMaxHeight, setSidePanelMaxHeight] = useState(720);
  const sidePanelRef = useRef<HTMLElement | null>(null);
  const userResizedPanelsRef = useRef<Record<TaskSidePanelKey, boolean>>({
    info: false,
    targets: false,
    history: false,
  });
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
  ]);

  const collapsedPanelCount = TASK_SIDE_PANEL_KEYS.filter(
    (panel) => collapsedSidePanels[panel],
  ).length;
  const maxExpandedPanelHeight = Math.max(
    MIN_SIDE_PANEL_HEIGHT,
    sidePanelMaxHeight -
      TASK_SIDE_PANEL_GAP * (TASK_SIDE_PANEL_KEYS.length - 1) -
      collapsedPanelCount * COLLAPSED_SIDE_PANEL_HEIGHT,
  );

  const setSidePanelHeight = (
    panel: TaskSidePanelKey,
    height: number,
    options?: { fromUser?: boolean },
  ) => {
    if (options?.fromUser) {
      userResizedPanelsRef.current[panel] = true;
    }
    setSidePanelHeights((current) => ({
      ...current,
      [panel]: clampSidePanelHeight(height, maxExpandedPanelHeight),
    }));
  };

  const setPreferredSidePanelHeight = (
    panel: TaskSidePanelKey,
    preferredHeight: number,
  ) => {
    const nextPreferred = clampSidePanelHeight(
      preferredHeight,
      Number.POSITIVE_INFINITY,
      MIN_SIDE_PANEL_HEIGHT,
    );
    setPreferredSidePanelHeights((current) => {
      if (Math.abs(current[panel] - nextPreferred) < 4) {
        return current;
      }
      return { ...current, [panel]: nextPreferred };
    });
  };

  const toggleSidePanel = (panel: TaskSidePanelKey) => {
    setCollapsedSidePanels((current) => {
      const nextCollapsed = !current[panel];
      // 重新展开时回到完整内容高度
      if (!nextCollapsed) {
        userResizedPanelsRef.current[panel] = false;
        setSidePanelHeights((heights) => ({
          ...heights,
          [panel]: preferredSidePanelHeights[panel] || heights[panel],
        }));
      }
      return { ...current, [panel]: nextCollapsed };
    });
  };

  useEffect(() => {
    const element = sidePanelRef.current;
    if (!element) return;

    const updateHeight = () => setSidePanelMaxHeight(element.clientHeight);
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  useEffect(() => {
    setSidePanelHeights((current) => {
      const next = { ...current };
      let changed = false;
      for (const panel of TASK_SIDE_PANEL_KEYS) {
        if (
          !userResizedPanelsRef.current[panel] &&
          !collapsedSidePanels[panel]
        ) {
          const preferred = preferredSidePanelHeights[panel] || next[panel];
          if (Math.abs(next[panel] - preferred) >= 4) {
            next[panel] = preferred;
            changed = true;
          }
        }
      }
      if (
        !changed &&
        TASK_SIDE_PANEL_KEYS.every(
          (panel) => Math.abs(next[panel] - current[panel]) < 1,
        )
      ) {
        return current;
      }
      return next;
    });
  }, [collapsedSidePanels, preferredSidePanelHeights]);

  const scriptLineCount = useMemo(
    () => Math.max(1, draft.script.split("\n").length),
    [draft.script],
  );

  const mutationError =
    saveMutation.error ?? deleteMutation.error ?? runMutation.error;

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
    <div className="viewport-page task-detail-layout">
      <div className="task-detail-workspace grid min-h-0 min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="panel task-editor-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
          {mutationError ? (
            <div className="task-editor-alerts shrink-0 border-b border-line px-4 py-3">
              <div className="rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
                {errorMessage(mutationError)}
              </div>
            </div>
          ) : null}

          <CodeEditor
            ariaLabel={text.scriptEditor}
            className="task-script-editor min-h-0 flex-1"
            language="javascript"
            minHeight={480}
            onChange={(script) => updateDraft("script", script)}
            placeholder={text.scriptPlaceholder}
            toolbar={
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">
                    {text.scriptEditor}
                  </span>
                  <span className="hidden text-xs text-ink-500 sm:inline">
                    {draft.id ? text.editTitle : text.newTitle}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-ink-500">
                  <span className="rounded-md border border-line bg-ink-50 px-2 py-0.5 mono-tabular">
                    JS
                  </span>
                  <span className="mono-tabular">
                    {format(text.lineCount, { count: scriptLineCount })}
                  </span>
                  <span className="mono-tabular">API {draft.api_version}</span>
                </div>
              </div>
            }
            value={draft.script}
            footer={
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs font-medium text-ink-500">
                    {text.templatesLabel}
                  </span>
                  {scriptTemplates.map((template) => (
                    <button
                      className="task-template-chip"
                      key={template.name}
                      onClick={() => updateDraft("script", template.script)}
                      type="button"
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
                <span className="hidden text-xs text-ink-500 lg:inline">
                  {draft.id ? text.detailSubtitle : text.newTaskHint}
                </span>
              </div>
            }
          />
        </section>

        <aside
          ref={sidePanelRef}
          className="task-detail-aside scroll-panel flex min-h-0 min-w-0 flex-col gap-3 overflow-x-hidden"
        >
          <ResizableSidePanel
            collapsed={collapsedSidePanels.info}
            height={sidePanelHeights.info}
            icon={<Settings2 className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) =>
              setSidePanelHeight("info", height, { fromUser: true })
            }
            onPreferredHeightChange={(height) =>
              setPreferredSidePanelHeight("info", height)
            }
            onToggle={() => toggleSidePanel("info")}
            subtitle={draft.id ? text.detailSubtitle : text.newTaskHint}
            title={draft.id ? text.editTitle : text.newTitle}
          >
            <div className="grid gap-3">
              <label className="grid min-w-0 gap-1.5 text-sm">
                <span className="font-medium text-ink-700">
                  {text.taskName}
                  <span className="ml-1 text-danger">*</span>
                </span>
                <input
                  aria-label={text.taskName}
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  className="form-control control-focus h-10 w-full min-w-0 rounded-lg border border-line bg-white px-3.5 text-sm text-ink-900 placeholder:text-ink-400"
                  onChange={(event) => updateDraft("name", event.target.value)}
                  placeholder={text.taskNamePlaceholder}
                  spellCheck={false}
                  value={draft.name}
                />
              </label>

              <label className="grid min-w-0 gap-1.5 text-sm">
                <span className="font-medium text-ink-700">{text.description}</span>
                <textarea
                  aria-label={text.description}
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  className="form-control control-focus min-h-[3.25rem] w-full min-w-0 resize-y rounded-lg border border-line bg-white px-3.5 py-2.5 text-sm leading-5 text-ink-900 placeholder:text-ink-400"
                  onChange={(event) =>
                    updateDraft("description", event.target.value)
                  }
                  placeholder={text.descriptionPlaceholder}
                  rows={2}
                  spellCheck={false}
                  value={draft.description ?? ""}
                />
              </label>

              <label className="grid min-w-0 gap-1.5 text-sm">
                <span className="font-medium text-ink-700">{text.timeout}</span>
                <div className="task-timeout-field flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-3.5">
                  <input
                    aria-label={text.timeout}
                    className="control-focus w-full min-w-0 border-0 bg-transparent p-0 text-sm font-medium tabular-nums text-ink-900 outline-none"
                    min={5}
                    onChange={(event) =>
                      updateDraft(
                        "timeout_sec",
                        Number(event.target.value) || 60,
                      )
                    }
                    spellCheck={false}
                    type="number"
                    value={draft.timeout_sec}
                  />
                  <span className="shrink-0 text-xs text-ink-500">
                    {text.seconds}
                  </span>
                </div>
              </label>
            </div>
          </ResizableSidePanel>

          <ResizableSidePanel
            actions={
              <Button
                disabled={!canRun || runMutation.isPending}
                icon={<Play className="h-4 w-4" />}
                onClick={() => runMutation.mutate()}
                size="sm"
                variant="primary"
              >
                {copy.common.run}
              </Button>
            }
            collapsed={collapsedSidePanels.targets}
            height={sidePanelHeights.targets}
            icon={<Server className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) =>
              setSidePanelHeight("targets", height, { fromUser: true })
            }
            onPreferredHeightChange={(height) =>
              setPreferredSidePanelHeight("targets", height)
            }
            onToggle={() => toggleSidePanel("targets")}
            subtitle={format(text.selectedEnvironments, {
              selected: selectedEnvironmentIds.length,
              total: environments.length,
            })}
            title={text.runTargets}
          >
            <div className="grid min-h-0 gap-3">
              <div className="max-h-full min-h-0 overflow-auto rounded-md border border-line bg-white">
                {lastRunBatch ? (
                  <div className="border-b border-line bg-green-50 px-3 py-2 text-sm text-ok">
                    {format(text.batchCreated, {
                      id: lastRunBatch.id,
                      total: lastRunBatch.total_count,
                    })}
                  </div>
                ) : null}
                {environments.map((environment: Environment) => (
                  <label
                    className="flex cursor-pointer items-center justify-between border-b border-line px-3 py-2 text-sm transition-colors duration-150 last:border-b-0 hover:bg-ink-50 focus-within:bg-brand-50"
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
                    className="border-0 bg-transparent"
                    description={text.noRunnableDescription}
                    icon={<Server className="h-5 w-5" />}
                    title={text.noRunnableTitle}
                  />
                ) : null}
              </div>

              <div className="grid shrink-0 gap-3">
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
            </div>
          </ResizableSidePanel>

          <ResizableSidePanel
            collapsed={collapsedSidePanels.history}
            height={sidePanelHeights.history}
            icon={<History className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) =>
              setSidePanelHeight("history", height, { fromUser: true })
            }
            onPreferredHeightChange={(height) =>
              setPreferredSidePanelHeight("history", height)
            }
            onToggle={() => toggleSidePanel("history")}
            title={text.recentRuns}
          >
            <div className="max-h-full overflow-auto rounded-md border border-line bg-white">
              {selectedEnvironments.length > 0 ? (
                <div className="border-b border-line bg-green-50 px-3 py-2 text-xs text-ok">
                  {format(text.selectedCount, {
                    count: selectedEnvironments.length,
                  })}
                </div>
              ) : null}
              {(recentRunsQuery.data ?? []).slice(0, 8).map((run) => (
                <div
                  className="border-b border-line px-3 py-2 last:border-b-0"
                  key={run.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={run.status} />
                    <span className="text-xs text-ink-500">
                      {formatDateTime(
                        run.started_at ?? run.queued_at,
                        language,
                      )}
                    </span>
                  </div>
                  <p className="mt-2 truncate text-xs text-ink-500">
                    {statusLabel(run.status, language)}
                    {run.error_message ? ` / ${run.error_message}` : ""}
                  </p>
                </div>
              ))}
              {draft.id && recentRunsQuery.data?.length === 0 ? (
                <div className="px-3 py-4 text-sm text-ink-500">
                  {text.noRunHistory}
                </div>
              ) : null}
              {!draft.id ? (
                <div className="px-3 py-6 text-center text-sm text-ink-500">
                  {text.saveToShowHistory}
                </div>
              ) : null}
            </div>
          </ResizableSidePanel>
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
        <p className="mt-3 truncate rounded-md border border-line bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.name}
        </p>
      </Modal>
    </div>
  );
}
