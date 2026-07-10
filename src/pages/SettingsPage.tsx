import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Bot,
  CheckCircle2,
  FolderOpen,
  Languages,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/Button";
import { SelectField, TextField } from "@/components/FormField";
import { languageOptions, useI18n } from "@/i18n";
import { errorMessage, formatBytes } from "@/lib/format";
import { browserApi, isTauriRuntime } from "@/lib/tauri";
import { useUiStore } from "@/stores/uiStore";
import type { AppLanguage } from "@/stores/uiStore";
import type { CamoufoxInstallProgress, Settings } from "@/types/domain";

const defaultSettings: Settings = {
  chrome_path: "",
  camoufox_python_path: "",
  default_concurrency: 2,
  default_locale: "zh-CN",
  default_timezone_id: "auto",
  default_viewport_width: 1280,
  default_viewport_height: 800,
  data_dir: "",
  aigc_base_url: "",
  aigc_model: "",
  aigc_api_key: "",
};

const AUTO_SAVE_DELAY_MS = 600;

function settingsSignature(value: Settings) {
  return JSON.stringify({
    chrome_path: value.chrome_path ?? "",
    camoufox_python_path: value.camoufox_python_path ?? "",
    default_concurrency: value.default_concurrency,
    default_locale: value.default_locale,
    default_timezone_id: value.default_timezone_id,
    default_viewport_width: value.default_viewport_width,
    default_viewport_height: value.default_viewport_height,
    aigc_base_url: value.aigc_base_url ?? "",
    aigc_model: value.aigc_model ?? "",
    aigc_api_key: value.aigc_api_key ?? "",
  });
}

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { copy, format, language, setLanguage } = useI18n();
  const text = copy.settings;
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);
  const [camoufoxInstallProgress, setCamoufoxInstallProgress] =
    useState<CamoufoxInstallProgress | null>(null);
  const [camoufoxProgressListenerReady, setCamoufoxProgressListenerReady] =
    useState(() => !isTauriRuntime());
  const camoufoxInstallOperationRef = useRef<string | null>(null);
  const validatedCamoufoxPathRef = useRef<string | null>(null);
  const hydratedSettingsRef = useRef(false);
  const lastSavedSignatureRef = useRef(settingsSignature(defaultSettings));
  const pendingSaveSignatureRef = useRef<string | null>(null);
  const currentSettingsRef = useRef<Settings>(defaultSettings);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const saveMutation = useMutation({
    scope: { id: "settings-save" },
    mutationFn: browserApi.saveSettings,
    onSuccess: (saved, submitted) => {
      const nextSettings = { ...defaultSettings, ...saved };
      const submittedSignature = settingsSignature(submitted);
      lastSavedSignatureRef.current = settingsSignature(nextSettings);
      if (pendingSaveSignatureRef.current === submittedSignature) {
        pendingSaveSignatureRef.current = null;
      }

      // 保存请求返回期间，用户可能继续输入；只同步当前这次提交对应的响应。
      if (
        settingsSignature(currentSettingsRef.current) === submittedSignature
      ) {
        currentSettingsRef.current = nextSettings;
        setSettings(nextSettings);
      }

      queryClient.setQueryData(["settings"], nextSettings);
    },
    onError: (_error, submitted) => {
      const submittedSignature = settingsSignature(submitted);
      if (pendingSaveSignatureRef.current === submittedSignature) {
        pendingSaveSignatureRef.current = null;
      }
    },
  });

  const detectMutation = useMutation({
    mutationFn: browserApi.detectChrome,
    onSuccess: (result) => {
      if (result.path) {
        applySettingsAndSaveImmediately({ chrome_path: result.path });
      }
    },
  });

  const validateChromeMutation = useMutation({
    mutationFn: browserApi.validateChromePath,
  });

  const detectCamoufoxMutation = useMutation({
    mutationFn: browserApi.detectCamoufox,
    onSuccess: persistCamoufoxPath,
  });

  const validateCamoufoxMutation = useMutation({
    mutationFn: browserApi.validateCamoufoxPythonPath,
  });

  const installCamoufoxMutation = useMutation({
    mutationFn: browserApi.installCamoufox,
    onSuccess: (result, operationId) => {
      persistCamoufoxPath(result);
      if (camoufoxInstallOperationRef.current !== operationId) {
        return;
      }
      setCamoufoxInstallProgress({
        operation_id: operationId,
        stage: null,
        status: "completed",
        percent: 100,
      });
      camoufoxInstallOperationRef.current = null;
    },
    onError: (error, operationId) => {
      if (camoufoxInstallOperationRef.current !== operationId) {
        return;
      }
      setCamoufoxInstallProgress((current) => ({
        operation_id: operationId,
        stage: current?.stage ?? null,
        status: "failed",
        percent: current?.percent ?? 0,
        message: errorMessage(error),
      }));
      camoufoxInstallOperationRef.current = null;
    },
  });

  const openDataDirMutation = useMutation({
    mutationFn: browserApi.openDataDir,
  });

  const cleanupMutation = useMutation({
    mutationFn: browserApi.cleanupTempFiles,
  });

  useEffect(() => {
    currentSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<CamoufoxInstallProgress>(
      "camoufox_install_progress",
      (event) => {
        if (
          event.payload.operation_id !== camoufoxInstallOperationRef.current
        ) {
          return;
        }
        setCamoufoxInstallProgress(event.payload);
      },
    )
      .then((listener) => {
        if (disposed) {
          listener();
          return;
        }
        unlisten = listener;
        setCamoufoxProgressListenerReady(true);
      })
      .catch(() => {
        // 浏览器预览模式没有 Tauri 事件运行时，仍保留基础 loading 状态。
        if (!disposed) {
          setCamoufoxProgressListenerReady(true);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (settingsQuery.data && !hydratedSettingsRef.current) {
      const nextSettings = { ...defaultSettings, ...settingsQuery.data };
      hydratedSettingsRef.current = true;
      lastSavedSignatureRef.current = settingsSignature(nextSettings);
      currentSettingsRef.current = nextSettings;
      setSettings(nextSettings);
      setLoaded(true);
    }
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    const path = settings.camoufox_python_path?.trim();
    if (!path || validatedCamoufoxPathRef.current === path) {
      return;
    }

    validatedCamoufoxPathRef.current = path;
    validateCamoufoxMutation.mutate(path);
  }, [loaded, settings.camoufox_python_path]);

  useEffect(() => {
    if (!loaded) {
      return;
    }

    const signature = settingsSignature(settings);
    if (
      signature === lastSavedSignatureRef.current ||
      signature === pendingSaveSignatureRef.current
    ) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      pendingSaveSignatureRef.current = settingsSignature(settings);
      saveMutation.mutate(settings);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [loaded, settings]);

  const saveImmediately = (nextSettings: Settings) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveSignatureRef.current = settingsSignature(nextSettings);
    saveMutation.mutate(nextSettings);
  };

  const applySettingsAndSaveImmediately = (updates: Partial<Settings>) => {
    const nextSettings = {
      ...currentSettingsRef.current,
      ...updates,
    };
    currentSettingsRef.current = nextSettings;
    setSettings(nextSettings);
    saveImmediately(nextSettings);
  };

  function persistCamoufoxPath(result: {
    found: boolean;
    python_path?: string | null;
  }) {
    const pythonPath = result.found ? result.python_path?.trim() : undefined;
    if (!pythonPath) {
      return;
    }

    validatedCamoufoxPathRef.current = pythonPath;
    validateCamoufoxMutation.reset();
    applySettingsAndSaveImmediately({ camoufox_python_path: pythonPath });
  }

  const update = <TKey extends keyof Settings>(
    key: TKey,
    value: Settings[TKey],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const detectCamoufox = () => {
    setCamoufoxInstallProgress(null);
    installCamoufoxMutation.reset();
    detectCamoufoxMutation.mutate();
  };

  const installCamoufox = () => {
    const operationId = crypto.randomUUID();
    camoufoxInstallOperationRef.current = operationId;
    detectCamoufoxMutation.reset();
    installCamoufoxMutation.reset();
    setCamoufoxInstallProgress({
      operation_id: operationId,
      stage: "locating_python",
      status: "running",
      percent: 0,
    });
    installCamoufoxMutation.mutate(operationId);
  };

  const camoufoxBusy =
    !loaded ||
    detectCamoufoxMutation.isPending ||
    validateCamoufoxMutation.isPending ||
    installCamoufoxMutation.isPending;
  const camoufoxResult =
    installCamoufoxMutation.data ??
    detectCamoufoxMutation.data ??
    validateCamoufoxMutation.data;
  const savedCamoufoxPathInvalid =
    Boolean(settings.camoufox_python_path?.trim()) &&
    Boolean(validateCamoufoxMutation.error) &&
    !detectCamoufoxMutation.data &&
    !installCamoufoxMutation.data;
  const camoufoxProgressPercent = Math.min(
    100,
    Math.max(0, camoufoxInstallProgress?.percent ?? 0),
  );
  const camoufoxProgressLabel = camoufoxInstallProgress?.stage
    ? text.camoufoxInstallStages[camoufoxInstallProgress.stage]
    : text.installingCamoufox;

  const saveStatus = saveMutation.isPending
    ? text.autoSaving
    : settingsSignature(settings) === lastSavedSignatureRef.current
      ? text.autoSaved
      : text.autoSavePending;
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);

  useEffect(() => {
    setHeaderActions(
      <span className="rounded-md bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-500">
        {saveStatus}
      </span>,
    );

    return () => setHeaderActions(undefined);
  }, [saveStatus, setHeaderActions]);

  return (
    <div className="scroll-panel h-full min-h-0 w-full pr-1">
      <section className="panel mx-auto max-w-5xl overflow-hidden">
        {(settingsQuery.error ||
          saveMutation.error ||
          detectMutation.error ||
          validateChromeMutation.error ||
          detectCamoufoxMutation.error ||
          installCamoufoxMutation.error ||
          openDataDirMutation.error) && (
          <div className="m-5 rounded-lg border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
            {errorMessage(
              settingsQuery.error ??
                saveMutation.error ??
                detectMutation.error ??
                validateChromeMutation.error ??
                detectCamoufoxMutation.error ??
                installCamoufoxMutation.error ??
                openDataDirMutation.error,
            )}
          </div>
        )}

        <div className="divide-y divide-line">
          <section className="grid gap-4 p-5">
            <div className="flex items-center gap-2">
              <Languages className="h-4 w-4 text-brand-600" />
              <h3 className="text-[15px] font-semibold text-ink-900">
                {text.preferences}
              </h3>
            </div>
            <div className="md:max-w-sm">
              <SelectField
                label={text.appLanguage}
                onChange={(event) =>
                  setLanguage(event.target.value as AppLanguage)
                }
                value={language}
              >
                {languageOptions.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </SelectField>
            </div>
          </section>

          <section className="grid gap-4 p-5">
            <div>
              <h3 className="text-[15px] font-semibold text-ink-900">
                {text.camoufox}
              </h3>
              <p className="mt-1 text-xs leading-5 text-ink-500">
                {text.camoufoxHint}
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <TextField
                label={text.camoufoxPythonPath}
                readOnly
                value={settings.camoufox_python_path ?? ""}
              />
              <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:items-end">
                <Button
                  className="w-full whitespace-nowrap lg:w-44"
                  disabled={camoufoxBusy}
                  icon={<Search className="h-4 w-4" />}
                  onClick={detectCamoufox}
                >
                  {text.detectCamoufox}
                </Button>
                <Button
                  className="w-full whitespace-nowrap lg:w-60"
                  disabled={camoufoxBusy || !camoufoxProgressListenerReady}
                  icon={
                    installCamoufoxMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )
                  }
                  onClick={installCamoufox}
                >
                  {installCamoufoxMutation.isPending
                    ? text.installingCamoufox
                    : text.installCamoufox}
                </Button>
              </div>
            </div>

            {installCamoufoxMutation.isPending && camoufoxInstallProgress ? (
              <div
                aria-atomic="true"
                aria-live="polite"
                className="min-w-0 rounded-lg border border-line bg-ink-50/60 px-3 py-2.5"
              >
                <div className="flex items-start gap-2 text-sm text-ink-700">
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 break-words font-medium leading-5">
                    {camoufoxProgressLabel}
                  </span>
                  <span className="mono-tabular w-11 shrink-0 text-right leading-5 text-ink-500">
                    {camoufoxProgressPercent}%
                  </span>
                </div>
                <div
                  aria-label={camoufoxProgressLabel}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={camoufoxProgressPercent}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-brand-600 transition-[width] duration-300 ease-out"
                    style={{ width: `${camoufoxProgressPercent}%` }}
                  />
                </div>
              </div>
            ) : null}

            {!installCamoufoxMutation.isPending &&
            validateCamoufoxMutation.isPending ? (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-ink-50/60 px-3 py-2 text-sm text-ink-600">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-600" />
                <span className="min-w-0 break-words">
                  {text.validatingCamoufoxPath}
                </span>
              </div>
            ) : null}

            {!installCamoufoxMutation.isPending &&
            !validateCamoufoxMutation.isPending &&
            savedCamoufoxPathInvalid ? (
              <div className="min-w-0 break-words rounded-lg border border-warn/20 bg-amber-50 px-3 py-2 text-sm text-warn">
                {text.camoufoxSavedPathInvalid}
              </div>
            ) : null}

            {!installCamoufoxMutation.isPending &&
            !validateCamoufoxMutation.isPending &&
            !savedCamoufoxPathInvalid &&
            camoufoxResult ? (
              <div
                className={`min-w-0 break-words rounded-lg border px-3 py-2 text-sm ${
                  camoufoxResult.found
                    ? "border-ok/20 bg-green-50 text-ok"
                    : "border-warn/20 bg-amber-50 text-warn"
                }`}
              >
                {camoufoxResult.found
                  ? format(text.detected, {
                      version: camoufoxResult.version ?? "Camoufox",
                    })
                  : (camoufoxResult.error ?? text.camoufoxNotDetected)}
              </div>
            ) : null}
          </section>

          <section className="grid gap-4 p-5">
            <h3 className="text-[15px] font-semibold text-ink-900">Chrome</h3>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <TextField
                label={text.chromePath}
                onChange={(event) => update("chrome_path", event.target.value)}
                value={settings.chrome_path ?? ""}
              />
              <div className="flex items-end">
                <Button
                  disabled={!loaded || detectMutation.isPending}
                  icon={<Search className="h-4 w-4" />}
                  onClick={() => detectMutation.mutate()}
                >
                  {text.autoDetect}
                </Button>
              </div>
              <div className="flex items-end">
                <Button
                  disabled={
                    !loaded ||
                    validateChromeMutation.isPending ||
                    !settings.chrome_path?.trim()
                  }
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  onClick={() =>
                    validateChromeMutation.mutate(settings.chrome_path ?? "")
                  }
                >
                  {text.validatePath}
                </Button>
              </div>
            </div>

            {detectMutation.data || validateChromeMutation.data ? (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  (validateChromeMutation.data ?? detectMutation.data)?.found
                    ? "border-ok/20 bg-green-50 text-ok"
                    : "border-warn/20 bg-amber-50 text-warn"
                }`}
              >
                {(validateChromeMutation.data ?? detectMutation.data)?.found
                  ? format(text.detected, {
                      version:
                        (validateChromeMutation.data ?? detectMutation.data)
                          ?.version ?? "Chrome",
                    })
                  : ((validateChromeMutation.data ?? detectMutation.data)
                      ?.error ?? text.chromeNotDetected)}
              </div>
            ) : null}
          </section>

          <section className="grid gap-4 p-5">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-brand-600" />
              <h3 className="text-[15px] font-semibold text-ink-900">
                {text.aigc}
              </h3>
            </div>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <TextField
                label={text.aigcBaseUrl}
                onChange={(event) =>
                  update("aigc_base_url", event.target.value)
                }
                placeholder="https://api.openai.com/v1"
                value={settings.aigc_base_url ?? ""}
              />
              <TextField
                label={text.aigcModel}
                onChange={(event) => update("aigc_model", event.target.value)}
                placeholder="gpt-4o-mini"
                value={settings.aigc_model ?? ""}
              />
              <TextField
                autoComplete="off"
                label={text.aigcApiKey}
                onChange={(event) => update("aigc_api_key", event.target.value)}
                placeholder="sk-..."
                type="password"
                value={settings.aigc_api_key ?? ""}
              />
            </div>
          </section>

          <section className="grid gap-4 p-5">
            <h3 className="text-[15px] font-semibold text-ink-900">
              {text.defaults}
            </h3>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <TextField
                label={text.defaultConcurrency}
                min={1}
                onChange={(event) =>
                  update("default_concurrency", Number(event.target.value) || 1)
                }
                type="number"
                value={settings.default_concurrency}
              />
              <TextField
                label={text.defaultLocale}
                onChange={(event) =>
                  update("default_locale", event.target.value)
                }
                value={settings.default_locale}
              />
              <TextField
                label={text.defaultTimezone}
                onChange={(event) =>
                  update("default_timezone_id", event.target.value)
                }
                value={settings.default_timezone_id}
              />
              <TextField
                label={text.defaultViewportWidth}
                min={320}
                onChange={(event) =>
                  update(
                    "default_viewport_width",
                    Number(event.target.value) || 1280,
                  )
                }
                type="number"
                value={settings.default_viewport_width}
              />
              <TextField
                label={text.defaultViewportHeight}
                min={240}
                onChange={(event) =>
                  update(
                    "default_viewport_height",
                    Number(event.target.value) || 800,
                  )
                }
                type="number"
                value={settings.default_viewport_height}
              />
            </div>
          </section>

          <section className="grid gap-4 p-5">
            <h3 className="text-[15px] font-semibold text-ink-900">
              {text.dataDirectory}
            </h3>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
              <TextField
                label={text.currentDirectory}
                readOnly
                value={settings.data_dir ?? ""}
              />
              <div className="flex items-end">
                <Button
                  disabled={openDataDirMutation.isPending}
                  icon={<FolderOpen className="h-4 w-4" />}
                  onClick={() => openDataDirMutation.mutate()}
                >
                  {text.openDirectory}
                </Button>
              </div>
            </div>
          </section>

          <section className="grid gap-4 bg-ink-50/60 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-semibold text-ink-900">
                  {text.maintenance}
                </h3>
                <p className="mt-1 text-xs text-ink-500">
                  {text.maintenanceHint}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  icon={<Activity className="h-4 w-4" />}
                  onClick={() => navigate("/diagnostics")}
                >
                  {text.openDiagnostics}
                </Button>
                <Button
                  disabled={cleanupMutation.isPending}
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => cleanupMutation.mutate()}
                >
                  {text.cleanTemp}
                </Button>
              </div>
            </div>
            {cleanupMutation.data ? (
              <div className="rounded-lg border border-ok/20 bg-green-50 px-3 py-2 text-sm text-ok">
                {format(text.cleanedItems, {
                  count: cleanupMutation.data.cleaned,
                })}
                {cleanupMutation.data.freed_bytes
                  ? format(text.freedBytes, {
                      bytes: formatBytes(cleanupMutation.data.freed_bytes),
                    })
                  : ""}
              </div>
            ) : null}
            {cleanupMutation.error ? (
              <div
                className="rounded-lg border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger"
                role="alert"
              >
                {errorMessage(cleanupMutation.error)}
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
