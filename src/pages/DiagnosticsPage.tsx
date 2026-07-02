import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  HardDrive,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/Button";
import { StatusBadge } from "@/components/StatusBadge";
import { useI18n } from "@/i18n";
import { errorMessage, formatBytes, formatDateTime } from "@/lib/format";
import { browserApi } from "@/lib/tauri";

export function DiagnosticsPage() {
  const queryClient = useQueryClient();
  const { copy, format, language } = useI18n();
  const text = copy.diagnostics;

  const diagnosticsQuery = useQuery({
    queryKey: ["diagnostics"],
    queryFn: browserApi.getDiagnostics,
    refetchInterval: 5000,
  });

  const detectChromeMutation = useMutation({
    mutationFn: browserApi.detectChrome,
  });

  const cleanupStaleMutation = useMutation({
    mutationFn: browserApi.cleanupStaleSessions,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const cleanupTempMutation = useMutation({
    mutationFn: browserApi.cleanupTempFiles,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    },
  });

  const diagnostics = diagnosticsQuery.data;

  return (
    <div className="viewport-page grid-rows-[auto_auto_minmax(0,1fr)]">
      <section className="panel shrink-0 p-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-900">{text.overview}</h2>
            <p className="mt-1 text-sm text-ink-500">
              {diagnostics?.generated_at
                ? format(text.generatedAt, {
                    time: formatDateTime(diagnostics.generated_at, language),
                  })
                : text.waiting}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              icon={<Search className="h-4 w-4" />}
              onClick={() => detectChromeMutation.mutate()}
            >
              {text.detectChrome}
            </Button>
            <Button
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void diagnosticsQuery.refetch()}
            >
              {copy.common.refresh}
            </Button>
          </div>
        </div>
        {(diagnosticsQuery.error || detectChromeMutation.error) && (
          <div className="mt-4 rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
            {errorMessage(diagnosticsQuery.error ?? detectChromeMutation.error)}
          </div>
        )}
        {detectChromeMutation.data ? (
          <div className="selectable mt-4 rounded-md border border-line bg-ink-50 px-3 py-2 text-sm text-ink-700">
            {detectChromeMutation.data.found
              ? `${detectChromeMutation.data.path ?? ""} ${detectChromeMutation.data.version ?? ""}`
              : detectChromeMutation.data.error ?? text.chromeNotDetected}
          </div>
        ) : null}
      </section>

      <section className="grid shrink-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<Activity className="h-5 w-5" />}
          label={text.metrics.runningBrowsers}
          value={String(diagnostics?.runtime?.running_browser_count ?? 0)}
        />
        <MetricCard
          icon={<Database className="h-5 w-5" />}
          label={text.metrics.queueConcurrency}
          value={String(diagnostics?.runtime?.current_queue_concurrency ?? 0)}
        />
        <MetricCard
          icon={<HardDrive className="h-5 w-5" />}
          label={text.metrics.profiles}
          value={formatBytes(diagnostics?.data?.profiles_total_size)}
        />
        <MetricCard
          icon={<HardDrive className="h-5 w-5" />}
          label={text.metrics.runs}
          value={formatBytes(diagnostics?.data?.runs_total_size)}
        />
      </section>

      <section className="scroll-panel grid content-start gap-3 pr-1">
        <div className="grid gap-3 xl:grid-cols-2">
          <DiagnosticPanel title={text.panels.chrome}>
            <InfoRow label={text.currentPath} value={diagnostics?.chrome?.path} />
            <InfoRow label={text.version} value={diagnostics?.chrome?.version} />
            <InfoRow
              label={text.launchable}
              value={diagnostics?.chrome?.launchable ? text.yes : text.no}
            />
            <InfoRow
              label={text.cdpTest}
              value={diagnostics?.chrome?.cdp_test_ok ? text.passed : text.failed}
            />
            {diagnostics?.chrome?.error ? (
              <div className="selectable rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
                {diagnostics.chrome.error}
              </div>
            ) : null}
          </DiagnosticPanel>

          <DiagnosticPanel title={text.panels.data}>
            <InfoRow label={text.dataDirectory} value={diagnostics?.data?.data_dir} />
            <InfoRow label="SQLite" value={diagnostics?.data?.sqlite_path} />
            <InfoRow
              label={text.profilesSize}
              value={formatBytes(diagnostics?.data?.profiles_total_size)}
            />
            <InfoRow
              label={text.runsSize}
              value={formatBytes(diagnostics?.data?.runs_total_size)}
            />
          </DiagnosticPanel>

          <DiagnosticPanel title={text.panels.runtime}>
            <InfoRow
              label={text.metrics.runningBrowsers}
              value={String(diagnostics?.runtime?.running_browser_count ?? 0)}
            />
            <InfoRow
              label={text.metrics.queueConcurrency}
              value={String(diagnostics?.runtime?.current_queue_concurrency ?? 0)}
            />
            <InfoRow
              label={text.staleProcesses}
              value={String(diagnostics?.runtime?.stale_process_count ?? 0)}
            />
          </DiagnosticPanel>

          <DiagnosticPanel title={text.panels.recovery}>
            <InfoRow
              label={text.interruptedRuns}
              value={String(diagnostics?.recovery?.interrupted_run_count ?? 0)}
            />
            <InfoRow
              label={text.staleLock}
              value={String(diagnostics?.recovery?.stale_lock_count ?? 0)}
            />
            <div className="mt-2 flex gap-2">
              <Button
                disabled={cleanupStaleMutation.isPending}
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => cleanupStaleMutation.mutate()}
              >
                {text.cleanStale}
              </Button>
              <Button
                disabled={cleanupTempMutation.isPending}
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => cleanupTempMutation.mutate()}
              >
                {text.cleanTemp}
              </Button>
            </div>
            {cleanupStaleMutation.data ? (
              <div className="rounded-md border border-ok/20 bg-green-50 px-3 py-2 text-sm text-ok">
                {format(text.cleanedStale, { count: cleanupStaleMutation.data.cleaned })}
              </div>
            ) : null}
            {cleanupTempMutation.data ? (
              <div className="rounded-md border border-ok/20 bg-green-50 px-3 py-2 text-sm text-ok">
                {format(text.cleanedTemp, { count: cleanupTempMutation.data.cleaned })}
                {cleanupTempMutation.data.freed_bytes
                  ? format(text.freedBytes, {
                      bytes: formatBytes(cleanupTempMutation.data.freed_bytes),
                    })
                  : ""}
              </div>
            ) : null}
            {(cleanupStaleMutation.error || cleanupTempMutation.error) ? (
              <div className="rounded-md border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">
                {errorMessage(cleanupStaleMutation.error ?? cleanupTempMutation.error)}
              </div>
            ) : null}
          </DiagnosticPanel>
        </div>

        <section className="panel p-3">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">{text.panels.proxy}</h2>
        <div className="grid gap-4 text-sm md:grid-cols-3">
          <InfoRow label={text.latestResult} value={diagnostics?.proxy?.last_test_status} />
          <InfoRow label={text.testTime} value={diagnostics?.proxy?.last_test_at} />
          <InfoRow label={text.message} value={diagnostics?.proxy?.message} />
        </div>
        </section>

      {(diagnostics?.warnings ?? []).length > 0 ? (
        <section className="panel p-3">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">{text.warnings}</h2>
          <div className="grid gap-2">
            {(diagnostics?.warnings ?? []).map((warning) => (
              <div
                className="selectable flex items-center gap-2 rounded-md border border-warn/20 bg-amber-50 px-3 py-2 text-sm text-warn"
                key={warning}
              >
                <StatusBadge status="warn" />
                {warning}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      </section>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="panel p-3">
      <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-white">
        {icon}
      </div>
      <div className="text-lg font-semibold text-ink-900">{value}</div>
      <div className="mt-1 text-sm text-ink-500">{label}</div>
    </div>
  );
}

function DiagnosticPanel({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="panel p-3">
      <h2 className="mb-3 text-sm font-semibold text-ink-900">{title}</h2>
      <div className="grid gap-2">{children}</div>
    </section>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="shrink-0 text-ink-500">{label}</span>
      <span className="selectable min-w-0 truncate text-right text-ink-900">
        {value === undefined || value === null || value === "" ? "-" : value}
      </span>
    </div>
  );
}
