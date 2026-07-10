import { MoreHorizontal } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/Button";

export type ActionMenuItem = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  restoreFocus?: boolean;
  separatorBefore?: boolean;
};

type MenuPosition = {
  left: number;
  top: number;
};

const menuViewportMargin = 8;
const menuTriggerGap = 6;

interface ActionMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  items: ActionMenuItem[];
  label: string;
  showLabel?: boolean;
}

export function ActionMenu({
  ariaLabel,
  disabled = false,
  items,
  label,
  showLabel = false,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuOnOpenRef = useRef<"first" | "last" | null>(null);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const placeMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 208;
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const preferredTop = rect.bottom + menuTriggerGap;
    const top =
      preferredTop + menuHeight > window.innerHeight - menuViewportMargin
        ? Math.max(
            menuViewportMargin,
            rect.top - menuHeight - menuTriggerGap,
          )
        : preferredTop;

    setPosition({
      left: Math.min(
        Math.max(menuViewportMargin, rect.right - menuWidth),
        window.innerWidth - menuWidth - menuViewportMargin,
      ),
      top,
    });
  };

  useLayoutEffect(() => {
    if (open) placeMenu();
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const handleViewportChange = () => closeMenu();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open]);

  const getEnabledItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );

  const moveFocusPastTrigger = (backward: boolean) => {
    const focusableElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        !menuRef.current?.contains(element) && element.getClientRects().length > 0,
    );
    const triggerIndex = triggerRef.current
      ? focusableElements.indexOf(triggerRef.current)
      : -1;
    const nextElement =
      triggerIndex >= 0
        ? focusableElements[triggerIndex + (backward ? -1 : 1)]
        : undefined;
    closeMenu();
    requestAnimationFrame(() => nextElement?.focus());
  };

  useEffect(() => {
    const focusTarget = focusMenuOnOpenRef.current;
    if (!open || !focusTarget) return;
    focusMenuOnOpenRef.current = null;
    requestAnimationFrame(() => {
      const buttons = getEnabledItems();
      buttons[focusTarget === "first" ? 0 : buttons.length - 1]?.focus();
    });
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = getEnabledItems();
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < buttons.length - 1 ? currentIndex + 1 : 0;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    } else if (event.key === "Tab") {
      event.preventDefault();
      moveFocusPastTrigger(event.shiftKey);
    }
    if (nextIndex !== null) {
      event.preventDefault();
      buttons[nextIndex]?.focus();
    }
  };

  const focusMenuItem = (target: "first" | "last") => {
    if (open) {
      const buttons = getEnabledItems();
      buttons[target === "first" ? 0 : buttons.length - 1]?.focus();
      return;
    }
    focusMenuOnOpenRef.current = target;
    setOpen(true);
  };

  return (
    <>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className={showLabel ? "" : "h-7 w-7 px-0"}
        disabled={disabled}
        icon={<MoreHorizontal className="h-4 w-4" />}
        onClick={(event) => {
          if (event.detail === 0) {
            focusMenuOnOpenRef.current = "first";
            setOpen(true);
            return;
          }
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusMenuItem("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusMenuItem("last");
          }
        }}
        ref={triggerRef}
        size={showLabel ? "sm" : "md"}
        variant={showLabel ? "secondary" : "ghost"}
      >
        {showLabel ? label : null}
      </Button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-label={ariaLabel}
              className="fixed z-50 max-h-80 w-52 overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-lg"
              onKeyDown={handleMenuKeyDown}
              ref={menuRef}
              role="menu"
              style={position}
            >
              {items.map((item) => (
                <div key={item.label} role="none">
                  {item.separatorBefore ? (
                    <div className="my-1 border-t border-line" role="separator" />
                  ) : null}
                  <button
                    className={`flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-40 ${
                      item.danger
                        ? "text-danger hover:bg-ink-50"
                        : "text-ink-700 hover:bg-ink-50 hover:text-ink-900"
                    }`}
                    disabled={item.disabled}
                    onClick={() => {
                      item.onSelect();
                      closeMenu(item.restoreFocus !== false);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
