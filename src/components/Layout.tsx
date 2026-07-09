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
  }, [language]);

  return (
    <div className="app-shell h-screen min-w-[1280px] overflow-hidden text-ink-900">
      <aside className="app-sidebar fixed inset-y-0 left-0 z-20 w-56 overflow-hidden border-r text-ink-900 shadow-elevated backdrop-blur-xl">
        <div className="app-sidebar-bg app-sidebar-bg-light pointer-events-none absolute inset-0" />
        <div className="app-sidebar-bg app-sidebar-bg-dark pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-top-light pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-top-dark pointer-events-none absolute inset-0" />
        <div className="app-sidebar-glow app-sidebar-glow-bottom-light pointer-events-none absolute -left-16 bottom-10 h-40 w-40 rounded-full blur-3xl" />
        <div className="app-sidebar-glow app-sidebar-glow-bottom-dark pointer-events-none absolute -left-16 bottom-10 h-40 w-40 rounded-full blur-3xl" />

        <div className="relative flex h-16 items-center gap-3 px-4">
          <picture className="h-9 w-9 shrink-0">
            <source media="(prefers-color-scheme: dark)" srcSet={appLogoDark} />
            <img
              alt="Orbit Browser"
              className="h-9 w-9 rounded-2xl object-cover shadow-panel ring-1 ring-white/80"
              src={appLogo}
            />
          </picture>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold tracking-tight text-ink-900">Orbit Browser</p>
            <p className="mt-0.5 truncate text-[11px] font-medium text-ink-500">本地隔离浏览器</p>
          </div>
        </div>

        <nav aria-label="Primary" className="relative grid gap-1.5 px-3 py-2 animate-soft-enter-left">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) =>
                  `app-menu-item group relative flex cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border px-3 py-2.5 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? "app-menu-item-active text-brand-700 shadow-panel"
                      : "app-menu-item-idle text-ink-600 hover:text-ink-900 hover:shadow-panel"
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
                          ? "app-menu-icon-active text-white shadow-panel"
                          : "app-menu-icon-idle text-ink-500 group-hover:text-brand-700"
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
      </aside>
      <main className="flex h-screen min-h-0 flex-col pl-56">
        <header className="app-header z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b px-6 backdrop-blur-xl transition-colors duration-200 ease-out">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">{page.title}</h1>
          </div>
          {headerActions ? (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              {headerActions}
            </div>
          ) : null}
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-[1480px] flex-1 overflow-hidden px-5 py-3">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
