import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  CircleStop,
  ClipboardList,
  FileSearch,
  History,
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
  AgentRecordingEvent,
  AgentRecordingSummary,
  AutomationTask,
  AutomationTaskDraft,
  BrowserContextSnapshot,
  Environment,
  RunArtifact,
  RunArtifactContent,
  RunLog,
  Settings,
  TaskRun,
  TaskRunStatus,
} from "@/types/domain";

const MarkdownMessageRenderer = lazy(() =>
  import("@/components/MarkdownMessage").then((module) => ({
    default: module.MarkdownMessage,
  })),
);

type ChatMessage = AgentChatMessage;
type OpenAIMessage = AgentOpenAIMessage;
type ToolCall = AgentToolCall;

type AttachedReference = {
  id: string;
  label: string;
  detail: string;
  content: string;
};

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
  {
    type: "function",
    function: {
      name: "task_list",
      description: "列出本地任务编排摘要，用于查找需要完善或排障的任务。",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_get",
      description: "读取指定任务编排的完整脚本和配置。",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_save",
      description: "创建或更新任务编排。提供 task_id 时更新已有任务；不提供时创建新任务。修改前应先读取任务和相关运行日志。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "已有任务 ID；为空时创建新任务。" },
          name: { type: "string" },
          description: { type: "string" },
          script: { type: "string" },
          timeout_sec: { type: "integer", minimum: 5, maximum: 3600 },
          permissions: {
            type: "object",
            properties: {
              screenshots: { type: "boolean" },
              external_urls: { type: "array", items: { type: "string" } },
              clipboard: { type: "boolean" },
            },
          },
        },
        required: ["name", "script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_runs",
      description: "读取任务或环境的运行记录摘要，常用于定位失败运行。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          environment_id: { type: "string" },
          status: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_run_logs",
      description: "读取指定运行记录的日志，用于根据真实失败信息完善任务编排。",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["run_id"],
      },
    },
  },
] as const;

function buildSystemPrompt(environment?: Environment) {
  return `你是 Orbit Browser 的 AI Agent，负责用对话方式协助用户操作本地隔离浏览器环境。\n\n规则：\n1. 你可以通过工具读取页面上下文、打开 URL、点击、输入、等待、执行 JS、开始/停止录制网络资源。\n2. 操作浏览器前必须优先读取上下文，必要时解释你下一步会做什么。\n3. selector 必须来自 browser_context 返回的 interactive_elements.selector，或来自 browser_evaluate 实时查询到的 DOM 结果。严禁使用“已知 selector”、经验 selector、猜测 selector。\n4. 如果没有目标元素或 selector 不确定，不要继续猜测；必须再次调用 browser_context，或用 browser_evaluate 查询页面 DOM 后再操作。\n5. 工具调用失败时，先读取最新上下文再恢复，不要重复使用失败 selector。\n6. 浏览器操作后总结结果，若失败，给出可恢复建议。\n7. 浏览器工具结果可能包含 artifacts 引用。常规任务优先使用摘要中的 visible_text 与 interactive_elements；只有摘要不足时才调用 agent_read_artifact 读取完整片段。
8. 当用户要求完善、修复或优化任务编排时，优先引用或读取相关任务、最近运行记录和失败日志，再给出修改建议；用户要求直接保存时，可调用 task_save 创建或更新任务编排。
9. 回复使用简体中文，简洁专业。\n\n当前环境：${environment ? `${environment.name} (${environment.id})` : "未选择"}`;
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

function stripJsonCodeFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeGeneratedTaskDraft(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("AI 未返回有效的任务 JSON");
  }

  const name = String(value.name ?? "").trim();
  const script = String(value.script ?? "").trim();
  if (!name || !script) {
    throw new Error("AI 返回的任务缺少 name 或 script 字段");
  }

  const timeout = Number(value.timeout_sec ?? value.timeoutSec ?? 120);
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  const externalUrls = Array.isArray(permissions.external_urls)
    ? permissions.external_urls.filter((item): item is string => typeof item === "string")
    : ["<all_urls>"];

  return {
    name: name.slice(0, 80),
    description: String(value.description ?? "由智能助手根据当前聊天记录生成。").trim(),
    script,
    timeout_sec: Number.isFinite(timeout) ? Math.min(3600, Math.max(5, Math.round(timeout))) : 120,
    api_version: "v1",
    permissions: {
      screenshots: typeof permissions.screenshots === "boolean" ? permissions.screenshots : true,
      external_urls: externalUrls.length ? externalUrls : ["<all_urls>"],
      clipboard: typeof permissions.clipboard === "boolean" ? permissions.clipboard : true,
    },
  };
}

