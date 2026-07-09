import {
  Bot,
  ClipboardList,
  History,
  Radio,
  Settings,
  SquareStack,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import appLogo from "@/assets/app-logo.png";
import appLogoDark from "@/assets/app-logo-dark.png";
import { useI18n } from "@/i18n";
import { useUiStore } from "@/stores/uiStore";

export function Layout() {
  const location = useLocation();
  const { copy, language } = useI18n();
  const headerActions = useUiStore((state) => state.headerActions);
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
  }, [language]);

  return (
    <div className="app-shell h-screen min-w-[1280px] overflow-hidden text-ink-900">
      <aside
        className="app-sidebar fixed inset-y-0 left-0 z-20 flex w-56 flex-col overflow-hidden border-r shadow-elevated"
        data-tauri-drag-region="deep"
      >
        <div className="app-sidebar-bg app-sidebar-bg-light pointer-events-none absolute inset-0" />
        <div className="app-sidebar-bg app-sidebar-bg-dark pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-top-light pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-top-dark pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-bottom-light pointer-events-none absolute -left-16 bottom-10 h-40 w-40 rounded-full blur-3xl" />
        <div className="app-sidebar-glow app-sidebar-glow-bottom-dark pointer-events-none absolute -left-16 bottom-10 h-40 w-40 rounded-full blur-3xl" />

        <div className="relative flex h-20 items-center gap-3 px-5">
          <picture className="h-10 w-10 shrink-0">
            <source media="(prefers-color-scheme: dark)" srcSet={appLogoDark} />
            <img
              alt="Orbit Browser"
              className="h-10 w-10 rounded-xl object-cover shadow-panel ring-1 ring-white/20"
              src={appLogo}
            />
          </picture>
          <div className="min-w-0">
            <p className="app-sidebar-brand-title truncate text-sm font-bold tracking-tight">Orbit Browser</p>
            <p className="app-sidebar-brand-subtitle mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[0.16em]">Automation studio</p>
          </div>
        </div>

        <div className="relative px-5 pb-2 pt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400">
          Workspace
        </div>
        <nav aria-label="Primary" className="relative grid gap-1 px-3 animate-soft-enter-left">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) =>
                  `app-menu-item group relative flex cursor-pointer items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                    isActive
                      ? "app-menu-item-active shadow-panel"
                      : "app-menu-item-idle hover:shadow-panel"
                  }`
                }
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`absolute inset-y-2 left-0 w-1 rounded-r-full transition-opacity duration-200 ${
                        isActive ? "app-menu-active-bar opacity-100" : "app-menu-hover-bar opacity-0 group-hover:opacity-60"
                      }`}
                    />
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 ${
                        isActive
                          ? "app-menu-icon-active shadow-panel"
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
        <div className="app-sidebar-status relative mx-3 mt-auto mb-4 rounded-xl border p-3">
          <div className="app-sidebar-status-title flex items-center gap-2 text-xs font-medium">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-300 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-300" />
            </span>
            运行时已就绪
          </div>
          <p className="app-sidebar-status-copy mt-1.5 text-[11px] leading-4">本地 Profile 与任务队列已连接。</p>
        </div>
      </aside>
      <main className="flex h-screen min-h-0 flex-col pl-56">
        <header
          className="app-header z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b px-6 transition-colors duration-200 ease-out"
          data-tauri-drag-region="deep"
        >
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-[-0.025em] text-ink-900">{page.title}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex items-center gap-2 border-r border-line pr-4 text-xs text-ink-500">
              <Radio className="h-3.5 w-3.5 text-ok" />
              <span>系统在线</span>
            </div>
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
