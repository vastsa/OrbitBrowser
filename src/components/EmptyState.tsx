import type { ReactNode } from "react";

interface EmptyStateProps {
  action?: ReactNode;
  description?: string;
  icon?: ReactNode;
  title: string;
}

export function EmptyState({
  action,
  description,
  icon,
  title,
}: EmptyStateProps) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-300 bg-white/75 px-6 py-10 text-center">
      {icon ? (
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          {icon}
        </div>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {description ? (
          <p className="mt-1 max-w-md text-sm text-ink-500">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