function buildTaskReference(task: AutomationTask) {
  return `[引用任务编排]
任务ID: ${task.id}
任务名称: ${task.name}
描述: ${task.description || "无"}
超时时间: ${task.timeout_sec} 秒
API版本: ${task.api_version}
权限: ${JSON.stringify(task.permissions ?? {})}

脚本:
\`\`\`js
${truncateText(task.script, 20000)}
\`\`\`
[/引用任务编排]`;
}

function buildRunLogsReference(
  run: TaskRun,
  logs: RunLog[],
  taskName: string,
  environmentName: string,
) {
  const recentLogs = logs.slice(-120).map((log) => {
    const time = log.created_at ? formatDateTime(log.created_at) : "-";
    const data = log.data_json ? ` data=${truncateText(log.data_json, 600)}` : "";
    return `#${log.seq} [${log.level}] ${time} ${log.message}${data}`;
  });

  return `[引用运行记录日志]
运行ID: ${run.id}
批次ID: ${run.batch_id || "无"}
任务: ${taskName} (${run.task_id})
环境: ${environmentName} (${run.environment_id})
状态: ${run.status}
尝试次数: ${run.attempt}
排队时间: ${run.queued_at || "-"}
开始时间: ${run.started_at || "-"}
结束时间: ${run.finished_at || "-"}
错误: ${run.error_message || run.error_code || "无"}

最近日志:
${recentLogs.length ? recentLogs.join("\n") : "无日志"}
[/引用运行记录日志]`;
}

function buildRunArtifactReference(
  artifact: RunArtifact,
  content: RunArtifactContent,
  taskName: string,
) {
  return `[引用产物文件]
文件: ${artifact.label}
类型: ${artifact.kind}
路径: ${artifact.path}
来源运行: ${artifact.run_id}
来源任务: ${taskName}
大小: ${content.bytes} bytes
是否截断: ${content.truncated ? "是" : "否"}

内容:
\`\`\`
${content.content}
\`\`\`
[/引用产物文件]`;
}

function formatRecordingEventLine(event: AgentRecordingEvent, index: number) {
  return `#${index + 1} [${event.kind}] ${event.method || "-"} ${event.status ?? "-"} ${event.resource_type || "-"} ${event.title || ""} ${event.url || ""} @ ${event.timestamp}`.trim();
}

function buildRecordingReference(summary: AgentRecordingSummary, event?: AgentRecordingEvent) {
  if (event) {
    return `[引用录制事件产物]
环境ID: ${summary.environment_id}
录制状态: ${summary.is_recording ? "录制中" : "已停止"}
开始时间: ${summary.started_at || "-"}
停止时间: ${summary.stopped_at || "-"}

事件类型: ${event.kind}
请求方法: ${event.method || "-"}
URL: ${event.url || "-"}
状态码: ${event.status ?? "-"}
资源类型: ${event.resource_type || "-"}
标题: ${event.title || "-"}
时间: ${event.timestamp}
[/引用录制事件产物]`;
  }

  const events = summary.events.slice(-120).map(formatRecordingEventLine);
  return `[引用录制事件产物]
环境ID: ${summary.environment_id}
录制状态: ${summary.is_recording ? "录制中" : "已停止"}
开始时间: ${summary.started_at || "-"}
停止时间: ${summary.stopped_at || "-"}
事件总数: ${summary.total_events}
请求数: ${summary.total_requests}
响应数: ${summary.total_responses}

最近事件:
${events.length ? events.join("\n") : "无事件"}
[/引用录制事件产物]`;
}

function extractRecordingSummariesFromMessages(messages: ChatMessage[]): AgentRecordingSummary[] {
  return messages.flatMap((message) => {
    if (message.role !== "tool" || !message.toolName?.startsWith("recording_")) return [];
    const jsonStart = message.content.indexOf("{");
    if (jsonStart < 0) return [];

    try {
      const envelope = JSON.parse(message.content.slice(jsonStart));
      const value = envelope.summary ?? envelope.result;
      if (!isRecord(value) || !Array.isArray(value.events)) return [];
      return [value as unknown as AgentRecordingSummary];
    } catch {
      return [];
    }
  });
}

function getActiveAtMention(value: string, cursor: number) {
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < 0) return null;
  if (atIndex > 0 && !/\s/.test(beforeCursor[atIndex - 1])) return null;

  const query = beforeCursor.slice(atIndex + 1);
  if (/\s/.test(query)) return null;

  return { atIndex, query: query.toLowerCase() };
}

