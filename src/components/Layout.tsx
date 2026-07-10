import {
  Bot,
  ClipboardList,
  History,
  Settings,
  SquareStack,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import appLogo from "@/assets/app-logo.png";
import appLogoDark from "@/assets/app-logo-dark.png";
import {
  isWindowsTauriRuntime,
  WindowControls,
} from "@/components/WindowControls";
import { useI18n } from "@/i18n";
import { useUiStore } from "@/stores/uiStore";

export function Layout() {
  const location = useLocation();
  const { copy, language } = useI18n();
  const headerActions = useUiStore((state) => state.headerActions);
  const isWindows = isWindowsTauriRuntime();
  const navigation = useMemo(
    () => [
      { to: "/environments", label: copy.layout.nav.environments, icon: SquareStack },
      { to: "/tasks", label: copy.layout.nav.tasks, icon: ClipboardList },
      { to: "/runs", label: copy.layout.nav.runs, icon: History },
      { to: "/agent", label: copy.layout.nav.agent, icon: Bot },
      { to: "/settings", label: copy.layout.nav.settings, icon: Settings },
    ],
    [copy],
  );
  const titleMap = useMemo<Record<string, { title: string }>>(
    () => ({
      "/environments": copy.layout.pages.environments,
      "/tasks": copy.layout.pages.tasks,
      "/runs": copy.layout.pages.runs,
      "/agent": copy.layout.pages.agent,
      "/settings": copy.layout.pages.settings,
      "/diagnostics": copy.layout.pages.diagnostics,
    }),
    [copy],
  );
  const sectionPath = navigation
    .filter((item) => item.to !== "/")
    .find((item) => location.pathname.startsWith(`${item.to}/`))?.to;
  const page =
    titleMap[location.pathname] ??
    (sectionPath ? titleMap[sectionPath] : undefined) ??
    copy.layout.pages.fallback;

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.classList.toggle(
      "platform-macos",
      navigator.userAgent.includes("Mac"),
    );
    document.documentElement.classList.toggle("platform-windows", isWindows);

    return () => {
      document.documentElement.classList.remove(
        "platform-macos",
        "platform-windows",
      );
    };
  }, [isWindows, language]);

  return (
    <div className="app-shell h-screen min-w-[1280px] overflow-hidden text-ink-900">
      {isWindows ? <WindowControls labels={copy.layout.windowControls} /> : null}
      <aside
        className="app-sidebar fixed inset-y-0 left-0 z-20 flex w-56 flex-col overflow-hidden border-r"
        data-tauri-drag-region="deep"
      >
        <div className="relative flex h-20 items-center gap-3 px-5">
          <picture className="h-9 w-9 shrink-0">
            <source media="(prefers-color-scheme: dark)" srcSet={appLogoDark} />
            <img
              alt="Orbit Browser"
              className="h-9 w-9 rounded-[10px] object-cover"
              src={appLogo}
            />
          </picture>
          <div className="min-w-0">
            <p className="app-sidebar-brand-title truncate text-sm font-semibold tracking-tight">Orbit Browser</p>
            <p className="app-sidebar-brand-subtitle mt-0.5 truncate text-[9px] font-medium uppercase tracking-[0.12em]">Automation studio</p>
          </div>
        </div>

        <nav aria-label="Primary" className="relative grid gap-1 px-3 pt-3">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) =>
                  `app-menu-item group relative flex cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? "app-menu-item-active"
                      : "app-menu-item-idle"
                  }`
                }
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center transition-colors duration-150 ${
                        isActive
                          ? "app-menu-icon-active"
                          : "app-menu-icon-idle"
                      }`}
                    >
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="app-sidebar-status relative mx-5 mb-4 mt-auto border-x-0 border-b-0 border-t px-0 pt-4">
          <div className="app-sidebar-status-title flex items-center gap-2 text-xs font-medium">
            <span className="h-2 w-2 rounded-full bg-ok" />
            运行时已就绪
          </div>
          <p className="app-sidebar-status-copy mt-1.5 text-[11px] leading-4">本地 Profile 与任务队列已连接。</p>
        </div>
      </aside>
      <main className="flex h-screen min-h-0 flex-col pl-56">
        <header
          className={`app-header z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b px-6 transition-colors duration-200 ease-out ${
            isWindows ? "app-header-windows" : ""
          }`}
          data-tauri-drag-region="deep"
        >
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">{page.title}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-4">
            {headerActions ? (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              {headerActions}
            </div>
            ) : null}
          </div>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-[1480px] flex-1 overflow-hidden px-5 py-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
