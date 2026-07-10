import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";

interface FieldShellProps {
  children: ReactNode;
  hint?: string;
  label: string;
  required?: boolean;
}

function FieldShell({ children, hint, label, required }: FieldShellProps) {
  return (
    <label className="grid min-w-0 content-start gap-1.5 text-sm">
      <span className="font-medium text-ink-700">
        {label}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  "form-control control-focus h-10 w-full min-w-0 rounded-lg border border-line bg-white px-3.5 text-sm text-ink-900 placeholder:text-ink-400 enabled:hover:border-ink-300";

const selectControlClass =
  "form-select-control control-focus h-10 w-full min-w-0 appearance-none rounded-lg border py-0 pr-10 text-sm enabled:hover:border-ink-300";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  hint?: string;
  label: string;
  requiredMark?: boolean;
}

export function TextField({
  className = "",
  hint,
  label,
  requiredMark,
  ...props
}: TextFieldProps) {
  return (
    <FieldShell hint={hint} label={label} required={requiredMark}>
      <input {...props} className={`${controlClass} ${className}`} />
    </FieldShell>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  hint?: string;
  label: string;
  requiredMark?: boolean;
}

interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  leadingIcon?: ReactNode;
  wrapperClassName?: string;
}

export function SelectControl({
  children,
  className = "",
  leadingIcon,
  wrapperClassName = "",
  ...props
}: SelectControlProps) {
  return (
    <span className={`relative block min-w-0 ${wrapperClassName}`}>
      {leadingIcon ? (
        <span className="pointer-events-none absolute left-3.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-ink-500">
          {leadingIcon}
        </span>
      ) : null}
      <select
        className={`${selectControlClass} ${leadingIcon ? "pl-10" : "pl-3.5"} ${className}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500"
      />
    </span>
  );
}

export function SelectField({
  children,
  hint,
  label,
  requiredMark,
  ...props
}: SelectFieldProps) {
  return (
    <FieldShell hint={hint} label={label} required={requiredMark}>
      <SelectControl {...props}>{children}</SelectControl>
    </FieldShell>
  );
}

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  hint?: string;
  label: string;
  requiredMark?: boolean;
}

export function TextareaField({
  className = "",
  hint,
  label,
  requiredMark,
  ...props
}: TextareaFieldProps) {
  return (
    <FieldShell hint={hint} label={label} required={requiredMark}>
      <textarea
        {...props}
        className={`${controlClass} min-h-24 resize-y py-2.5 leading-5 ${className}`}
      />
    </FieldShell>
  );
}
