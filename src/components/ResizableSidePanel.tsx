import { GripHorizontal } from "lucide-react";
import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export const MIN_SIDE_PANEL_HEIGHT = 120;
export const COLLAPSED_SIDE_PANEL_HEIGHT = 48;
export const SIDE_PANEL_CHROME_HEIGHT = 54; // header 44 + drag handle 10

export function clampSidePanelHeight(
  value: number,
  maxHeight = Number.POSITIVE_INFINITY,
  minHeight = MIN_SIDE_PANEL_HEIGHT,
) {
  return Math.min(maxHeight, Math.max(minHeight, value));
}

type ResizableSidePanelProps = {
  actions?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  fillRemaining?: boolean;
  height: number;
  icon?: ReactNode;
  maxHeight: number;
  onHeightChange: (height: number) => void;
  onPreferredHeightChange?: (height: number) => void;
  onToggle: () => void;
  title: string;
  subtitle?: string;
};

export function ResizableSidePanel({
  actions,
  children,
  collapsed,
  fillRemaining = false,
  height,
  icon,
  maxHeight,
  onHeightChange,
  onPreferredHeightChange,
  onToggle,
  title,
  subtitle,
}: ResizableSidePanelProps) {
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const lastPreferredRef = useRef(0);
  const onPreferredHeightChangeRef = useRef(onPreferredHeightChange);
  onPreferredHeightChangeRef.current = onPreferredHeightChange;

  useEffect(() => {
    if (collapsed) {
      return;
    }
    const node = contentRef.current;
    if (!node) {
      return;
    }

    const report = () => {
      const preferred = Math.ceil(node.scrollHeight) + SIDE_PANEL_CHROME_HEIGHT;
      // 忽略亚像素抖动，避免父级反复 setState 冲掉编辑器选区
      if (Math.abs(preferred - lastPreferredRef.current) < 4) {
        return;
      }
      lastPreferredRef.current = preferred;
      onPreferredHeightChangeRef.current?.(preferred);
    };

    report();
    const observer = new ResizeObserver(() => {
      report();
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [collapsed]);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (collapsed) return;
    event.preventDefault();
    dragStateRef.current = { startY: event.clientY, startHeight: height };

    const resize = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      onHeightChange(
        clampSidePanelHeight(
          state.startHeight + moveEvent.clientY - state.startY,
          maxHeight,
        ),
      );
    };

    const stopResize = () => {
      dragStateRef.current = null;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  return (
    <section
      className={`panel relative flex min-h-0 flex-col overflow-hidden shadow-none ${
        fillRemaining && !collapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      style={
        fillRemaining && !collapsed
          ? { minHeight: Math.min(height, maxHeight) }
          : {
              height: collapsed ? COLLAPSED_SIDE_PANEL_HEIGHT : height,
            }
      }
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
        <button
          aria-expanded={!collapsed}
          className="control-focus flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm font-semibold text-ink-900 hover:text-brand-600"
          onClick={onToggle}
          type="button"
        >
          {icon}
          <span className="min-w-0 truncate">{title}</span>
          {subtitle && !collapsed ? (
            <span className="hidden min-w-0 truncate text-xs font-normal text-ink-500 xl:inline">
              {subtitle}
            </span>
          ) : null}
        </button>
        {actions && !collapsed ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>

      {!collapsed ? (
        <div
          className="scroll-panel min-h-0 min-w-0 flex-1 overflow-x-hidden p-3.5"
          ref={contentRef}
        >
          {children}
        </div>
      ) : null}

      {!collapsed ? (
        <button
          aria-label="Resize panel"
          className="control-focus flex h-2.5 shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-ink-50 text-ink-400 transition-colors hover:text-brand-600"
          onPointerDown={startResize}
          type="button"
        >
          <GripHorizontal className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </section>
  );
}
