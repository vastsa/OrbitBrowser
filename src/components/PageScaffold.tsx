import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/Button";
import { SelectControl } from "@/components/FormField";
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
    <section className="shrink-0 overflow-hidden rounded-xl border border-line bg-white">
      <div
        className={`flex flex-wrap items-center justify-between gap-4 bg-white px-5 py-4 ${metrics ? "border-b border-line" : ""}`}
      >
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1 text-xs font-medium text-ink-500">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink-900">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-1 max-w-3xl text-sm leading-5 text-ink-500">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-w-0 shrink-0 flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
      {metrics ? (
        <div className="hidden gap-px bg-line sm:grid sm:grid-cols-2 xl:grid-cols-4">
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
  amber: "border-warn/15 bg-amber-50 text-warn",
  blue: "border-brand-500/15 bg-brand-50 text-brand-600",
  cyan: "border-brand-500/15 bg-brand-50 text-brand-600",
  green: "border-ok/15 bg-green-50 text-ok",
  slate: "border-line bg-ink-50 text-ink-600",
};

export function MetricTile({
  icon,
  label,
  tone = "slate",
  value,
}: MetricTileProps) {
  return (
    <div className="min-w-0 bg-white px-5 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500">{label}</p>
          <p className="mono-tabular truncate text-xl font-semibold leading-tight tracking-[-0.02em] text-ink-900">
            {value}
          </p>
        </div>
        {icon ? (
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${metricToneClass[tone]}`}
          >
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
      {actions ? (
        <div className="flex min-w-0 shrink-0 flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  const { copy } = useI18n();

  return (
    <div
      className="grid gap-2 p-4"
      aria-label={copy.common.loading}
      role="status"
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          className="h-12 animate-pulse rounded-lg bg-ink-50"
          key={index}
        />
      ))}
    </div>
  );
}

export interface TablePaginationLabels {
  range: string;
  pageSize: string;
  page: string;
  previous: string;
  next: string;
}

interface TablePaginationProps {
  labels: TablePaginationLabels;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageIndex: number;
  pageSize: number;
  pageSizeOptions?: number[];
  totalCount: number;
}

export function TablePagination({
  labels,
  onPageIndexChange,
  onPageSizeChange,
  pageIndex,
  pageSize,
  pageSizeOptions = [25, 50, 100],
  totalCount,
}: TablePaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = totalCount === 0 ? 0 : safePageIndex * pageSize + 1;
  const pageEnd = Math.min((safePageIndex + 1) * pageSize, totalCount);

  return (
    <div className="table-pagination flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-ink-600">
      <div className="mono-tabular">
        {labels.range
          .replace("{{start}}", String(pageStart))
          .replace("{{end}}", String(pageEnd))
          .replace("{{total}}", String(totalCount))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>{labels.pageSize}</span>
        <SelectControl
          wrapperClassName="w-24"
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          value={String(pageSize)}
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </SelectControl>
        <span className="mono-tabular inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-medium text-ink-600">
          {labels.page
            .replace("{{current}}", String(safePageIndex + 1))
            .replace("{{total}}", String(totalPages))}
        </span>
        <Button
          aria-label={labels.previous}
          className="w-9 px-0"
          disabled={safePageIndex === 0}
          icon={<ChevronLeft className="h-4 w-4" />}
          onClick={() => onPageIndexChange(Math.max(0, safePageIndex - 1))}
          size="sm"
          variant="ghost"
        />
        <Button
          aria-label={labels.next}
          className="w-9 px-0"
          disabled={safePageIndex >= totalPages - 1}
          icon={<ChevronRight className="h-4 w-4" />}
          onClick={() =>
            onPageIndexChange(Math.min(totalPages - 1, safePageIndex + 1))
          }
          size="sm"
          variant="ghost"
        />
      </div>
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
