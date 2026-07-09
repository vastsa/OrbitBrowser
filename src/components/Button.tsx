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
    "border-brand-600 bg-brand-600 text-white shadow-panel hover:bg-brand-500 focus-visible:ring-brand-500",
  secondary:
    "border-line bg-white/90 text-ink-900 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 focus-visible:ring-brand-500",
  danger:
    "border-danger bg-danger text-white shadow-panel hover:bg-red-700 focus-visible:ring-danger",
  ghost:
    "border-transparent bg-transparent text-ink-700 hover:bg-ink-50 hover:text-ink-900 focus-visible:ring-brand-500",
};

const sizeClass: Record<ButtonSize, string> = {
  md: "h-8 px-3 text-sm",
  sm: "h-7 px-2.5 text-xs",
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
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium transition-colors duration-200 ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 ${sizeClass[size]} ${variantClass[variant]} ${className}`}
      disabled={disabled}
      title={resolvedTitle}
      type={type}
      {...props}
    >
      {icon ? <span className="flex h-4 w-4 items-center">{icon}</span> : null}
      {children}
    </button>
  );
}
