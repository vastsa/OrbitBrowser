import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  size?: ButtonSize;
}

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "border-brand-600 bg-brand-600 text-white hover:border-brand-700 hover:bg-brand-700 focus-visible:ring-brand-500/30",
  secondary:
    "border-line bg-white text-ink-900 hover:border-ink-300 hover:bg-ink-50 focus-visible:ring-brand-500/30",
  danger:
    "border-danger bg-danger text-white hover:border-red-700 hover:bg-red-700 focus-visible:ring-danger/30 disabled:border-line disabled:bg-transparent disabled:text-ink-400",
  ghost:
    "border-transparent bg-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-900 focus-visible:ring-brand-500/30",
};

const sizeClass: Record<ButtonSize, string> = {
  md: "h-9 px-3.5 text-sm",
  sm: "h-8 px-3 text-xs",
};

export function Button({
  children,
  className = "",
  disabled,
  icon,
  size = "md",
  title,
  variant = "secondary",
  type = "button",
  ...props
}: ButtonProps) {
  const ariaLabel = props["aria-label"];
  const resolvedTitle =
    title ?? (typeof ariaLabel === "string" ? ariaLabel : undefined);

  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40 ${sizeClass[size]} ${variantClass[variant]} ${className}`}
      disabled={disabled}
      title={resolvedTitle}
      type={type}
      {...props}
    >
      {icon ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
