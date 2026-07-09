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
      <aside className="fixed inset-y-0 left-0 z-20 w-[12rem] border-r border-white/70 bg-white/80 text-ink-900 shadow-elevated backdrop-blur-xl">
        <div className="flex h-14 items-center gap-2.5 px-3">
          <img
            alt="Orbit Browser"
            className="h-8 w-8 shrink-0 rounded-xl object-cover shadow-panel"
            src={appLogo}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-ink-900">Orbit Browser</p>
          </div>
        </div>
        <nav className="grid gap-1 px-1.5 py-2">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) =>
                  `flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? "border border-brand-100 bg-brand-50 text-brand-700 shadow-panel"
                      : "border border-transparent text-ink-700 hover:border-line hover:bg-white hover:text-ink-900"
                  }`
                }
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{item.label}</span>
                </span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <main className="flex h-screen min-h-0 flex-col pl-[12rem]">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/70 bg-white/75 px-6 backdrop-blur-xl">
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
