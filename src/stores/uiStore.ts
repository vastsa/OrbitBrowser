import { create } from "zustand";

import type { TaskRunStatus } from "@/types/domain";

export type AppLanguage = "zh-CN" | "en-US";

const languageStorageKey = "orbit-browser.language";

function initialLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  const stored = window.localStorage.getItem(languageStorageKey);
  return stored === "en-US" || stored === "zh-CN" ? stored : "zh-CN";
}

interface UiState {
  appLanguage: AppLanguage;
  environmentSearch: string;
  environmentGroup: string;
  environmentTag: string;
  runStatus: TaskRunStatus | "all";
  setAppLanguage: (value: AppLanguage) => void;
  setEnvironmentSearch: (value: string) => void;
  setEnvironmentGroup: (value: string) => void;
  setEnvironmentTag: (value: string) => void;
  setRunStatus: (value: TaskRunStatus | "all") => void;
}

export const useUiStore = create<UiState>((set) => ({
  appLanguage: initialLanguage(),
  environmentSearch: "",
  environmentGroup: "",
  environmentTag: "",
  runStatus: "all",
  setAppLanguage: (appLanguage) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(languageStorageKey, appLanguage);
    }
    set({ appLanguage });
  },
  setEnvironmentSearch: (environmentSearch) => set({ environmentSearch }),
  setEnvironmentGroup: (environmentGroup) => set({ environmentGroup }),
  setEnvironmentTag: (environmentTag) => set({ environmentTag }),
  setRunStatus: (runStatus) => set({ runStatus }),
}));
