import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { queryClient } from "@/app/queryClient";
import { Layout } from "@/components/Layout";
import { isTauriRuntime } from "@/lib/tauri";
import { AgentPage } from "@/pages/AgentPage";
import { DiagnosticsPage } from "@/pages/DiagnosticsPage";
import { EnvironmentsPage } from "@/pages/EnvironmentsPage";
import { RunsPage } from "@/pages/RunsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TaskDetailPage, TasksPage } from "@/pages/TasksPage";

export function App() {
  useEffect(() => {
    const splash = document.getElementById("startup-splash");
    if (!splash) {
      return;
    }

    const startupWindow = window as Window & {
      __ORBIT_STARTUP_AT__?: number;
    };
    const startedAt = startupWindow.__ORBIT_STARTUP_AT__ ?? performance.now();
    const minimumVisibleDuration = 620;
    const elapsed = performance.now() - startedAt;
    let removeTimer = 0;
    let leaveTimer = 0;
    let frame = 0;

    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        leaveTimer = window.setTimeout(() => {
          splash.classList.add("is-leaving");
          removeTimer = window.setTimeout(() => splash.remove(), 300);
        }, Math.max(0, minimumVisibleDuration - elapsed));
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncWindowBackground = (isDark: boolean) => {
      const color: [number, number, number, number] = isDark
        ? [20, 20, 22, 255]
        : [244, 245, 247, 255];
      void getCurrentWindow().setBackgroundColor(color).catch(() => undefined);
    };
    const handleColorSchemeChange = (event: MediaQueryListEvent) => {
      syncWindowBackground(event.matches);
    };

    syncWindowBackground(colorScheme.matches);
    colorScheme.addEventListener("change", handleColorSchemeChange);

    return () => {
      colorScheme.removeEventListener("change", handleColorSchemeChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const refreshRuntime = () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["run-logs"] });
      void queryClient.invalidateQueries({ queryKey: ["run-artifacts"] });
      void queryClient.invalidateQueries({ queryKey: ["environment-statuses"] });
      void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
    };

    void Promise.all([
      listen("run_status_changed", refreshRuntime),
      listen("run_log_appended", refreshRuntime),
      listen("run_artifact_created", refreshRuntime),
      listen("batch_progress_changed", refreshRuntime),
      listen("environment_status_changed", refreshRuntime),
      listen("diagnostic_warning", refreshRuntime),
    ])
      .then((listeners) => {
        if (disposed) {
          listeners.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners.push(...listeners);
      })
      .catch(() => {
        // Browser preview mode does not expose the Tauri event runtime.
      });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route element={<Layout />} path="/">
            <Route element={<Navigate replace to="/environments" />} index />
            <Route element={<EnvironmentsPage />} path="environments" />
            <Route element={<TasksPage />} path="tasks" />
            <Route element={<TaskDetailPage />} path="tasks/new" />
            <Route element={<TaskDetailPage />} path="tasks/:taskId" />
            <Route element={<RunsPage />} path="runs" />
            <Route element={<AgentPage />} path="agent" />
            <Route element={<SettingsPage />} path="settings" />
            <Route element={<DiagnosticsPage />} path="diagnostics" />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
