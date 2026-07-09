import { create } from "zustand";

import type {
  AgentHistorySession,
  AgentRecordingSummary,
  BrowserContextSnapshot,
} from "@/types/domain";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentChatMessage = {
  id: string;
  role: Exclude<AgentRole, "system" | "tool"> | "tool";
  content: string;
  collapsed?: boolean;
  toolName?: string;
};

export type AgentOpenAIMessage = {
  role: AgentRole;
  content?: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: AgentToolCall[];
};

type AgentRuntimeState = {
  messages: AgentChatMessage[];
  apiMessages: AgentOpenAIMessage[];
  isRunning: boolean;
  error: string | null;
  context: BrowserContextSnapshot | null;
  recording: AgentRecordingSummary | null;
  sessions: AgentHistorySession[];
  isHistoryLoading: boolean;
};

type AgentRuntimeActions = {
  appendMessage: (message: AgentChatMessage) => void;
  finalizeTrailingEmptyAssistant: (content: string) => void;
  patchMessage: (
    messageId: string,
    patcher: (message: AgentChatMessage) => AgentChatMessage,
  ) => void;
  resetConversation: () => void;
  setApiMessages: (messages: AgentOpenAIMessage[]) => void;
  setContext: (context: BrowserContextSnapshot | null) => void;
  setError: (error: string | null) => void;
  setIsHistoryLoading: (isHistoryLoading: boolean) => void;
  setIsRunning: (isRunning: boolean) => void;
  setMessages: (messages: AgentChatMessage[]) => void;
  setRecording: (recording: AgentRecordingSummary | null) => void;
  setSessions: (
    updater:
      | AgentHistorySession[]
      | ((sessions: AgentHistorySession[]) => AgentHistorySession[]),
  ) => void;
  toggleToolMessage: (messageId: string) => void;
};

export const useAgentRuntimeStore = create<AgentRuntimeState & AgentRuntimeActions>((set) => ({
  messages: [],
  apiMessages: [],
  isRunning: false,
  error: null,
  context: null,
  recording: null,
  sessions: [],
  isHistoryLoading: false,
  appendMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  finalizeTrailingEmptyAssistant: (content) =>
    set((state) => {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage?.role === "assistant" && !lastMessage.content.trim()) {
        return {
          messages: [
            ...state.messages.slice(0, -1),
            { ...lastMessage, content },
          ],
        };
      }
      return state;
    }),
  patchMessage: (messageId, patcher) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? patcher(message) : message,
      ),
    })),
  resetConversation: () =>
    set({ messages: [], apiMessages: [], error: null, context: null }),
  setApiMessages: (apiMessages) => set({ apiMessages }),
  setContext: (context) => set({ context }),
  setError: (error) => set({ error }),
  setIsHistoryLoading: (isHistoryLoading) => set({ isHistoryLoading }),
  setIsRunning: (isRunning) => set({ isRunning }),
  setMessages: (messages) => set({ messages }),
  setRecording: (recording) => set({ recording }),
  setSessions: (updater) =>
    set((state) => ({
      sessions:
        typeof updater === "function"
          ? updater(state.sessions)
          : updater,
    })),
  toggleToolMessage: (messageId) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? { ...message, collapsed: !message.collapsed }
          : message,
      ),
    })),
}));

export const agentRuntimeRefs: {
  abort: AbortController | null;
  charQueue: Array<{ id: string; char: string }>;
  environmentId: string;
  runId: number;
  sessionId: string;
  stopped: boolean;
  riskApprovals: Set<string>;
} = {
  abort: null,
  charQueue: [],
  environmentId: "",
  runId: 0,
  sessionId: "",
  stopped: false,
  riskApprovals: new Set(),
};
