import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FolderOpen,
  Languages,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/Button";
import { SelectField, TextField } from "@/components/FormField";
import { languageOptions, useI18n } from "@/i18n";
import { errorMessage, formatBytes } from "@/lib/format";
import { browserApi } from "@/lib/tauri";
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
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { copy, format, language, setLanguage } = useI18n();
  const text = copy.settings;
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const saveMutation = useMutation({
    mutationFn: browserApi.saveSettings,
    onSuccess: (saved) => {
      setSettings(saved);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const detectMutation = useMutation({
    mutationFn: browserApi.detectChrome,
    onSuccess: (result) => {
      if (result.path) {
        const nextSettings = { ...settings, chrome_path: result.path };
        setSettings(nextSettings);
        saveMutation.mutate(nextSettings);
      }
    },
  });

  const validateChromeMutation = useMutation({
    mutationFn: browserApi.validateChromePath,
  });

  const openDataDirMutation = useMutation({
    mutationFn: browserApi.openDataDir,
  });

  const cleanupMutation = useMutation({
    mutationFn: browserApi.cleanupTempFiles,
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setSettings({ ...defaultSettings, ...settingsQuery.data });
    }
  }, [settingsQuery.data]);

  const update = <TKey extends keyof Settings>(
    key: TKey,
    value: Settings[TKey],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  return (
    <div className="scroll-panel grid h-full min-h-0 w-full gap-3 pr-1 xl:grid-cols-[minmax(0,1fr)_320px] xl:overflow-hidden xl:pr-0">
      <section className="panel scroll-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-900">{text.general}</h2>
          </div>
          <Button
            disabled={saveMutation.isPending}
            icon={<Save className="h-4 w-4" />}
            onClick={() => saveMutation.mutate(settings)}
            variant="primary"
          >
            {text.save}
          </Button>
        </div>

        {(settingsQuery.error ||
          saveMutation.error ||
          detectMutation.error ||
          validateChromeMutation.error ||
          openDataDirMutation.error) && (
          <div className="mb-4 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
            {errorMessage(
              settingsQuery.error ??
                saveMutation.error ??
                detectMutation.error ??
                validateChromeMutation.error ??
                openDataDirMutation.error,
            )}
          </div>
        )}

        <div className="grid gap-4">
          <section className="grid gap-3">
            <div className="flex items-center gap-2">
              <Languages className="h-4 w-4 text-brand-600" />
              <h3 className="text-sm font-semibold text-ink-900">{text.preferences}</h3>
            </div>
            <div className="md:max-w-sm">
              <SelectField
                label={text.appLanguage}
                onChange={(event) => setLanguage(event.target.value as AppLanguage)}
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

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold text-ink-900">Chrome</h3>
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

            {(detectMutation.data || validateChromeMutation.data) ? (
              <div
                className={`rounded-md border px-3 py-2 text-sm ${
                  (validateChromeMutation.data ?? detectMutation.data)?.found
                    ? "border-ok/20 bg-green-50 text-ok"
                    : "border-warn/20 bg-amber-50 text-warn"
                }`}
              >
                {(validateChromeMutation.data ?? detectMutation.data)?.found
                  ? format(text.detected, {
                      version: (validateChromeMutation.data ?? detectMutation.data)?.version ?? "Chrome",
                    })
                  : (validateChromeMutation.data ?? detectMutation.data)?.error ??
                    text.chromeNotDetected}
              </div>
            ) : null}
          </section>

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold text-ink-900">{text.defaults}</h3>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <TextField
                label={text.defaultConcurrency}
                min={1}
                onChange={(event) =>
                  update(
                    "default_concurrency",
                    Number(event.target.value) || 1,
                  )
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

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold text-ink-900">{text.dataDirectory}</h3>
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
        </div>
      </section>

      <aside className="scroll-panel grid content-start gap-3">
        <section className="panel p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-900">{text.maintenance}</h2>
            <Button
              disabled={cleanupMutation.isPending}
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => cleanupMutation.mutate()}
            >
              {text.cleanTemp}
            </Button>
          </div>
          {cleanupMutation.data ? (
            <div className="mt-3 rounded-md border border-ok/20 bg-green-50 px-3 py-2 text-sm text-ok">
              {format(text.cleanedItems, { count: cleanupMutation.data.cleaned })}
              {cleanupMutation.data.freed_bytes
                ? format(text.freedBytes, {
                    bytes: formatBytes(cleanupMutation.data.freed_bytes),
                  })
                : ""}
            </div>
          ) : null}
          {cleanupMutation.error ? (
            <div className="mt-3 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
              {errorMessage(cleanupMutation.error)}
            </div>
          ) : null}
        </section>

      </aside>
    </div>
  );
}
