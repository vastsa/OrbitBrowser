import type { ReactNode } from "react";

import { useI18n } from "@/i18n";

interface PageHeaderProps {
  actions?: ReactNode;
  eyebrow?: string;
  metrics?: ReactNode;
  subtitle?: string;
  title: string;
}

export function PageHeader({
  actions,
  eyebrow,
  metrics,
  subtitle,
  title,
}: PageHeaderProps) {
  return (
    <section className="panel-elevated shrink-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/70 bg-white/70 px-4 py-2.5">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-normal text-brand-600">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="truncate text-base font-semibold tracking-tight text-ink-900">{title}</h2>
          {subtitle ? (
            <p className="hidden max-w-3xl truncate text-sm text-ink-500 md:block">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-w-0 shrink-0 flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
      {metrics ? (
        <div className="hidden gap-px bg-white/70 sm:grid sm:grid-cols-2 xl:grid-cols-4">
          {metrics}
        </div>
      ) : null}
    </section>
  );
}

interface MetricTileProps {
  icon?: ReactNode;
  label: string;
  tone?: "blue" | "green" | "amber" | "cyan" | "slate";
  value: string;
}

const metricToneClass: Record<NonNullable<MetricTileProps["tone"]>, string> = {
  amber: "bg-amber-50 text-warn",
  blue: "bg-brand-50 text-brand-600",
  cyan: "bg-teal-50 text-accent",
  green: "bg-green-50 text-ok",
  slate: "bg-ink-100 text-ink-700",
};

export function MetricTile({
  icon,
  label,
  tone = "slate",
  value,
}: MetricTileProps) {
  return (
    <div className="min-w-0 bg-white/72 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500">{label}</p>
          <p className="mono-tabular truncate text-lg font-semibold leading-tight tracking-tight text-ink-900">
            {value}
          </p>
        </div>
        {icon ? (
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${metricToneClass[tone]}`}>
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SectionHeader({
  actions,
  subtitle,
  title,
}: {
  actions?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex min-w-0 shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  const { copy } = useI18n();

  return (
    <div className="grid gap-2 p-4" aria-label={copy.common.loading} role="status">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          className="h-12 animate-pulse rounded-md border border-line bg-ink-50"
          key={index}
        />
      ))}
    </div>
  );
}

export function InfoRow({
  label,
  value,
}: {
  label: string;
  value?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 text-sm">
      <span className="shrink-0 text-ink-500">{label}</span>
      <span className="selectable min-w-0 truncate text-right text-ink-900">
        {value === undefined || value === null || value === "" ? "-" : value}
      </span>
    </div>
  );
}
