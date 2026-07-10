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
    <div
      className="modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={`modal-panel flex max-h-[88vh] w-full ${widthClass} flex-col overflow-hidden rounded-xl border border-line bg-white shadow-panel`}
        role="dialog"
      >
        <header className="flex min-h-14 items-center justify-between border-b border-line bg-white px-5 py-2">
          <h2 className="text-base font-semibold text-ink-900" id={titleId}>
            {title}
          </h2>
          <Button
            aria-label={copy.common.close}
            autoFocus
            className="w-9 px-0"
            icon={<X className="h-4 w-4" />}
            onClick={onClose}
            size="sm"
            variant="ghost"
          />
        </header>
        <div className="scroll-panel px-5 py-5">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line bg-white px-5 py-4">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