function compactTaskForModel(task: AutomationTask, includeScript = false) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    timeout_sec: task.timeout_sec,
    api_version: task.api_version,
    permissions: task.permissions,
    updated_at: task.updated_at,
    script_lines: task.script.split("\n").length,
    ...(includeScript
      ? { script: truncateText(task.script, 24000) }
      : { script_preview: truncateText(task.script, 1600) }),
  };
}

function compactRunForModel(run: TaskRun) {
  return {
    id: run.id,
    batch_id: run.batch_id,
    task_id: run.task_id,
    environment_id: run.environment_id,
    status: run.status,
    attempt: run.attempt,
    queued_at: run.queued_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error_code: run.error_code,
    error_message: truncateText(run.error_message, 1200),
  };
}

function compactRunLogForModel(log: RunLog) {
  return {
    seq: log.seq,
    level: log.level,
    message: truncateText(log.message, 1200),
    data_json: log.data_json ? truncateText(log.data_json, 1200) : null,
    created_at: log.created_at,
  };
}

function createTaskDraftFromToolArgs(
  args: Record<string, unknown>,
  existingTask?: AutomationTask,
): AutomationTaskDraft {
  const name = String(args.name ?? existingTask?.name ?? "").trim();
  const script = String(args.script ?? existingTask?.script ?? "").trim();
  if (!name) throw new Error("Missing required field: name");
  if (!script) throw new Error("Missing required field: script");

  const timeout = Number(args.timeout_sec ?? existingTask?.timeout_sec ?? 120);
  const permissions = isRecord(args.permissions) ? args.permissions : existingTask?.permissions;
  const externalUrls = isRecord(permissions) && Array.isArray(permissions.external_urls)
    ? permissions.external_urls.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : existingTask?.permissions?.external_urls ?? ["<all_urls>"];

  return {
    ...(typeof args.task_id === "string" && args.task_id.trim() ? { id: args.task_id.trim() } : existingTask?.id ? { id: existingTask.id } : {}),
    name: name.slice(0, 120),
    description: String(args.description ?? existingTask?.description ?? "").trim(),
    script,
    timeout_sec: Number.isFinite(timeout) ? Math.min(3600, Math.max(5, Math.round(timeout))) : 120,
    api_version: existingTask?.api_version ?? "v1",
    permissions: {
      screenshots: isRecord(permissions) && typeof permissions.screenshots === "boolean"
        ? permissions.screenshots
        : existingTask?.permissions?.screenshots ?? true,
      external_urls: externalUrls.length ? externalUrls : ["<all_urls>"],
      clipboard: isRecord(permissions) && typeof permissions.clipboard === "boolean"
        ? permissions.clipboard
        : existingTask?.permissions?.clipboard ?? true,
    },
  };
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

function resolveAgentEnvironmentId(
  environments: Environment[],
  currentEnvironmentId: string,
  persistedEnvironmentId: string | null,
): string {
  if (environments.some((item) => item.id === currentEnvironmentId)) {
    return currentEnvironmentId;
  }
  if (
    persistedEnvironmentId &&
    environments.some((item) => item.id === persistedEnvironmentId)
  ) {
    return persistedEnvironmentId;
  }
  return environments[0]?.id ?? "";
}

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
      className={`panel relative flex min-h-0 flex-col overflow-hidden shadow-none ${
        fillRemaining && !collapsed ? "flex-1" : "shrink-0"
      }`}
      style={
        fillRemaining && !collapsed
          ? undefined
          : { height: collapsed ? COLLAPSED_AGENT_PANEL_HEIGHT : height }
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
          <span className="truncate">{title}</span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-ink-500 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        {!collapsed && actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {!collapsed ? <div className="scroll-panel min-h-0 min-w-0 flex-1 overflow-x-hidden p-3.5">{children}</div> : null}

      {!collapsed && !fillRemaining ? (
        <button
          aria-label={`Resize ${title}`}
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
  const queryClient = useQueryClient();
  const setHeaderActions = useUiStore((state) => state.setHeaderActions);
  const { copy, language } = useI18n();
  const text = copy.agent;
  const [environmentId, setEnvironmentId] = useState(agentRuntimeRefs.environmentId);
  const [sessionId, setSessionId] = useState(agentRuntimeRefs.sessionId);
  const [deleteTarget, setDeleteTarget] = useState<AgentHistorySession | null>(null);
  const [input, setInput] = useState("");
  const [isGeneratingTask, setIsGeneratingTask] = useState(false);
  const [isResolvingMention, setIsResolvingMention] = useState(false);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [activeMention, setActiveMention] = useState<{ atIndex: number; query: string } | null>(null);
  const [attachedReferences, setAttachedReferences] = useState<AttachedReference[]>([]);
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: browserApi.listTasks,
  });

  const runsQuery = useQuery({
    queryKey: ["runs", "agent-reference"],
    queryFn: () => browserApi.listRuns({ status: "all" }),
  });

  const runArtifactsQuery = useQuery({
    enabled: Boolean(runsQuery.data?.length),
    queryKey: ["run-artifacts", "agent-mentions", (runsQuery.data ?? []).slice(0, 25).map((run) => run.id).join(",")],
    queryFn: async () => {
      const recentRuns = (runsQuery.data ?? []).slice(0, 25);
      const artifactGroups = await Promise.all(
        recentRuns.map(async (run) => ({
          run,
          artifacts: await browserApi.listRunArtifacts(run.id),
        })),
      );
      return artifactGroups.flatMap(({ run, artifacts }) =>
        artifacts.map((artifact) => ({ run, artifact })),
      );
    },
  });

  const selectedEnvironment = useMemo(
    () => environmentsQuery.data?.find((item) => item.id === environmentId),
    [environmentId, environmentsQuery.data],
  );

  const taskNameById = (taskId: string) =>
    tasksQuery.data?.find((task) => task.id === taskId)?.name ?? taskId;

  const environmentNameById = (targetEnvironmentId: string) =>
    environmentsQuery.data?.find((environment) => environment.id === targetEnvironmentId)?.name ??
    targetEnvironmentId;

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
    if (!environmentId || !selectedEnvironment) return;

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
  }, [environmentId, selectedEnvironment?.id]);

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
  const ready = Boolean(selectedEnvironment && aigcConfigured);

  useEffect(() => {
    const environments = environmentsQuery.data;
    if (!environments || isRunning) return;

    const lastEnvironmentId =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(LAST_AGENT_ENVIRONMENT_KEY);
    const nextEnvironmentId = resolveAgentEnvironmentId(
      environments,
      environmentId,
      lastEnvironmentId,
    );
    if (nextEnvironmentId === environmentId) return;

    setEnvironmentId(nextEnvironmentId);
    if (!nextEnvironmentId) {
      agentRuntimeRefs.environmentId = "";
      agentRuntimeRefs.sessionId = "";
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LAST_AGENT_ENVIRONMENT_KEY);
      }
    }
  }, [environmentId, environmentsQuery.data, isRunning]);

  useEffect(() => {
    if (!selectedEnvironment || typeof window === "undefined") return;
    agentRuntimeRefs.environmentId = environmentId;
    window.localStorage.setItem(LAST_AGENT_ENVIRONMENT_KEY, environmentId);
  }, [environmentId, selectedEnvironment?.id]);

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

    if (name === "task_list") {
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const tasks = await browserApi.listTasks();
      throwIfStopped();
      const result = {
        total: tasks.length,
        tasks: tasks.slice(0, limit).map((task) => compactTaskForModel(task)),
      };
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "task_get") {
      const taskId = typeof args.task_id === "string" ? args.task_id : "";
      if (!taskId) throw new Error("Missing required field: task_id");
      const tasks = await browserApi.listTasks();
      throwIfStopped();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const modelResult = createToolSuccessEnvelope(name, compactTaskForModel(task, true));
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "task_save") {
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      const tasks = taskId ? await browserApi.listTasks() : [];
      throwIfStopped();
      const existingTask = taskId ? tasks.find((item) => item.id === taskId) : undefined;
      if (taskId && !existingTask) throw new Error(`Task not found: ${taskId}`);

      const draft = createTaskDraftFromToolArgs(args, existingTask);
      const validation = await browserApi.validateTaskScript(draft.script);
      throwIfStopped();
      if (!validation.valid) {
        const modelResult = createToolSuccessEnvelope(name, {
          saved: false,
          validation,
          message: "脚本校验未通过，任务未保存。请根据 errors 修正后重新调用 task_save。",
        });
        markToolDone(modelResult);
        return modelResult;
      }

      const task = await browserApi.saveTask(draft);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      throwIfStopped();
      const modelResult = createToolSuccessEnvelope(name, {
        saved: true,
        mode: existingTask ? "updated" : "created",
        validation,
        task: compactTaskForModel(task, true),
      });
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "task_runs") {
      const limit = typeof args.limit === "number" ? args.limit : 30;
      const status = typeof args.status === "string" ? args.status : "all";
      const runs = await browserApi.listRuns({
        task_id: typeof args.task_id === "string" ? args.task_id : undefined,
        environment_id: typeof args.environment_id === "string" ? args.environment_id : undefined,
        status: status as TaskRunStatus | "all",
      });
      throwIfStopped();
      const result = {
        total: runs.length,
        runs: runs.slice(0, limit).map(compactRunForModel),
      };
      const modelResult = createToolSuccessEnvelope(name, result);
      markToolDone(modelResult);
      return modelResult;
    }

    if (name === "task_run_logs") {
      const runId = typeof args.run_id === "string" ? args.run_id : "";
      if (!runId) throw new Error("Missing required field: run_id");
      const limit = typeof args.limit === "number" ? args.limit : 80;
      const logs = await browserApi.getRunLogs(runId);
      throwIfStopped();
      const result = {
        run_id: runId,
        total_logs: logs.length,
        logs: logs.slice(-limit).map(compactRunLogForModel),
      };
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

    const references = attachedReferences;
    const referenceContext = references.length
      ? `\n\n[引用上下文]\n${references
          .map((item) => `${item.label} ${item.detail}\n${item.content}`)
          .join("\n\n")}\n[/引用上下文]`
      : "";
    const modelContent = `${content}${referenceContext}`;
    const visibleContent = references.length
      ? `${content}\n\n${text.attachedReferences}: ${references.map((item) => item.label).join(", ")}`
      : content;

    setInput("");
    setAttachedReferences([]);
    setError(null);
    setIsRunning(true);
    agentRuntimeRefs.stopped = false;
    const runId = agentRuntimeRefs.runId + 1;
    agentRuntimeRefs.runId = runId;
    agentRuntimeRefs.abort = new AbortController();

    agentRuntimeRefs.environmentId = environmentId;
    agentRuntimeRefs.sessionId = sessionId;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: visibleContent };
    appendVisible(userMessage);

    const baseHistory: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(selectedEnvironment) },
      ...compactApiHistoryForModel(apiMessages),
      { role: "user", content: modelContent },
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

  type MentionSuggestion = {
    id: string;
    kind: "task" | "run" | "file" | "recording";
    label: string;
    detail: string;
    resolve: () => Promise<string> | string;
  };

  const mentionSuggestions = useMemo<MentionSuggestion[]>(() => {
    const taskSuggestions: MentionSuggestion[] = (tasksQuery.data ?? []).map((task) => ({
      id: `task:${task.id}`,
      kind: "task",
      label: `@${task.name}`,
      detail: `${text.mentionTask} · ${task.description || copy.common.noDescription}`,
      resolve: () => buildTaskReference(task),
    }));

    const runSuggestions: MentionSuggestion[] = (runsQuery.data ?? []).slice(0, 50).map((run) => ({
      id: `run:${run.id}`,
      kind: "run",
      label: `@${taskNameById(run.task_id)} / ${run.status}`,
      detail: `${text.mentionRun} · ${environmentNameById(run.environment_id)} · ${formatDateTime(run.started_at ?? run.queued_at, language)}`,
      resolve: async () => {
        const logs = await browserApi.getRunLogs(run.id);
        return buildRunLogsReference(
          run,
          logs,
          taskNameById(run.task_id),
          environmentNameById(run.environment_id),
        );
      },
    }));

    const fileSuggestions: MentionSuggestion[] = (runArtifactsQuery.data ?? []).map(({ run, artifact }) => ({
      id: `file:${artifact.path}`,
      kind: "file",
      label: `@${artifact.label}`,
      detail: `${text.mentionFile} · ${artifact.kind} · ${taskNameById(run.task_id)}`,
      resolve: async () => {
        const content = await browserApi.readRunArtifact(artifact.path, 60_000);
        return buildRunArtifactReference(artifact, content, taskNameById(run.task_id));
      },
    }));

    const recordingSummaries = [
      ...(recording ? [recording] : []),
      ...extractRecordingSummariesFromMessages(messages),
    ].filter((item, index, items) =>
      items.findIndex((candidate) =>
        candidate.environment_id === item.environment_id &&
        candidate.started_at === item.started_at &&
        candidate.stopped_at === item.stopped_at,
      ) === index,
    );

    const recordingSuggestions: MentionSuggestion[] = recordingSummaries.flatMap((summary, summaryIndex) => {
      const summarySuggestion: MentionSuggestion = {
        id: `recording:${summary.environment_id}:${summary.started_at ?? summaryIndex}`,
        kind: "recording",
        label: `@${text.mentionRecording} ${summary.total_events}`,
        detail: `${text.mentionRecording} · ${summary.is_recording ? text.recordingActive : text.recordingStopped} · ${summary.total_requests}/${summary.total_responses}`,
        resolve: () => buildRecordingReference(summary),
      };

      const eventSuggestions = summary.events.slice(-30).map((event, eventIndex) => ({
        id: `recording-event:${summary.environment_id}:${summary.started_at ?? summaryIndex}:${event.timestamp}:${eventIndex}`,
        kind: "recording" as const,
        label: `@${event.title || event.resource_type || event.kind}`,
        detail: `${text.mentionRecording} · ${event.method || "-"} ${event.status ?? "-"} · ${truncateText(event.url, 120)}`,
        resolve: () => buildRecordingReference(summary, event),
      }));

      return [summarySuggestion, ...eventSuggestions];
    });

    return [...taskSuggestions, ...runSuggestions, ...fileSuggestions, ...recordingSuggestions];
  }, [copy.common.noDescription, environmentNameById, language, messages, recording, runArtifactsQuery.data, runsQuery.data, taskNameById, tasksQuery.data, text.mentionFile, text.mentionRecording, text.mentionRun, text.mentionTask, text.recordingActive, text.recordingStopped]);

  const filteredMentionSuggestions = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query;
    return mentionSuggestions
      .filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query))
      .slice(0, 10);
  }, [activeMention, mentionSuggestions]);

  const updateInputWithMentionState = (value: string, cursor: number) => {
    setInput(value);
    setMentionCursor(cursor);
    setActiveMention(getActiveAtMention(value, cursor));
  };

  const insertMentionReference = async (suggestion: MentionSuggestion) => {
    if (!activeMention) return;

    setError(null);
    setIsResolvingMention(true);
    try {
      const reference = await suggestion.resolve();
      const compactLabel = suggestion.label.replace(/^@/, "");
      const token = `@${compactLabel}`;
      const before = input.slice(0, activeMention.atIndex);
      const after = input.slice(mentionCursor);
      const nextInput = `${before}${token} ${after.trimStart()}`;
      const nextCursor = before.length + token.length + 1;
      setInput(nextInput);
      setAttachedReferences((current) => [
        ...current.filter((item) => item.id !== suggestion.id),
        {
          id: suggestion.id,
          label: token,
          detail: suggestion.detail,
          content: reference,
        },
      ]);
      setActiveMention(null);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsResolvingMention(false);
    }
  };

  const generateTaskFromChat = async () => {
    const settings = settingsQuery.data;
    if (!settings || !ready || isRunning || isGeneratingTask || messages.length === 0) return;

    setError(null);
    setIsGeneratingTask(true);

    try {
      const compactMessages = messages
        .filter((message) => message.role !== "tool")
        .slice(-30)
        .map((message) => ({
          role: message.role,
          content: truncateText(message.content, message.role === "assistant" ? 3000 : 2000),
        }));
      const toolSummaries = messages
        .filter((message) => message.role === "tool")
        .slice(-10)
        .map((message) => ({
          tool: message.toolName ?? "tool",
          content: truncateText(compactStoredToolContent(message.content), 1200),
        }));

      const response = await fetch(`${normalizeBaseUrl(settings.aigc_base_url ?? "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aigc_api_key}`,
        },
        body: JSON.stringify({
          model: settings.aigc_model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: `你是 Orbit Browser 自动化任务编排生成器。请根据聊天记录生成一个可直接保存的自动化任务。

只返回 JSON 对象，不要 Markdown。字段：
- name: 简短任务名
- description: 任务目标、关键步骤和来源说明
- timeout_sec: 5 到 3600 的整数
- permissions: { screenshots: boolean, external_urls: string[], clipboard: boolean }
- script: JavaScript 自动化脚本

脚本运行在 Orbit Browser task runtime，常用 API：
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.click(selector);
await page.type(selector, text);
await page.wait(selector, { timeout: 10000 });
const value = await page.evaluate(() => ({ url: location.href, title: document.title }));
await page.screenshot("label");
await run.outputJson("label", value);
log.info("message");

要求：
1. 优先复用聊天中已经验证过的 URL、selector、页面观察结果和操作顺序。
2. selector 不确定时，在脚本中通过 page.evaluate 查询候选元素，不要硬编码猜测。
3. 脚本要有关键日志、必要等待、错误边界和输出产物。
4. 不要包含解释性文字，只返回 JSON。`,
            },
            {
              role: "user",
              content: JSON.stringify({
                environment: selectedEnvironment
                  ? { id: selectedEnvironment.id, name: selectedEnvironment.name, start_url: selectedEnvironment.start_url }
                  : null,
                chat_messages: compactMessages,
                browser_tool_summaries: toolSummaries,
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`);
      }

      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("AI 未返回任务内容");
      }

      const draft = normalizeGeneratedTaskDraft(JSON.parse(stripJsonCodeFence(content)));
      const task = await browserApi.saveTask(draft);
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text.generateTaskDone.replace("{{name}}", task.name),
      };
      appendVisible(assistantMessage);
      await persistRuntimeSnapshot();
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsGeneratingTask(false);
    }
  };

  const refreshContext = async () => {
    if (!selectedEnvironment) return;
    const result = await browserApi.agentBrowserAction({
      environment_id: selectedEnvironment.id,
      action: "context",
      include_screenshot: false,
    });
    setContext(result as BrowserContextSnapshot);
    expandSidePanel("context");
  };

  const toggleRecording = async () => {
    if (!selectedEnvironment) return;
    const result = recording?.is_recording
      ? await browserApi.agentStopBrowserRecording(selectedEnvironment.id)
      : await browserApi.agentStartBrowserRecording(selectedEnvironment.id);
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
          disabled={!selectedEnvironment || isRunning}
        >
          {text.newSession}
        </Button>

        <Button
          icon={isGeneratingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
          onClick={generateTaskFromChat}
          disabled={!ready || isRunning || isGeneratingTask || messages.length === 0}
          variant="primary"
        >
          {text.generateTask}
        </Button>

        <Button
          icon={<FileSearch className="h-4 w-4" />}
          onClick={refreshContext}
          disabled={!selectedEnvironment}
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
          disabled={!selectedEnvironment}
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
    messages.length,
    isGeneratingTask,
    recording?.is_recording,
    setHeaderActions,
    text.generateTask,
    text.newSession,
    text.readContext,
    text.startRecording,
    text.stopRecording,
  ]);

  return (
    <div className="h-full min-h-0 w-full">
      {!aigcConfigured ? (
        <section className="panel flex h-full min-h-0 items-center justify-center p-6">
          <div className="max-w-lg px-8 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-ink-50 text-brand-600">
              <Settings2 className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-ink-900">
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
      <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_320px] gap-3">
        <section className="panel grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden shadow-none">
          <div ref={scrollRef} className="scroll-panel min-w-0 px-5 py-4">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[420px] items-center justify-center p-4">
                <EmptyState
                  className="w-full max-w-lg border-0 bg-transparent shadow-none"
                  icon={<Bot className="h-5 w-5" />}
                  title={text.emptyTitle}
                  description={text.emptyDescription}
                />
              </div>
            ) : (
              <div className="mx-auto grid w-full max-w-4xl min-w-0 gap-5">
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
                      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-50 text-brand-600">
                        {message.role === "tool" ? <SquareTerminal className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                      </div>
                    ) : null}
                    <div className={`agent-message-bubble min-w-0 rounded-xl px-4 py-3 text-sm leading-6 ${
                      message.role === "user"
                        ? "bg-brand-600 text-white"
                        : message.role === "tool"
                          ? "border border-line bg-ink-50 text-ink-600"
                          : "bg-transparent text-ink-900"
                    }`}>
                      {message.role === "tool" ? (
                        <div className="min-w-0">
                          <button
                            className="control-focus flex w-full cursor-pointer items-center justify-between gap-3 rounded-md text-left"
                            onClick={() => toggleToolMessage(message.id)}
                            type="button"
                          >
                            <span className="min-w-0 flex-1 overflow-hidden">
                              <span className="block truncate text-xs font-semibold text-brand-600">
                                {message.toolName ?? "tool"}
                              </span>
                              <span className="block truncate text-[11px] leading-4 text-ink-500">
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
                      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-700">
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

          <div className="border-t border-line bg-white p-3">
            {error ? <div className="mb-2 rounded-lg border border-danger/20 bg-red-50 px-3 py-2 text-sm text-danger">{error}</div> : null}
            <div className="mx-auto min-w-0 max-w-4xl overflow-hidden rounded-xl border border-line bg-white transition-colors duration-200 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/10">
              {activeMention ? (
                <div className="agent-mention-popover min-w-0 max-w-full overflow-hidden border-b border-line bg-ink-50 px-2 py-1.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] leading-4 text-ink-500">
                    <span>{text.atCommandHint}</span>
                    {isResolvingMention ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  </div>
                  {filteredMentionSuggestions.length > 0 ? (
                    <div className="grid min-w-0 gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
                      {filteredMentionSuggestions.map((suggestion) => (
                        <button
                          className="control-focus flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60"
                          disabled={isResolvingMention}
                          key={suggestion.id}
                          onClick={() => void insertMentionReference(suggestion)}
                          type="button"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-brand-600">
                            {suggestion.kind === "task" ? (
                              <ClipboardList className="h-3.5 w-3.5" />
                            ) : suggestion.kind === "run" ? (
                              <History className="h-3.5 w-3.5" />
                            ) : suggestion.kind === "recording" ? (
                              <Network className="h-3.5 w-3.5" />
                            ) : (
                              <FileSearch className="h-3.5 w-3.5" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 overflow-hidden">
                            <span className="block truncate text-xs font-medium leading-4 text-ink-900">
                              {suggestion.label}
                            </span>
                            <span className="block truncate text-[11px] leading-4 text-ink-500">
                              {suggestion.detail}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-ink-500">
                      {text.noAtCommandMatches}
                    </p>
                  )}
                </div>
              ) : null}
              {attachedReferences.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1.5 border-b border-line px-2 py-1.5">
                  {attachedReferences.map((reference) => (
                    <span
                      className="inline-flex max-w-full items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[11px] font-medium leading-4 text-ink-700"
                      key={reference.id}
                      title={reference.detail}
                    >
                      <span className="truncate">{reference.label}</span>
                      <button
                        className="rounded px-0.5 text-ink-500 hover:bg-ink-100 hover:text-brand-600"
                        onClick={() => setAttachedReferences((current) => current.filter((item) => item.id !== reference.id))}
                        type="button"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                className="min-h-20 w-full max-w-full resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-500"
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
                onChange={(event) => updateInputWithMentionState(event.target.value, event.target.selectionStart)}
                onClick={(event) => updateInputWithMentionState(input, event.currentTarget.selectionStart)}
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
                  if (event.key === "Escape" && activeMention) {
                    event.preventDefault();
                    setActiveMention(null);
                    return;
                  }
                  if (event.key === "Enter" && activeMention && filteredMentionSuggestions[0]) {
                    event.preventDefault();
                    void insertMentionReference(filteredMentionSuggestions[0]);
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
                <span className="truncate text-xs text-ink-500">{text.shortcutHint}</span>
                {isRunning ? (
                  <Button
                    className="h-9 rounded-lg px-4 shadow-none"
                    icon={<CircleStop className="h-4 w-4" />}
                    onClick={stop}
                    variant="danger"
                  >
                    {text.stop}
                  </Button>
                ) : (
                  <Button
                    className="h-9 rounded-lg px-4 shadow-none disabled:bg-ink-50 disabled:text-ink-500"
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
              <div className="grid min-w-0 gap-1 overflow-hidden">
                {sessions.map((session) => {
                  const active = session.session_id === sessionId;
                  return (
                    <div
                      key={session.session_id}
                      className={`group flex min-w-0 items-center overflow-hidden rounded-lg transition-colors ${
                        active
                          ? "bg-ink-100 text-ink-900"
                          : "text-ink-700 hover:bg-ink-50 hover:text-ink-900"
                      }`}
                    >
                      <button
                        className="control-focus min-w-0 flex-1 overflow-hidden rounded-lg py-2 pl-3 pr-2 text-left disabled:cursor-default"
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
                        className="control-focus mr-1 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-400 transition hover:bg-red-50 hover:text-danger focus:text-danger disabled:cursor-not-allowed disabled:opacity-40"
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
                <div className="border-b border-line pb-3">
                  <p className="font-semibold text-ink-900">{context.title || "-"}</p>
                  <p className="selectable mt-1 break-all text-ink-500">{context.url}</p>
                </div>
                <div>
                  <p className="mb-2 font-semibold text-ink-900">{text.elements}</p>
                  <div className="min-w-0 divide-y divide-line overflow-hidden rounded-lg border border-line">
                    {context.interactive_elements.slice(0, 8).map((item) => (
                      <div key={`${item.kind}-${item.selector}`} className="px-3 py-2">
                        <p className="font-medium text-ink-800">{item.label || item.kind}</p>
                        <p className="selectable mt-1 break-all font-mono text-[11px] text-ink-500">{item.selector}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 font-semibold text-ink-900">{text.visibleText}</p>
                  <p className="selectable max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-50 p-3 leading-5">{context.visible_text || "-"}</p>
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
                <div className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
                  <span className="text-ink-600">{recording.is_recording ? text.recordingActive : text.recordingStopped}</span>
                  <span className="font-semibold text-ink-900">{recording.total_events}</span>
                </div>
                {recording.events.slice(-10).reverse().map((event, index) => (
                  <div key={`${event.timestamp}-${index}`} className="border-b border-line px-1 py-2 last:border-b-0">
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
        <p className="mt-3 truncate rounded-lg bg-ink-50 px-3 py-2 text-sm font-medium text-ink-900">
          {deleteTarget?.title || text.untitledSession}
        </p>
      </Modal>
    </div>
  );
}
