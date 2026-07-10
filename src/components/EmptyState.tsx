import type { ReactNode } from "react";

interface EmptyStateProps {
  action?: ReactNode;
  className?: string;
  description?: string;
  icon?: ReactNode;
  title: string;
}

export function EmptyState({
  action,
  className = "",
  description,
  icon,
  title,
}: EmptyStateProps) {
  return (
    <div
      className={`flex min-h-56 flex-col items-center justify-center gap-4 rounded-xl border border-line bg-white px-8 py-12 text-center ${className}`}
    >
      {icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-ink-50 text-ink-500">
          {icon}
        </div>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {description ? (
          <p className="mt-1.5 max-w-md text-sm leading-6 text-ink-500">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
