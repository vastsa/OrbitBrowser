import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CheckCircle2,
  FolderOpen,
  Languages,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/Button";
import { SelectField, TextField } from "@/components/FormField";
import { languageOptions, useI18n } from "@/i18n";
import { errorMessage, formatBytes } from "@/lib/format";
import { browserApi } from "@/lib/tauri";
import { useUiStore } from "@/stores/uiStore";
import type { AppLanguage } from "@/stores/uiStore";
import type { Settings } from "@/types/domain";

const defaultSettings: Settings = {
  chrome_path: "",
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
  const lastSavedSignatureRef = useRef(settingsSignature(defaultSettings));
  const currentSettingsRef = useRef<Settings>(defaultSettings);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const saveMutation = useMutation({
    mutationFn: browserApi.saveSettings,
    onSuccess: (saved, submitted) => {
      const nextSettings = { ...defaultSettings, ...saved };
      const submittedSignature = settingsSignature(submitted);
      lastSavedSignatureRef.current = settingsSignature(nextSettings);

      // 保存请求返回期间，用户可能继续输入；只同步当前这次提交对应的响应。
      if (
        settingsSignature(currentSettingsRef.current) === submittedSignature
      ) {
        setSettings(nextSettings);
      }

      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const detectMutation = useMutation({
    mutationFn: browserApi.detectChrome,
    onSuccess: (result) => {
      if (result.path) {
        const nextSettings = { ...settings, chrome_path: result.path };
        setSettings(nextSettings);
        saveImmediately(nextSettings);
      }
    },
  });

  const validateChromeMutation = useMutation({
    mutationFn: browserApi.validateChromePath,
  });

  const detectCamoufoxMutation = useMutation({
    mutationFn: browserApi.detectCamoufox,
  });

  const installCamoufoxMutation = useMutation({
    mutationFn: browserApi.installCamoufox,
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
    if (settingsQuery.data) {
      const nextSettings = { ...defaultSettings, ...settingsQuery.data };
      lastSavedSignatureRef.current = settingsSignature(nextSettings);
      setSettings(nextSettings);
      setLoaded(true);
    }
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!loaded) {
      return;
    }

    const signature = settingsSignature(settings);
    if (signature === lastSavedSignatureRef.current) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
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
    saveMutation.mutate(nextSettings);
  };

  const update = <TKey extends keyof Settings>(
    key: TKey,
    value: Settings[TKey],
  ) => setSettings((current) => ({ ...current, [key]: value }));

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
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <TextField
                label={text.camoufoxPythonPath}
                readOnly
                value={
                  (installCamoufoxMutation.data ?? detectCamoufoxMutation.data)
                    ?.python_path ?? ""
                }
              />
              <div className="flex items-end">
                <Button
                  disabled={detectCamoufoxMutation.isPending}
                  icon={<Search className="h-4 w-4" />}
                  onClick={() => detectCamoufoxMutation.mutate()}
                >
                  {text.detectCamoufox}
                </Button>
              </div>
              <div className="flex items-end">
                <Button
                  disabled={installCamoufoxMutation.isPending}
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  onClick={() => installCamoufoxMutation.mutate()}
                >
                  {text.installCamoufox}
                </Button>
              </div>
            </div>

            {detectCamoufoxMutation.data || installCamoufoxMutation.data ? (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  (installCamoufoxMutation.data ?? detectCamoufoxMutation.data)
                    ?.found
                    ? "border-ok/20 bg-green-50 text-ok"
                    : "border-warn/20 bg-amber-50 text-warn"
                }`}
              >
                {(installCamoufoxMutation.data ?? detectCamoufoxMutation.data)
                  ?.found
                  ? format(text.detected, {
                      version:
                        (installCamoufoxMutation.data ??
                          detectCamoufoxMutation.data)?.version ?? "Camoufox",
                    })
                  : ((installCamoufoxMutation.data ??
                      detectCamoufoxMutation.data)?.error ??
                    text.camoufoxNotDetected)}
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
                  disabled={detectMutation.isPending}
                  icon={<Search className="h-4 w-4" />}
                  onClick={() => detectMutation.mutate()}
                >
                  {text.autoDetect}
                </Button>
              </div>
              <div className="flex items-end">
                <Button
                  disabled={
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
