import { X } from "lucide-react";
import { useEffect, useId } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/Button";
import { useI18n } from "@/i18n";

interface ModalProps {
  children: ReactNode;
  footer?: ReactNode;
  open: boolean;
  title: string;
  widthClass?: string;
  onClose: () => void;
}

export function Modal({
  children,
  footer,
  open,
  title,
  widthClass = "max-w-3xl",
  onClose,
}: ModalProps) {
  const titleId = useId();
  const { copy } = useI18n();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/35 p-4">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={`flex max-h-[88vh] w-full ${widthClass} flex-col overflow-hidden rounded-lg border border-line bg-white shadow-elevated`}
        role="dialog"
      >
        <header className="flex h-14 items-center justify-between border-b border-line bg-ink-50/70 px-5">
          <h2 className="text-base font-semibold text-ink-900" id={titleId}>
            {title}
          </h2>
          <Button
            aria-label={copy.common.close}
            className="h-8 w-8 px-0"
            icon={<X className="h-4 w-4" />}
            onClick={onClose}
            variant="ghost"
          />
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line bg-ink-50 px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
