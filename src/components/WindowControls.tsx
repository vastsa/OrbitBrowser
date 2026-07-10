import { Copy, Minus, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauriRuntime } from "@/lib/tauri";

interface WindowControlLabels {
  close: string;
  maximize: string;
  minimize: string;
  restore: string;
}

interface WindowControlsProps {
  labels: WindowControlLabels;
}

export function isWindowsTauriRuntime(): boolean {
  return (
    isTauriRuntime() &&
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Windows")
  );
}

export function WindowControls({ labels }: WindowControlsProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [isMaximized, setIsMaximized] = useState(false);

  const syncMaximizedState = useCallback(async () => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    setIsMaximized(maximized);
  }, [appWindow]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void syncMaximizedState();
    void appWindow
      .onResized(() => {
        if (!disposed) {
          void syncMaximizedState();
        }
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow, syncMaximizedState]);

  const toggleMaximize = () => {
    void appWindow
      .toggleMaximize()
      .then(syncMaximizedState)
      .catch(() => undefined);
  };

  return (
    <div className="window-controls fixed right-0 top-0 z-30 flex">
      <button
        aria-label={labels.minimize}
        className="window-control"
        onClick={() => void appWindow.minimize().catch(() => undefined)}
        title={labels.minimize}
        type="button"
      >
        <Minus aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
      </button>
      <button
        aria-label={isMaximized ? labels.restore : labels.maximize}
        className="window-control"
        onClick={toggleMaximize}
        title={isMaximized ? labels.restore : labels.maximize}
        type="button"
      >
        {isMaximized ? (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
        ) : (
          <Square aria-hidden="true" className="h-3 w-3" strokeWidth={1.5} />
        )}
      </button>
      <button
        aria-label={labels.close}
        className="window-control window-control-close"
        onClick={() => void appWindow.close().catch(() => undefined)}
        title={labels.close}
        type="button"
      >
        <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
