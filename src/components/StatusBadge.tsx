import type {
  EnvironmentRuntimeStatus,
  RunLogLevel,
  TaskRunStatus,
} from "@/types/domain";
import { useI18n } from "@/i18n";

type Status = EnvironmentRuntimeStatus | TaskRunStatus | RunLogLevel;

const toneClass: Record<string, string> = {
  running: "border-ok/20 bg-green-50 text-ok",
  starting: "border-brand-500/20 bg-blue-50 text-brand-600",
  stopping: "border-warn/20 bg-amber-50 text-warn",
  stopped: "border-ink-500/20 bg-ink-100 text-ink-700",
  succeeded: "border-ok/20 bg-green-50 text-ok",
  queued: "border-ink-500/20 bg-ink-100 text-ink-700",
  failed: "border-danger/20 bg-red-50 text-danger",
  crashed: "border-danger/20 bg-red-50 text-danger",
  timed_out: "border-warn/20 bg-amber-50 text-warn",
  interrupted: "border-warn/20 bg-amber-50 text-warn",
  cancelled: "border-ink-500/20 bg-ink-100 text-ink-700",
  cancel_requested: "border-warn/20 bg-amber-50 text-warn",
  unknown: "border-ink-500/20 bg-ink-100 text-ink-700",
  info: "border-brand-500/20 bg-blue-50 text-brand-600",
  warn: "border-warn/20 bg-amber-50 text-warn",
  error: "border-danger/20 bg-red-50 text-danger",
  debug: "border-ink-500/20 bg-ink-100 text-ink-700",
  trace: "border-ink-500/20 bg-ink-100 text-ink-700",
};

const dotClass: Record<string, string> = {
  running: "bg-ok",
  starting: "bg-brand-500",
  stopping: "bg-warn",
  stopped: "bg-ink-500",
  succeeded: "bg-ok",
  queued: "bg-ink-500",
  failed: "bg-danger",
  crashed: "bg-danger",
  timed_out: "bg-warn",
  interrupted: "bg-warn",
  cancelled: "bg-ink-500",
  cancel_requested: "bg-warn",
  unknown: "bg-ink-500",
  info: "bg-brand-500",
  warn: "bg-warn",
  error: "bg-danger",
  debug: "bg-ink-500",
  trace: "bg-ink-500",
};

export function StatusBadge({ status }: { status: Status }) {
  const { statusLabel } = useI18n();

  return (
    <span
      className={`non-selectable inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${toneClass[status] ?? toneClass.unknown}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dotClass[status] ?? dotClass.unknown}`}
      />
      {statusLabel(status)}
    </span>
  );
}
