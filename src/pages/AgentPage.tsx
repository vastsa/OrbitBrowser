import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  CircleStop,
  FileSearch,
  GripHorizontal,
  MessageSquareText,
  Loader2,
  Network,
  Plus,
  Radio,
  Send,
  Settings2,
  SquareTerminal,
  Trash2,
  User,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { SelectControl } from "@/components/FormField";
import { Modal } from "@/components/Modal";

import { errorMessage, formatDateTime } from "@/lib/format";
import { browserApi } from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { agentRuntimeRefs, useAgentRuntimeStore, type AgentChatMessage, type AgentOpenAIMessage, type AgentToolCall } from "@/stores/agentRuntimeStore";
import { useUiStore } from "@/stores/uiStore";
import type {
  AgentArtifactRef,
  AgentHistorySession,
  BrowserContextSnapshot,
  Environment,
  Settings,
} from "@/types/domain";

const MarkdownMessageRenderer = lazy(() =>
  import("@/components/MarkdownMessage").then((module) => ({
    default: module.MarkdownMessage,
  })),
);

type ChatMessage = AgentChatMessage;
type OpenAIMessage = AgentOpenAIMessage;
type ToolCall = AgentToolCall;

function createAbortError() {
  return new DOMException("AI conversation stopped", "AbortError");
}

function isAbortError(err: unknown) {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

const tools = [
  {
    type: "function",
    function: {
      name: "browser_context",
      description: "读取当前环境浏览器页面上下文，包括 URL、标题、可见文本、可交互元素、控制台和网络摘要。",
      parameters: {
        type: "object",
        properties: {
          include_screenshot: { type: "boolean", default: false },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_goto",
      description: "让当前环境浏览器打开指定 URL。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "点击当前页面中的 CSS selector。",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "向 CSS selector 对应输入框写入文本。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_wait",
      description: "等待 CSS selector 出现，或等待指定毫秒数。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          milliseconds: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description: "在当前页面执行 JavaScript 表达式并返回 JSON 可序列化结果。",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_find_elements",
      description: "按可见文本、label、placeholder、aria-label 或 selector 关键词查找页面元素，返回候选 selector。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_select_option",
      description: "为 select 元素选择 option。可按 value、label 或可见文本匹配。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          value: { type: "string" },
          label: { type: "string" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recording_start",
      description: "开始记录当前环境浏览器的网络请求、响应和页面资源事件。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recording_stop",
      description: "停止记录并返回本次浏览器网络与资源事件摘要。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recording_status",
      description: "读取当前浏览器录制状态和已记录事件。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_read_artifact",
      description: "按 artifact_id 读取此前浏览器工具保存的完整本地结果片段。仅在摘要不足以判断下一步时调用。",
      parameters: {
        type: "object",
        properties: {
          artifact_id: { type: "string" },
          max_chars: { type: "integer", minimum: 1000, maximum: 80000 },
        },
        required: ["artifact_id"],
      },
    },
  },
] as const;

function buildSystemPrompt(environment?: Environment) {
  return `你是 Orbit Browser 的 AI Agent，负责用对话方式协助用户操作本地隔离浏览器环境。\n\n规则：\n1. 你可以通过工具读取页面上下文、打开 URL、点击、输入、等待、执行 JS、开始/停止录制网络资源。\n2. 操作浏览器前必须优先读取上下文，必要时解释你下一步会做什么。\n3. selector 必须来自 browser_context 返回的 interactive_elements.selector，或来自 browser_evaluate 实时查询到的 DOM 结果。严禁使用“已知 selector”、经验 selector、猜测 selector。\n4. 如果没有目标元素或 selector 不确定，不要继续猜测；必须再次调用 browser_context，或用 browser_evaluate 查询页面 DOM 后再操作。\n5. 工具调用失败时，先读取最新上下文再恢复，不要重复使用失败 selector。\n6. 浏览器操作后总结结果，若失败，给出可恢复建议。\n7. 浏览器工具结果可能包含 artifacts 引用。常规任务优先使用摘要中的 visible_text 与 interactive_elements；只有摘要不足时才调用 agent_read_artifact 读取完整片段。
8. 回复使用简体中文，简洁专业。\n\n当前环境：${environment ? `${environment.name} (${environment.id})` : "未选择"}`;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function safeJsonParse(value: string) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

const MODEL_VISIBLE_TEXT_LIMIT = 3000;
const MODEL_HTML_EXCERPT_LIMIT = 0;
const MODEL_INTERACTIVE_ELEMENTS_LIMIT = 80;
const MODEL_CONSOLE_ENTRIES_LIMIT = 10;
const MODEL_NETWORK_ENTRIES_LIMIT = 20;
const MODEL_GENERIC_TEXT_LIMIT = 12000;

function truncateText(value: unknown, maxLength: number) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactBrowserContextForModel(value: Record<string, unknown>) {
  const htmlExcerpt = typeof value.html_excerpt === "string" ? value.html_excerpt : "";
  const screenshotBase64 = typeof value.screenshot_base64 === "string" ? value.screenshot_base64 : "";
  const interactiveElements = Array.isArray(value.interactive_elements)
    ? value.interactive_elements.slice(0, MODEL_INTERACTIVE_ELEMENTS_LIMIT).map((item) => {
        if (!isRecord(item)) return item;
        return {
          kind: truncateText(item.kind, 40),
          label: truncateText(item.label, 160),
          selector: truncateText(item.selector, 240),
        };
      })
    : [];
  const consoleEntries = Array.isArray(value.console_entries)
    ? value.console_entries.slice(-MODEL_CONSOLE_ENTRIES_LIMIT).map((item) => {
        if (!isRecord(item)) return item;
        return {
          level: truncateText(item.level, 40),
          message: truncateText(item.message, 500),
        };
      })
    : [];
  const networkEntries = Array.isArray(value.network_entries)
    ? value.network_entries.slice(-MODEL_NETWORK_ENTRIES_LIMIT).map((item) => {
        if (!isRecord(item)) return item;
        return {
          method: truncateText(item.method, 20),
          url: truncateText(item.url, 500),
          status: item.status,
        };
      })
    : [];

  return {
    url: value.url,
    title: value.title,
    visible_text: truncateText(value.visible_text, MODEL_VISIBLE_TEXT_LIMIT),
    interactive_elements: interactiveElements,
    console_entries: consoleEntries,
    network_entries: networkEntries,
    omitted: {
      html_excerpt_chars: htmlExcerpt.length,
      html_excerpt_included_chars: MODEL_HTML_EXCERPT_LIMIT,
      screenshot_base64_chars: screenshotBase64.length,
      interactive_elements_total: Array.isArray(value.interactive_elements)
        ? value.interactive_elements.length
        : interactiveElements.length,
      console_entries_total: Array.isArray(value.console_entries)
        ? value.console_entries.length
        : consoleEntries.length,
      network_entries_total: Array.isArray(value.network_entries)
        ? value.network_entries.length
        : networkEntries.length,
    },
  };
}

function shouldPersistToolArtifact(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    "html_excerpt" in value ||
    "screenshot_base64" in value ||
    "visible_text" in value ||
    "interactive_elements" in value
  );
}

async function saveToolArtifactBestEffort(
  environmentId: string,
  sessionId: string,
  toolName: string,
  toolMessageId: string,
  value: unknown,
) {
  if (!shouldPersistToolArtifact(value)) return { artifact: null, warning: null };

  try {
    const artifact = await browserApi.saveAgentArtifact({
      environment_id: environmentId,
      session_id: sessionId,
      artifact_id: `${toolName}_${toolMessageId}`,
      kind: "tool_result",
      content: value,
    });
    return { artifact, warning: null };
  } catch (err) {
    return {
      artifact: null,
      warning: `Artifact 保存失败：${errorMessage(err)}`,
    };
  }
}

type ToolResultEnvelope = {
  ok: boolean;
  tool: string;
  summary?: unknown;
  result?: unknown;
  artifacts?: Array<{ artifact_id: string; kind: string; bytes: number }>;
  warnings?: string[];
  error?: { message: string; retryable: boolean };
};

function createToolSuccessEnvelope(
  tool: string,
  value: unknown,
  artifact?: AgentArtifactRef | null,
  warnings: string[] = [],
): ToolResultEnvelope {
  const compacted = isRecord(value) && (
    "html_excerpt" in value ||
    "visible_text" in value ||
    "interactive_elements" in value
  )
    ? compactBrowserContextForModel(value)
    : value;

  return {
    ok: true,
    tool,
    ...(isRecord(compacted) ? { summary: compacted } : { result: compacted }),
    ...(artifact
      ? {
          artifacts: [
            {
              artifact_id: artifact.artifact_id,
              kind: artifact.kind,
              bytes: artifact.bytes,
            },
          ],
        }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function createToolErrorEnvelope(tool: string, err: unknown): ToolResultEnvelope {
  return {
    ok: false,
    tool,
    error: {
      message: errorMessage(err),
      retryable: true,
    },
  };
}

function compactToolResult(value: unknown) {
  if (isRecord(value) && (
    "html_excerpt" in value ||
    "visible_text" in value ||
    "interactive_elements" in value
  )) {
    return JSON.stringify(compactBrowserContextForModel(value));
  }

  const serialized = JSON.stringify(value);
  return typeof serialized === "string"
    ? truncateText(serialized, MODEL_GENERIC_TEXT_LIMIT)
    : String(value);
}

function compactStoredToolContent(content: string) {
  if (content.length <= MODEL_GENERIC_TEXT_LIMIT) return content;

  const jsonStart = content.indexOf("{");
  if (jsonStart >= 0) {
    const prefix = content.slice(0, jsonStart).trim();
    const jsonText = content.slice(jsonStart);
    try {
      const compacted = compactToolResult(JSON.parse(jsonText));
      return prefix ? `${prefix}
${compacted}` : compacted;
    } catch {
      // 历史里可能存在半截 JSON，无法解析时退化为纯文本截断。
    }
  }

  return truncateText(content, MODEL_GENERIC_TEXT_LIMIT);
}

function sanitizeChatMessageForStorage(message: ChatMessage): ChatMessage {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: compactStoredToolContent(message.content),
  };
}

function messageCharSize(message: OpenAIMessage) {
  return JSON.stringify(message).length;
}

function compactApiHistoryForModel(messages: OpenAIMessage[]): OpenAIMessage[] {
  const recent = messages.slice(-MAX_RECENT_API_MESSAGES);
  const selected: OpenAIMessage[] = [];
  let total = 0;

  for (const message of [...recent].reverse()) {
    const size = messageCharSize(message);
    if (selected.length > 0 && total + size > MAX_AGENT_CONTEXT_CHARS) break;
    selected.unshift(message);
    total += size;
  }

  const omitted = messages.length - selected.length;
  if (omitted <= 0) return selected;

  const summaryMessage: OpenAIMessage = {
    role: "system",
    content: `会话历史已按上下文预算压缩：省略较早的 ${omitted} 条消息，仅保留最近关键上下文。`,
  };

  return [summaryMessage, ...selected];
}

function sanitizeOpenAIMessageForStorage(message: OpenAIMessage): OpenAIMessage {
  if (message.role !== "tool" || typeof message.content !== "string") return message;

  try {
    return {
      ...message,
      content: compactToolResult(JSON.parse(message.content)),
    };
  } catch {
    return {
      ...message,
      content: compactStoredToolContent(message.content),
    };
  }
}

type AgentHistoryState = {
  environmentId: string;
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  apiMessages: OpenAIMessage[];
  updatedAt: string;
};

const LAST_AGENT_ENVIRONMENT_KEY = "orbit-browser.agent.lastEnvironmentId";
const LAST_AGENT_SESSION_KEY_PREFIX = "orbit-browser.agent.lastSessionId";
const MAX_AGENT_VISIBLE_MESSAGES = 200;
const MAX_AGENT_API_MESSAGES = 120;
const MAX_AGENT_TOOL_TURNS = 12;
const MAX_AGENT_CONTEXT_CHARS = 80_000;
const MAX_RECENT_API_MESSAGES = 40;

function lastAgentSessionKey(environmentId: string) {
  return `${LAST_AGENT_SESSION_KEY_PREFIX}.${environmentId}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatMessage>;
  return (
    typeof item.id === "string" &&
    (item.role === "user" || item.role === "assistant" || item.role === "tool") &&
    typeof item.content === "string"
  );
}

function isOpenAIMessage(value: unknown): value is OpenAIMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OpenAIMessage>;
  return (
    (item.role === "user" || item.role === "assistant" || item.role === "tool") &&
    (item.content === undefined || item.content === null || typeof item.content === "string")
  );
}

async function loadAgentHistory(environmentId: string, sessionId: string): Promise<AgentHistoryState> {
  const snapshot = await browserApi.getAgentHistory(environmentId, sessionId);
  return {
    environmentId,
    sessionId: snapshot.session_id,
    title: snapshot.title,
    messages: snapshot.messages
      .filter(isChatMessage)
      .slice(-MAX_AGENT_VISIBLE_MESSAGES)
      .map(sanitizeChatMessageForStorage),
    apiMessages: snapshot.api_messages
      .filter(isOpenAIMessage)
      .slice(-MAX_AGENT_API_MESSAGES)
      .map(sanitizeOpenAIMessageForStorage),
    updatedAt: snapshot.updated_at ?? new Date().toISOString(),
  };
}

async function saveAgentHistory(
  environmentId: string,
  sessionId: string,
  messages: ChatMessage[],
  apiMessages: OpenAIMessage[],
) {
  return browserApi.saveAgentHistory({
    environment_id: environmentId,
    session_id: sessionId,
    messages: messages
      .slice(-MAX_AGENT_VISIBLE_MESSAGES)
      .map(sanitizeChatMessageForStorage),
    api_messages: apiMessages
      .slice(-MAX_AGENT_API_MESSAGES)
      .map(sanitizeOpenAIMessageForStorage),
  });
}

type ResizableAgentPanelProps = {
  actions?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  fillRemaining?: boolean;
  height: number;
  icon: ReactNode;
  maxHeight: number;
  onHeightChange: (height: number) => void;
  onToggle: () => void;
  title: string;
};

type SidePanelKey = "sessions" | "context" | "recording";

type SidePanelHeights = Record<SidePanelKey, number>;

type CollapsedSidePanels = Record<SidePanelKey, boolean>;

const MIN_AGENT_PANEL_HEIGHT = 150;
const COLLAPSED_AGENT_PANEL_HEIGHT = 48;
const HIGH_RISK_TEXT_PATTERN = /(提交|注册|购买|付款|支付|订阅|确认订单|删除|submit|sign up|register|buy|purchase|pay|delete)/i;
const CONFIRM_TEXT_PATTERN = /(确认|继续|同意|是|可以|执行|confirm|continue|yes|proceed)/i;

const SIDE_PANEL_GAP = 12;

function clampPanelHeight(value: number, maxHeight = Number.POSITIVE_INFINITY) {
  return Math.min(maxHeight, Math.max(MIN_AGENT_PANEL_HEIGHT, value));
}

function visiblePanelHeight(
  panel: SidePanelKey,
  heights: SidePanelHeights,
  collapsed: CollapsedSidePanels,
) {
  return collapsed[panel] ? COLLAPSED_AGENT_PANEL_HEIGHT : heights[panel];
}

function totalSidePanelHeight(
  heights: SidePanelHeights,
  collapsed: CollapsedSidePanels,
) {
  const panels: SidePanelKey[] = ["sessions", "context", "recording"];
  return (
    panels.reduce(
      (total, panel) => total + visiblePanelHeight(panel, heights, collapsed),
      0,
    ) +
    SIDE_PANEL_GAP * (panels.length - 1)
  );
}

function fitSidePanelHeights(
  heights: SidePanelHeights,
  collapsed: CollapsedSidePanels,
  maxTotalHeight: number,
  preferredPanel?: SidePanelKey,
): SidePanelHeights {
  let next = { ...heights };
  let overflow = totalSidePanelHeight(next, collapsed) - maxTotalHeight;
  if (overflow <= 0) return next;

  const shrinkOrder: SidePanelKey[] = ["sessions", "context", "recording"].filter(
    (panel) => panel !== preferredPanel,
  ) as SidePanelKey[];
  if (preferredPanel) shrinkOrder.push(preferredPanel);

  for (const panel of shrinkOrder) {
    if (collapsed[panel]) continue;
    const available = next[panel] - MIN_AGENT_PANEL_HEIGHT;
    if (available <= 0) continue;
    const shrink = Math.min(available, overflow);
    next = { ...next, [panel]: next[panel] - shrink };
    overflow -= shrink;
    if (overflow <= 0) break;
  }

  return next;
}

function ResizableAgentPanel({
  actions,
  children,
  collapsed,
  fillRemaining = false,
  height,
  icon,
  maxHeight,
  onHeightChange,
  onToggle,
  title,
}: ResizableAgentPanelProps) {
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (collapsed) return;
    event.preventDefault();
    dragStateRef.current = { startY: event.clientY, startHeight: height };

    const resize = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      onHeightChange(
        clampPanelHeight(state.startHeight + moveEvent.clientY - state.startY, maxHeight),
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
      className={`panel relative flex min-h-0 flex-col overflow-hidden ${
        fillRemaining && !collapsed ? "flex-1" : "shrink-0"
      }`}
      style={
        fillRemaining && !collapsed
          ? undefined
          : { height: collapsed ? COLLAPSED_AGENT_PANEL_HEIGHT : height }
      }
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <button
          aria-expanded={!collapsed}
          className="control-focus flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm font-semibold text-ink-900 hover:text-brand-700"
          onClick={onToggle}
          type="button"
        >
          {icon}
          <span className="truncate">{title}</span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-ink-500 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        {!collapsed && actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {!collapsed ? <div className="scroll-panel min-h-0 min-w-0 flex-1 overflow-x-hidden p-4">{children}</div> : null}

      {!collapsed && !fillRemaining ? (
        <button
          aria-label={`Resize ${title}`}
          className="control-focus flex h-3 shrink-0 cursor-row-resize items-center justify-center border-t border-line bg-ink-50 text-ink-400 transition-colors hover:bg-brand-50 hover:text-brand-600"
          onPointerDown={startResize}
          type="button"
        >
          <GripHorizontal className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </section>
  );
}

function ChatMessageContent({ content, role }: { content: string; role: ChatMessage["role"] }) {
  if (role === "tool") {
    return <p className="selectable whitespace-pre-wrap break-words">{content}</p>;
  }

  return (
    <Suspense fallback={<p className="selectable whitespace-pre-wrap break-words">{content}</p>}>
      <MarkdownMessageRenderer content={content} />
    </Suspense>
  );
}

export function AgentPage() {
  const navigate = useNavigate();
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);
  const { copy, language } = useI18n();
  const text = copy.agent;
  const [environmentId, setEnvironmentId] = useState(agentRuntimeRefs.environmentId);
  const [sessionId, setSessionId] = useState(agentRuntimeRefs.sessionId);
  const [deleteTarget, setDeleteTarget] = useState<AgentHistorySession | null>(null);
  const [input, setInput] = useState("");
  const [sidePanelHeights, setSidePanelHeights] = useState<SidePanelHeights>({
    sessions: 260,
    context: 340,
    recording: 300,
  });
  const [collapsedSidePanels, setCollapsedSidePanels] = useState<CollapsedSidePanels>({
    sessions: false,
    context: true,
    recording: true,
  });
  const [sidePanelMaxHeight, setSidePanelMaxHeight] = useState(0);
  const messages = useAgentRuntimeStore((state) => state.messages);
  const apiMessages = useAgentRuntimeStore((state) => state.apiMessages);
  const isRunning = useAgentRuntimeStore((state) => state.isRunning);
  const isHistoryLoading = useAgentRuntimeStore((state) => state.isHistoryLoading);
  const error = useAgentRuntimeStore((state) => state.error);
  const context = useAgentRuntimeStore((state) => state.context);
  const recording = useAgentRuntimeStore((state) => state.recording);
  const sessions = useAgentRuntimeStore((state) => state.sessions);
  const appendMessage = useAgentRuntimeStore((state) => state.appendMessage);
  const finalizeTrailingEmptyAssistant = useAgentRuntimeStore((state) => state.finalizeTrailingEmptyAssistant);
  const patchMessage = useAgentRuntimeStore((state) => state.patchMessage);
  const resetRuntimeConversation = useAgentRuntimeStore((state) => state.resetConversation);
  const setApiMessages = useAgentRuntimeStore((state) => state.setApiMessages);
  const setContext = useAgentRuntimeStore((state) => state.setContext);
  const setError = useAgentRuntimeStore((state) => state.setError);
  const setIsHistoryLoading = useAgentRuntimeStore((state) => state.setIsHistoryLoading);
  const setIsRunning = useAgentRuntimeStore((state) => state.setIsRunning);
  const setMessages = useAgentRuntimeStore((state) => state.setMessages);
  const setRecording = useAgentRuntimeStore((state) => state.setRecording);
  const setSessions = useAgentRuntimeStore((state) => state.setSessions);
  const toggleToolMessage = useAgentRuntimeStore((state) => state.toggleToolMessage);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sidePanelRef = useRef<HTMLElement | null>(null);
  const loadedHistoryRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const skipNextHistorySaveRef = useRef(false);

  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: browserApi.listEnvironments,
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: browserApi.getSettings,
  });

  const selectedEnvironment = useMemo(
    () => environmentsQuery.data?.find((item) => item.id === environmentId),
    [environmentId, environmentsQuery.data],
  );

  const activeSession = useMemo(
    () => sessions.find((item) => item.session_id === sessionId),
    [sessionId, sessions],
  );

  const activeHistoryKey = environmentId && sessionId ? `${environmentId}:${sessionId}` : "";

  const expandedPanelCount = (Object.keys(collapsedSidePanels) as SidePanelKey[]).filter(
    (panel) => !collapsedSidePanels[panel],
  ).length;
  const collapsedPanelCount = 3 - expandedPanelCount;
  const maxExpandedPanelHeight = Math.max(
    MIN_AGENT_PANEL_HEIGHT,
    sidePanelMaxHeight - SIDE_PANEL_GAP * 2 - collapsedPanelCount * COLLAPSED_AGENT_PANEL_HEIGHT,
  );

  const setSidePanelHeight = (panel: SidePanelKey, height: number) => {
    setSidePanelHeights((current) =>
      fitSidePanelHeights(
        { ...current, [panel]: clampPanelHeight(height, maxExpandedPanelHeight) },
        collapsedSidePanels,
        sidePanelMaxHeight,
        panel,
      ),
    );
  };

  const toggleSidePanel = (panel: SidePanelKey) => {
    setCollapsedSidePanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const expandSidePanel = (panel: SidePanelKey) => {
    setCollapsedSidePanels((current) =>
      current[panel] ? { ...current, [panel]: false } : current,
    );
  };

  useEffect(() => {
    const element = sidePanelRef.current;
    if (!element) return;

    const updateHeight = () => setSidePanelMaxHeight(element.clientHeight);
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  useEffect(() => {
    if (!sidePanelMaxHeight) return;
    setSidePanelHeights((current) =>
      fitSidePanelHeights(current, collapsedSidePanels, sidePanelMaxHeight),
    );
  }, [collapsedSidePanels, sidePanelMaxHeight]);

  useEffect(() => {
    if (!environmentId) return;

    if (isRunning && agentRuntimeRefs.environmentId === environmentId) {
      setSessionId(agentRuntimeRefs.sessionId);
      return;
    }

    let cancelled = false;
    loadedHistoryRef.current = null;
    setSessionId("");
    resetRuntimeConversation();
    setIsHistoryLoading(true);
    void browserApi
      .listAgentHistories(environmentId)
      .then((items) => {
        if (cancelled) return;
        setSessions(items);

        const lastSessionId =
          typeof window === "undefined"
            ? null
            : window.localStorage.getItem(lastAgentSessionKey(environmentId));
        const nextSession =
          items.find((item) => item.session_id === lastSessionId) ?? items[0];
        setSessionId(nextSession?.session_id ?? crypto.randomUUID());
      })
      .catch((err) => {
        if (cancelled) return;
        setSessions([]);
        setSessionId(crypto.randomUUID());
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  useEffect(() => {
    if (!environmentId || !sessionId || loadedHistoryRef.current === activeHistoryKey) return;

    let cancelled = false;
    skipNextHistorySaveRef.current = true;
    setIsHistoryLoading(true);
    void loadAgentHistory(environmentId, sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        loadedHistoryRef.current = activeHistoryKey;
        setSessionId(snapshot.sessionId);
        setMessages(snapshot.messages);
        setApiMessages(snapshot.apiMessages);
        setError(null);
        agentRuntimeRefs.charQueue = [];
      })
      .catch((err) => {
        if (cancelled) return;
        loadedHistoryRef.current = activeHistoryKey;
        resetRuntimeConversation();
        setError(errorMessage(err));
        agentRuntimeRefs.charQueue = [];
      })
      .finally(() => {
        if (!cancelled) setIsHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeHistoryKey, environmentId, sessionId]);

  useEffect(() => {
    if (!environmentId || !sessionId || loadedHistoryRef.current !== activeHistoryKey) return;
    if (skipNextHistorySaveRef.current) {
      skipNextHistorySaveRef.current = false;
      return;
    }
    if (messages.length === 0 && apiMessages.length === 0) return;

    const timer = window.setTimeout(() => {
      void saveAgentHistory(environmentId, sessionId, messages, apiMessages)
        .then((snapshot) => {
          setSessions((current) => {
            const nextSession: AgentHistorySession = {
              environment_id: snapshot.environment_id,
              session_id: snapshot.session_id,
              title: snapshot.title,
              created_at: snapshot.created_at,
              updated_at: snapshot.updated_at,
              message_count: messages.length,
              path: snapshot.path,
            };
            return [
              nextSession,
              ...current.filter((item) => item.session_id !== snapshot.session_id),
            ];
          });
        })
        .catch((err) => {
          setError(errorMessage(err));
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeHistoryKey, apiMessages, environmentId, messages, sessionId]);

  const aigcConfigured = Boolean(
    settingsQuery.data?.aigc_base_url?.trim() &&
      settingsQuery.data?.aigc_model?.trim() &&
      settingsQuery.data?.aigc_api_key?.trim(),
  );
  const ready = Boolean(environmentId && aigcConfigured);

  useEffect(() => {
    if (environmentId || !environmentsQuery.data?.length) return;

    const lastEnvironmentId =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(LAST_AGENT_ENVIRONMENT_KEY);
    const nextEnvironment =
      environmentsQuery.data.find((item) => item.id === lastEnvironmentId) ??
      environmentsQuery.data[0];
    setEnvironmentId(nextEnvironment.id);
  }, [environmentId, environmentsQuery.data]);

  useEffect(() => {
    if (!environmentId || typeof window === "undefined") return;
    agentRuntimeRefs.environmentId = environmentId;
    window.localStorage.setItem(LAST_AGENT_ENVIRONMENT_KEY, environmentId);
  }, [environmentId]);

  useEffect(() => {
    if (!environmentId || !sessionId || typeof window === "undefined") return;
    agentRuntimeRefs.environmentId = environmentId;
    agentRuntimeRefs.sessionId = sessionId;
    window.localStorage.setItem(lastAgentSessionKey(environmentId), sessionId);
  }, [environmentId, sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = agentRuntimeRefs.charQueue.shift();
      if (!next) return;
      patchMessage(next.id, (message) => ({
        ...message,
        content: message.content + next.char,
      }));
    }, 12);
    return () => window.clearInterval(timer);
  }, [patchMessage]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const appendVisible = (message: ChatMessage) => {
    appendMessage(message);
  };

  const enqueueAssistantText = (id: string, value: string) => {
    agentRuntimeRefs.charQueue.push(...Array.from(value).map((char) => ({ id, char })));
  };

  const throwIfStopped = (signal?: AbortSignal | null) => {
    if (agentRuntimeRefs.stopped || signal?.aborted || agentRuntimeRefs.abort?.signal.aborted) {
      throw createAbortError();
    }
  };

  const describeElement = async (selector: string) => {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const el = document.querySelector(selector);
      if (!el) return null;
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const id = el.id;
      const escapedId = globalThis.CSS?.escape ? CSS.escape(id) : String(id).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      const label = id ? document.querySelector('label[for="' + escapedId.replace(/"/g, '\\"') + '"]') : null;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        text: normalize([
          el.getAttribute("aria-label"),
          el.getAttribute("placeholder"),
          el.getAttribute("title"),
          label?.innerText,
          el.innerText,
          el.value,
        ].filter(Boolean).join(" ")).slice(0, 300),
      };
    })()`;
    const result = await browserApi.agentBrowserAction({
      environment_id: environmentId,
      action: "evaluate",
      expression,
    });
    return isRecord(result) ? result.value : null;
  };

  const requireRiskApprovalIfNeeded = async (toolName: string, selector: string) => {
    if (toolName !== "browser_click") return null;
    const element = await describeElement(selector);
    if (!isRecord(element)) return null;
    const textValue = String(element.text ?? "");
    if (!HIGH_RISK_TEXT_PATTERN.test(textValue)) return null;

    const approvalKey = `${environmentId}:${sessionId}:${selector}:${textValue}`;
    if (agentRuntimeRefs.riskApprovals.has(approvalKey) || CONFIRM_TEXT_PATTERN.test(input)) {
      agentRuntimeRefs.riskApprovals.add(approvalKey);
      return null;
    }

    return createToolErrorEnvelope(
      toolName,
      new Error(`高风险点击需要用户确认：${textValue || selector}。请回复“确认继续”后再执行。`),
    );
  };

  const browserFindElements = async (query: string, limit: number) => {
    const expression = `(() => {
      const query = ${JSON.stringify(query)}.toLowerCase();
      const limit = ${limit};
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cssEscape = (value) => globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      const selectorFor = (el) => {
        if (el.id) return \`#\${cssEscape(el.id)}\`;
        const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
        if (testId) return \`[data-testid="\${String(testId).replace(/"/g, '\\"')}"]\`;
        const name = el.getAttribute("name");
        if (name) return \`\${el.tagName.toLowerCase()}[name="\${String(name).replace(/"/g, '\\"')}"]\`;
        return el.tagName.toLowerCase();
      };
      return Array.from(document.querySelectorAll("a,button,input,textarea,select,option,[role='button'],[contenteditable='true']"))
        .map((el) => {
          const id = el.id;
          const label = id ? document.querySelector(\`label[for="\${cssEscape(id)}"]\`) : null;
          const text = normalize([
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
            el.getAttribute("title"),
            label?.innerText,
            el.innerText,
            el.value,
            el.getAttribute("name"),
          ].filter(Boolean).join(" "));
          return { kind: el.tagName.toLowerCase(), label: text.slice(0, 220), selector: selectorFor(el) };
        })
        .filter((item) => (item.label + " " + item.selector).toLowerCase().includes(query))
        .slice(0, limit);
    })()`;
    return browserApi.agentBrowserAction({
      environment_id: environmentId,
      action: "evaluate",
      expression,
    });
  };

  const browserSelectOption = async (selector: string, value?: string, label?: string) => {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector)};
      const expectedValue = ${JSON.stringify(value ?? "")};
      const expectedLabel = ${JSON.stringify(label ?? "")};
      const select = document.querySelector(selector);
      if (!select) throw new Error(\`Element not found: \${selector}\`);
      if (select.tagName.toLowerCase() !== "select") throw new Error(\`Element is not a select: \${selector}\`);
      const normalize = (text) => String(text || "").trim().toLowerCase();
      const option = Array.from(select.options).find((item) =>
        expectedValue ? item.value === expectedValue : normalize(item.textContent).includes(normalize(expectedLabel))
      );
      if (!option) throw new Error("Option not found");
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { selector, selected_value: option.value, selected_label: option.textContent };
    })()`;
    await browserApi.agentBrowserAction({
      environment_id: environmentId,
      action: "evaluate",
      expression,
    });
    return browserApi.agentBrowserAction({
      environment_id: environmentId,
      action: "context",
      include_screenshot: false,
    });
  };

  const executeTool = async (name: string, rawArgs: string) => {
    throwIfStopped();
    if (!environmentId) {
      throw new Error(text.selectEnvironmentFirst);
    }
    const args = safeJsonParse(rawArgs) as Record<string, unknown>;
    const toolMessageId = crypto.randomUUID();
    appendVisible({
      id: toolMessageId,
      role: "tool",
      collapsed: true,
      toolName: name,
      content: text.toolRunning,
    });
    const markToolDone = (value: unknown) => {
      const preview = compactToolResult(value);
      patchMessage(toolMessageId, (message) => ({
        ...message,
        content: `${text.toolDone}
${preview}`,
      }));
    };

    if (name === "agent_read_artifact") {
      const artifactId = typeof args.artifact_id === "string" ? args.artifact_id : "";
      if (!artifactId) throw new Error("Missing required field: artifact_id");
      const result = await browserApi.readAgentArtifact({
        environment_id: environmentId,
        session_id: sessionId,
        artifact_id: artifactId,
        max_chars: typeof args.max_chars === "number" ? args.max_chars : undefined,
      });
      throwIfStopped();
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "recording_start") {
      const result = await browserApi.agentStartBrowserRecording(environmentId);
      throwIfStopped();
      setRecording(result);
      expandSidePanel("recording");
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }
    if (name === "recording_stop") {
      const result = await browserApi.agentStopBrowserRecording(environmentId);
      throwIfStopped();
      setRecording(result);
      expandSidePanel("recording");
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }
    if (name === "recording_status") {
      const result = await browserApi.agentGetBrowserRecording(environmentId);
      throwIfStopped();
      setRecording(result);
      expandSidePanel("recording");
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "browser_find_elements") {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query) throw new Error("Missing required field: query");
      const result = await browserFindElements(query, typeof args.limit === "number" ? args.limit : 20);
      throwIfStopped();
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "browser_select_option") {
      const selector = typeof args.selector === "string" ? args.selector : "";
      const value = typeof args.value === "string" ? args.value.trim() : "";
      const label = typeof args.label === "string" ? args.label.trim() : "";
      if (!selector) throw new Error("Missing required field: selector");
      if (!value && !label) throw new Error("Missing required field: value or label");
      const result = await browserSelectOption(
        selector,
        value || undefined,
        label || undefined,
      );
      throwIfStopped();
      setContext(result as BrowserContextSnapshot);
      expandSidePanel("context");
      const { artifact, warning: artifactWarning } = await saveToolArtifactBestEffort(
        environmentId,
        sessionId,
        name,
        toolMessageId,
        result,
      );
      const modelResult = createToolSuccessEnvelope(
        name,
        result,
        artifact,
        artifactWarning ? [artifactWarning] : [],
      );
      markToolDone(modelResult);
      return modelResult;
    }

    const actionMap: Record<string, string> = {
      browser_context: "context",
      browser_goto: "goto",
      browser_click: "click",
      browser_type: "type",
      browser_wait: "wait",
      browser_evaluate: "evaluate",
    };
    const action = actionMap[name];
    if (!action) {
      throw new Error(`Unsupported tool: ${name}`);
    }

    if (name === "browser_click" && typeof args.selector === "string") {
      const approvalResult = await requireRiskApprovalIfNeeded(name, args.selector);
      if (approvalResult) {
        markToolDone(approvalResult);
        return approvalResult;
      }
    }

    const result = await browserApi.agentBrowserAction({
      environment_id: environmentId,
      action,
      url: typeof args.url === "string" ? args.url : undefined,
      selector: typeof args.selector === "string" ? args.selector : undefined,
      text: typeof args.text === "string" ? args.text : undefined,
      expression: typeof args.expression === "string" ? args.expression : undefined,
      milliseconds: typeof args.milliseconds === "number" ? args.milliseconds : undefined,
      include_screenshot: Boolean(args.include_screenshot),
    });

    throwIfStopped();
    if (action === "context" || action === "goto" || action === "click" || action === "type" || action === "wait") {
      setContext(result as BrowserContextSnapshot);
      expandSidePanel("context");
    }
    const { artifact, warning: artifactWarning } = await saveToolArtifactBestEffort(
      environmentId,
      sessionId,
      name,
      toolMessageId,
      result,
    );
    throwIfStopped();
    const modelResult = createToolSuccessEnvelope(
      name,
      result,
      artifact,
      artifactWarning ? [artifactWarning] : [],
    );
    markToolDone(modelResult);
    return modelResult;
  };

  const streamOnce = async (
    settings: Settings,
    history: OpenAIMessage[],
    toolTurn = 0,
  ): Promise<OpenAIMessage[]> => {
    const signal = agentRuntimeRefs.abort?.signal;
    throwIfStopped(signal);

    const assistantId = crypto.randomUUID();
    appendVisible({ id: assistantId, role: "assistant", content: "" });

    const toolCalls: ToolCall[] = [];
    let assistantContent = "";
    const response = await fetch(`${normalizeBaseUrl(settings.aigc_base_url ?? "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.aigc_api_key}`,
      },
      body: JSON.stringify({
        model: settings.aigc_model,
        messages: history,
        stream: true,
        tools,
        temperature: 0.2,
      }),
      signal,
    });

    throwIfStopped(signal);
    if (!response.ok || !response.body) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      throwIfStopped(signal);
      const { value, done } = await reader.read();
      throwIfStopped(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.content) {
          assistantContent += delta.content;
          enqueueAssistantText(assistantId, delta.content);
        }
        for (const item of delta.tool_calls ?? []) {
          const index = item.index ?? 0;
          toolCalls[index] ??= {
            id: item.id ?? crypto.randomUUID(),
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (item.id) toolCalls[index].id = item.id;
          if (item.function?.name) toolCalls[index].function.name = item.function.name;
          if (item.function?.arguments) {
            toolCalls[index].function.arguments += item.function.arguments;
          }
        }
      }
    }

    throwIfStopped(signal);
    if (!assistantContent && toolCalls.length) {
      patchMessage(assistantId, (message) => ({ ...message, content: text.toolPlan }));
    }

    const assistantMessage: OpenAIMessage = {
      role: "assistant",
      content: assistantContent || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    const nextHistory = [...history, assistantMessage];

    if (assistantContent) {
      agentRuntimeRefs.charQueue = agentRuntimeRefs.charQueue.filter((item) => item.id !== assistantId);
      patchMessage(assistantId, (message) => ({ ...message, content: assistantContent }));
    }

    if (!toolCalls.length) {
      return nextHistory;
    }

    if (toolTurn >= MAX_AGENT_TOOL_TURNS) {
      const limitMessage: OpenAIMessage = {
        role: "assistant",
        content: `工具调用已达到 ${MAX_AGENT_TOOL_TURNS} 轮上限。请用户确认下一步或缩小任务范围。`,
      };
      patchMessage(assistantId, (message) => ({
        ...message,
        content: String(limitMessage.content),
      }));
      return [...nextHistory, limitMessage];
    }

    const toolMessages: OpenAIMessage[] = [];
    for (const call of toolCalls) {
      throwIfStopped(signal);
      try {
        const result = await executeTool(call.function.name, call.function.arguments);
        throwIfStopped(signal);
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: compactToolResult(result),
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: compactToolResult(createToolErrorEnvelope(call.function.name, err)),
        });
      }
    }

    throwIfStopped(signal);
    return streamOnce(settings, [...nextHistory, ...toolMessages], toolTurn + 1);
  };

  const persistRuntimeSnapshot = async () => {
    if (!environmentId || !sessionId) return;
    const snapshotState = useAgentRuntimeStore.getState();
    if (
      snapshotState.messages.length === 0 &&
      snapshotState.apiMessages.length === 0
    ) {
      return;
    }

    const snapshot = await saveAgentHistory(
      environmentId,
      sessionId,
      snapshotState.messages,
      snapshotState.apiMessages,
    );
    setSessions((current) => {
      const nextSession: AgentHistorySession = {
        environment_id: snapshot.environment_id,
        session_id: snapshot.session_id,
        title: snapshot.title,
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
        message_count: snapshotState.messages.length,
        path: snapshot.path,
      };
      return [
        nextSession,
        ...current.filter((item) => item.session_id !== snapshot.session_id),
      ];
    });
  };

  const send = async () => {
    const content = input.trim();
    const settings = settingsQuery.data;
    if (!content || !settings || !ready || isRunning) return;

    setInput("");
    setError(null);
    setIsRunning(true);
    agentRuntimeRefs.stopped = false;
    const runId = agentRuntimeRefs.runId + 1;
    agentRuntimeRefs.runId = runId;
    agentRuntimeRefs.abort = new AbortController();

    agentRuntimeRefs.environmentId = environmentId;
    agentRuntimeRefs.sessionId = sessionId;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    appendVisible(userMessage);

    const baseHistory: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(selectedEnvironment) },
      ...compactApiHistoryForModel(apiMessages),
      { role: "user", content },
    ];

    try {
      const nextHistory = await streamOnce(settings, baseHistory);
      if (agentRuntimeRefs.runId === runId && !agentRuntimeRefs.stopped) {
        setApiMessages(nextHistory.filter((item) => item.role !== "system"));
      }
    } catch (err) {
      if (!isAbortError(err)) {
        const message = errorMessage(err);
        setError(message);
        finalizeTrailingEmptyAssistant(text.stoppedByError.replace("{{message}}", message));
      } else {
        finalizeTrailingEmptyAssistant(text.stoppedByUser);
      }
    } finally {
      finalizeTrailingEmptyAssistant(text.emptyAssistantResponse);
      if (agentRuntimeRefs.runId === runId) {
        try {
          await persistRuntimeSnapshot();
        } catch (err) {
          setError(errorMessage(err));
        }
        setIsRunning(false);
        agentRuntimeRefs.abort = null;
      }
    }
  };

  const stop = () => {
    agentRuntimeRefs.stopped = true;
    agentRuntimeRefs.abort?.abort();
    agentRuntimeRefs.charQueue = [];
    finalizeTrailingEmptyAssistant(text.stoppedByUser);
    setIsRunning(false);
  };

  const newSession = () => {
    if (!environmentId || isRunning) return;
    const nextSessionId = crypto.randomUUID();
    loadedHistoryRef.current = `${environmentId}:${nextSessionId}`;
    skipNextHistorySaveRef.current = false;
    agentRuntimeRefs.charQueue = [];
    agentRuntimeRefs.environmentId = environmentId;
    agentRuntimeRefs.sessionId = nextSessionId;
    setSessionId(nextSessionId);
    resetRuntimeConversation();
    setError(null);
    setContext(null);
  };

  const switchSession = (nextSessionId: string) => {
    if (!nextSessionId || nextSessionId === sessionId || isRunning) return;
    agentRuntimeRefs.charQueue = [];
    agentRuntimeRefs.environmentId = environmentId;
    agentRuntimeRefs.sessionId = nextSessionId;
    setSessionId(nextSessionId);
  };

  const deleteSession = async (targetSessionId: string) => {
    if (!environmentId || !targetSessionId || isRunning) return;

    try {
      await browserApi.deleteAgentHistory(environmentId, targetSessionId);
      const nextSessions = sessions.filter((item) => item.session_id !== targetSessionId);
      setSessions(nextSessions);

      if (targetSessionId !== sessionId) return;

      const nextSessionId = nextSessions[0]?.session_id ?? crypto.randomUUID();
      loadedHistoryRef.current = nextSessions[0] ? null : `${environmentId}:${nextSessionId}`;
      skipNextHistorySaveRef.current = false;
      agentRuntimeRefs.charQueue = [];
      agentRuntimeRefs.environmentId = environmentId;
      agentRuntimeRefs.sessionId = nextSessionId;
      setSessionId(nextSessionId);
      resetRuntimeConversation();
      setError(null);
      setContext(null);
      setDeleteTarget(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleteTarget(null);
    }
  };

  const refreshContext = async () => {
    if (!environmentId) return;
    const result = await browserApi.agentBrowserAction({
      environment_id: environmentId,
      action: "context",
      include_screenshot: false,
    });
    setContext(result as BrowserContextSnapshot);
    expandSidePanel("context");
  };

  const toggleRecording = async () => {
    if (!environmentId) return;
    const result = recording?.is_recording
      ? await browserApi.agentStopBrowserRecording(environmentId)
      : await browserApi.agentStartBrowserRecording(environmentId);
    setRecording(result);
    expandSidePanel("recording");
  };

  useEffect(() => {
    if (!aigcConfigured) {
      setHeaderActions(undefined);
      return () => setHeaderActions(undefined);
    }

    setHeaderActions(
      <>
        <SelectControl
          wrapperClassName="w-56"
          value={environmentId}
          onChange={(event) => {
            if (!isRunning) setEnvironmentId(event.target.value);
          }}
          disabled={isRunning}
        >
          {(environmentsQuery.data ?? []).map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </SelectControl>

        <Button
          icon={<Plus className="h-4 w-4" />}
          onClick={newSession}
          disabled={!environmentId || isRunning}
        >
          {text.newSession}
        </Button>

        <Button
          icon={<FileSearch className="h-4 w-4" />}
          onClick={refreshContext}
          disabled={!environmentId}
        >
          {text.readContext}
        </Button>
        <Button
          icon={
            recording?.is_recording ? (
              <CircleStop className="h-4 w-4" />
            ) : (
              <Radio className="h-4 w-4" />
            )
          }
          onClick={toggleRecording}
          disabled={!environmentId}
          variant={recording?.is_recording ? "danger" : "primary"}
        >
          {recording?.is_recording ? text.stopRecording : text.startRecording}
        </Button>
      </>,
    );

    return () => setHeaderActions(undefined);
  }, [
    aigcConfigured,
    environmentId,
    environmentsQuery.data,
    isRunning,
    recording?.is_recording,
    setHeaderActions,
    text.newSession,
    text.readContext,
    text.startRecording,
    text.stopRecording,
  ]);

  return (
    <div className="h-full min-h-0 w-full">
      {!aigcConfigured ? (
        <section className="panel flex h-full min-h-0 items-center justify-center p-6">
          <div className="max-w-xl rounded-3xl border border-brand-100 bg-gradient-to-br from-brand-50 via-white to-white p-8 text-center shadow-panel">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-panel">
              <Settings2 className="h-6 w-6" />
            </div>
            <h3 className="mt-5 text-xl font-semibold text-ink-900">
              {text.configTitle}
            </h3>
            <p className="mt-3 text-sm leading-6 text-ink-600">
              {text.configDescription}
            </p>
            <Button
              className="mt-5"
              icon={<Settings2 className="h-4 w-4" />}
              onClick={() => navigate("/settings")}
              variant="primary"
            >
              {text.goSettings}
            </Button>
          </div>
        </section>
      ) : (
      <div className="grid h-full min-h-0 min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
          <div ref={scrollRef} className="scroll-panel min-w-0 p-4">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[420px] items-center justify-center p-4">
                <EmptyState
                  className="w-full max-w-xl bg-gradient-to-br from-white via-white to-brand-50/60 shadow-panel"
                  icon={<Bot className="h-5 w-5" />}
                  title={text.emptyTitle}
                  description={text.emptyDescription}
                />
              </div>
            ) : (
              <div className="grid min-w-0 gap-4">
                {messages.map((message, index) => {
                  const isLastMessage = index === messages.length - 1;
                  const showAssistantLoading =
                    isRunning &&
                    isLastMessage &&
                    message.role === "assistant" &&
                    !message.content;
                  return (
                  <div key={message.id} className={`flex w-full min-w-0 gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    {message.role !== "user" ? (
                      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                        {message.role === "tool" ? <SquareTerminal className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                      </div>
                    ) : null}
                    <div className={`agent-message-bubble min-w-0 rounded-2xl px-4 py-3 text-sm leading-6 shadow-panel ${
                      message.role === "user"
                        ? "bg-brand-600 text-white"
                        : message.role === "tool"
                          ? "border border-line bg-ink-50 text-ink-600"
                          : "border border-line bg-white text-ink-900"
                    }`}>
                      {message.role === "tool" ? (
                        <div className="min-w-0">
                          <button
                            className="control-focus flex w-full cursor-pointer items-center justify-between gap-3 rounded-md text-left"
                            onClick={() => toggleToolMessage(message.id)}
                            type="button"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold text-brand-600">
                                {message.toolName ?? "tool"}
                              </span>
                              <span className="block truncate text-xs text-ink-500">
                                {message.content.startsWith(text.toolDone) ? text.toolDone : text.toolRunning}
                              </span>
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 shrink-0 text-ink-500 transition-transform duration-200 ${message.collapsed ? "-rotate-90" : ""}`}
                            />
                          </button>
                          {!message.collapsed ? (
                            <div className="mt-2 border-t border-line pt-2">
                              <ChatMessageContent content={message.content} role={message.role} />
                            </div>
                          ) : null}
                        </div>
                      ) : showAssistantLoading ? (
                        <span className="agent-thinking-dots" aria-label={text.thinking}>
                          <span />
                          <span />
                          <span />
                        </span>
                      ) : (
                        <ChatMessageContent content={message.content} role={message.role} />
                      )}
                    </div>
                    {message.role === "user" ? (
                      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white">
                        <User className="h-4 w-4" />
                      </div>
                    ) : null}
                  </div>
                  );
                })}
                {isRunning ? (
                  <div className="flex items-center gap-2 text-xs text-ink-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {text.thinking}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-line bg-gradient-to-b from-white/80 to-brand-50/70 p-3">
            {error ? <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-danger">{error}</div> : null}
            <div className="rounded-2xl border border-line bg-white shadow-elevated transition-colors duration-200 focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/10">
              <textarea
                className="min-h-20 w-full resize-none rounded-2xl border-0 bg-transparent px-4 py-3 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-500"
                placeholder={text.placeholder}
                rows={3}
                value={input}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  compositionEndedAtRef.current = Date.now();
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  const nativeEvent = event.nativeEvent as KeyboardEvent & {
                    keyCode?: number;
                    which?: number;
                  };
                  const isImeEnter =
                    nativeEvent.isComposing ||
                    composingRef.current ||
                    nativeEvent.keyCode === 229 ||
                    nativeEvent.which === 229 ||
                    Date.now() - compositionEndedAtRef.current < 250;
                  if (isImeEnter) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-3 border-t border-line/70 px-3 py-2">
                <span className="truncate text-xs text-ink-500">{text.shortcutHint}</span>
                {isRunning ? (
                  <Button
                    className="h-10 rounded-xl px-4 shadow-none"
                    icon={<CircleStop className="h-4 w-4" />}
                    onClick={stop}
                    variant="danger"
                  >
                    {text.stop}
                  </Button>
                ) : (
                  <Button
                    className="h-10 rounded-xl px-4 shadow-none disabled:bg-ink-200 disabled:text-ink-500"
                    icon={<Send className="h-4 w-4" />}
                    onClick={send}
                    disabled={!ready || !input.trim()}
                    variant="primary"
                  >
                    {text.send}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>

        <aside ref={sidePanelRef} className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
          <ResizableAgentPanel
            actions={
              <Button
                icon={<Plus className="h-4 w-4" />}
                onClick={newSession}
                disabled={!environmentId || isRunning}
                size="sm"
              >
                {text.newSession}
              </Button>
            }
            collapsed={collapsedSidePanels.sessions}
            fillRemaining
            height={sidePanelHeights.sessions}
            icon={<MessageSquareText className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) => setSidePanelHeight("sessions", height)}
            onToggle={() => toggleSidePanel("sessions")}
            title={text.sessions}
          >
            {isHistoryLoading && sessions.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-ink-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {text.loadingSessions}
              </div>
            ) : sessions.length === 0 ? (
              <p className="text-sm text-ink-500">{text.noSessions}</p>
            ) : (
              <div className="grid min-w-0 gap-2 overflow-hidden">
                {sessions.map((session) => {
                  const active = session.session_id === sessionId;
                  return (
                    <div
                      key={session.session_id}
                      className={`group flex min-w-0 items-center overflow-hidden rounded-xl border transition-colors ${
                        active
                          ? "border-brand-200 bg-brand-50 text-brand-900"
                          : "border-line bg-white text-ink-800 hover:border-brand-200 hover:bg-brand-50/60"
                      }`}
                    >
                      <button
                        className="control-focus min-w-0 flex-1 overflow-hidden rounded-xl py-2 pl-3 pr-2 text-left disabled:cursor-default"
                        disabled={isRunning || active}
                        onClick={() => switchSession(session.session_id)}
                        type="button"
                      >
                        <p className="truncate text-sm font-semibold">
                          {session.title || text.untitledSession}
                        </p>
                        <p className="mt-1 truncate text-xs text-ink-500">
                          {session.updated_at ? formatDateTime(session.updated_at, language) : "-"}
                          {` · ${session.message_count} ${text.sessionMessages}`}
                        </p>
                      </button>
                      <button
                        aria-label={text.deleteSession}
                        className="control-focus mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-400 transition hover:bg-red-50 hover:text-danger focus:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={isRunning}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setDeleteTarget(session);
                        }}
                        title={text.deleteSession}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {activeSession ? (
              <p className="mt-3 max-w-full truncate text-xs text-ink-500">
                {text.currentSession}: {activeSession.title || text.untitledSession}
              </p>
            ) : null}
          </ResizableAgentPanel>

          <ResizableAgentPanel
            collapsed={collapsedSidePanels.context}
            height={sidePanelHeights.context}
            icon={<FileSearch className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) => setSidePanelHeight("context", height)}
            onToggle={() => toggleSidePanel("context")}
            title={text.context}
          >
            {context ? (
              <div className="grid gap-3 text-xs text-ink-600">
                <div className="rounded-lg border border-line bg-ink-50 p-3">
                  <p className="font-semibold text-ink-900">{context.title || "-"}</p>
                  <p className="selectable mt-1 break-all text-ink-500">{context.url}</p>
                </div>
                <div>
                  <p className="mb-2 font-semibold text-ink-900">{text.elements}</p>
                  <div className="grid min-w-0 gap-2 overflow-hidden">
                    {context.interactive_elements.slice(0, 8).map((item) => (
                      <div key={`${item.kind}-${item.selector}`} className="rounded-lg border border-line px-3 py-2">
                        <p className="font-medium text-ink-800">{item.label || item.kind}</p>
                        <p className="selectable mt-1 break-all font-mono text-[11px] text-ink-500">{item.selector}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 font-semibold text-ink-900">{text.visibleText}</p>
                  <p className="selectable max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-3 leading-5">{context.visible_text || "-"}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-500">{text.noContext}</p>
            )}
          </ResizableAgentPanel>

          <ResizableAgentPanel
            collapsed={collapsedSidePanels.recording}
            height={sidePanelHeights.recording}
            icon={<Network className="h-4 w-4 shrink-0 text-brand-600" />}
            maxHeight={maxExpandedPanelHeight}
            onHeightChange={(height) => setSidePanelHeight("recording", height)}
            onToggle={() => toggleSidePanel("recording")}
            title={text.recording}
          >
            {recording ? (
              <div className="grid gap-2 text-xs">
                <div className="flex items-center justify-between rounded-lg border border-line bg-ink-50 px-3 py-2">
                  <span className="text-ink-600">{recording.is_recording ? text.recordingActive : text.recordingStopped}</span>
                  <span className="font-semibold text-ink-900">{recording.total_events}</span>
                </div>
                {recording.events.slice(-10).reverse().map((event, index) => (
                  <div key={`${event.timestamp}-${index}`} className="rounded-lg border border-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-800">{event.kind}</span>
                      <span className="text-ink-500">{formatDateTime(event.timestamp, language)}</span>
                    </div>
                    <p className="selectable mt-1 break-all text-ink-600">{event.method ? `${event.method} ` : ""}{event.status ? `${event.status} ` : ""}{event.url || event.resource_type || "-"}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-500">{text.noRecording}</p>
            )}
          </ResizableAgentPanel>
        </aside>
      </div>
      )}
      <Modal
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>
              {copy.common.cancel}
            </Button>
            <Button
              disabled={isRunning}
              onClick={() => {
                if (deleteTarget) {
                  void deleteSession(deleteTarget.session_id);
                }
              }}
              variant="danger"
            >
              {text.deleteSession}
            </Button>
          </>
        }
        open={Boolean(deleteTarget)}
        title={text.deleteSession}
        widthClass="max-w-md"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm leading-6 text-ink-700">{text.deleteSessionConfirm}</p>
        <p className="mt-3 truncate rounded-xl bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.title || text.untitledSession}
        </p>
      </Modal>
    </div>
  );
}
