/** Append-only window state. Only the outgoing projection is shortened.
 * Unlike the reference's no-summary CompactionEntry, this preserves Pi's full
 * in-memory/local history so disabling Remote Context can restore local context.
 */
import { randomUUID } from "node:crypto";
import { isRecord } from "../config.ts";
import { projectToolResult, type Json } from "./protocol.ts";

export const WINDOW_TYPE = "openai-server-context-window";
export const FALLBACK_BUFFER = 16_384;
export type WindowState = {
  protocol: 1;
  id: string;
  sessionId: string;
  scope: string;
  kind: "window" | "reminder" | "fallback";
  firstWindowId: string;
  currentWindowId: string;
  previousWindowId?: string;
  windowNumber: number;
  trimPreviousWindow: boolean;
};

function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

export function marker(value: unknown, sessionId: string, scope?: string): WindowState | undefined {
  if (!isRecord(value) || value.customType !== WINDOW_TYPE) return undefined;
  const details = value.details;
  const record = isRecord(details) ? details.remoteContext : undefined;
  if (isRecord(record) && ((record.sessionId !== undefined && record.sessionId !== sessionId) ||
    (scope !== undefined && record.scope !== undefined && record.scope !== scope))) return undefined;
  if (!isRecord(record) || record.protocol !== 1 || !nonempty(record.id) ||
      !nonempty(record.sessionId) || !nonempty(record.scope) || !nonempty(record.firstWindowId) ||
      !nonempty(record.currentWindowId) || !Number.isSafeInteger(record.windowNumber) ||
      (record.windowNumber as number) < 0 || typeof record.trimPreviousWindow !== "boolean" ||
      !["window", "reminder", "fallback"].includes(String(record.kind)) ||
      (record.previousWindowId !== undefined && !nonempty(record.previousWindowId))) {
    throw new Error("Malformed persisted Remote Context window");
  }
  return record as WindowState;
}

export function latestWindow(entries: readonly unknown[], sessionId: string, scope: string): WindowState | undefined {
  let result: WindowState | undefined;
  for (const entry of entries) {
    const record = marker(entry, sessionId, scope);
    if (record?.kind === "window") result = record;
  }
  return result;
}

export function nextWindow(entries: readonly unknown[], sessionId: string, scope: string, current?: WindowState): WindowState {
  const id = randomUUID();
  let number = -1;
  for (const entry of entries) {
    const record = marker(entry, sessionId);
    if (record?.kind === "window") number = Math.max(number, record.windowNumber);
  }
  return {
    protocol: 1, id: randomUUID(), sessionId, scope, kind: "window",
    firstWindowId: current?.firstWindowId ?? id, currentWindowId: id,
    ...(current ? { previousWindowId: current.currentWindowId } : {}),
    windowNumber: Math.max(number + 1, current ? current.windowNumber + 1 : 0),
    // Initial activation must NOT throw away pre-existing session history.
    trimPreviousWindow: current !== undefined,
  };
}

export function metadataFor(window: WindowState): Json {
  return {
    session_id: window.sessionId, thread_id: window.sessionId, agent_name: "/root",
    window_id: `${window.sessionId}:${window.windowNumber}`, window_number: window.windowNumber,
    context_window_id: window.currentWindowId, request_kind: "turn", history_ingest_requested: true,
  };
}

export function windowMessage(window: WindowState, hint?: string) {
  const content = [
    "<context_window_guidance>",
    "Checkpoint the active request, known history IDs, decisions, progress and next steps in notes before new_context; no summary carries over.",
    "After rollover, read hinted notes (or list note files when no hint is available). Use history for missing details. Never store credentials in notes.",
    "</context_window_guidance>", "<context_window>", "Agent name: /root",
    `First context window id: ${window.firstWindowId}`, `Current context window id: ${window.currentWindowId}`,
    ...(window.previousWindowId ? [`Previous context window id: ${window.previousWindowId}`] : []),
    ...(hint ? [hint] : []), "</context_window>",
  ].join("\n");
  return { customType: WINDOW_TYPE, content, display: true, details: { remoteContext: window } };
}

/** Remove internal messages when off, and only project ciphertext for its own scope. */
export function projectMessages<T>(messages: T[], window?: WindowState): T[] {
  let boundary = -1;
  if (window) {
    for (let i = 0; i < messages.length; i++) {
      const record = marker(messages[i], window.sessionId, window.scope);
      if (record?.kind === "window" && record.currentWindowId === window.currentWindowId && record.trimPreviousWindow) boundary = i;
    }
  }
  const visible = (boundary < 0 ? messages : messages.slice(boundary)).filter((message) => {
    if (!isRecord(message) || message.customType !== WINDOW_TYPE) return true;
    if (!window) return false;
    const record = marker(message, window.sessionId, window.scope);
    return record?.currentWindowId === window.currentWindowId;
  }).map((message) => {
    const details = isRecord(message) && isRecord(message.details) ? message.details : undefined;
    const origin = details && isRecord(details.remoteContextOrigin) ? details.remoteContextOrigin : undefined;
    return projectToolResult(message, Boolean(window && origin?.scope === window.scope && origin.sessionId === window.sessionId));
  });
  if (boundary < 0) return visible;
  // Steering can be delivered before the final tool result. Never send an orphan output.
  const calls = new Set<string>();
  return visible.filter((message) => {
    if (!isRecord(message)) return true;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) if (isRecord(call) && call.type === "toolCall" && typeof call.id === "string") calls.add(call.id);
    }
    return message.role !== "toolResult" || (typeof message.toolCallId === "string" && calls.has(message.toolCallId));
  });
}

export function hasCheckpoint(entries: readonly unknown[], window: WindowState): boolean {
  let checkpoint = false;
  for (const entry of entries) {
    const record = marker(entry, window.sessionId, window.scope);
    if (record?.kind === "window") checkpoint = false;
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.isError === true || !isRecord(message.details)) continue;
    const details = message.details.remoteContextOrigin;
    if (!isRecord(details) || details.checkpoint !== true || details.sessionId !== window.sessionId ||
        details.scope !== window.scope || details.windowId !== window.currentWindowId) continue;
    checkpoint = true;
  }
  return checkpoint;
}

export function hasFreshUsage(entries: readonly unknown[], window: WindowState): boolean {
  let seenBoundary = false;
  for (const entry of entries) {
    const record = marker(entry, window.sessionId, window.scope);
    if (record?.kind === "window") seenBoundary = record.currentWindowId === window.currentWindowId;
    if (!seenBoundary || !isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || !isRecord(message.usage)) continue;
    const usage = message.usage;
    const tokens = typeof usage.totalTokens === "number" ? usage.totalTokens :
      [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce<number>((sum, n) => sum + (typeof n === "number" ? n : 0), 0);
    if (Number.isFinite(tokens) && tokens > 0) return true;
  }
  return false;
}

export function remaining(contextWindow: number, used: number | null | undefined): { contextWindow: number; remainingTokens?: number } {
  const limit = Math.max(0, contextWindow - FALLBACK_BUFFER);
  return {
    contextWindow: limit,
    ...(used != null && Number.isFinite(used) && used >= 0 ? { remainingTokens: Math.max(0, limit - used) } : {}),
  };
}

export function budgetReminder(entries: readonly unknown[], window: WindowState, percent: number, budget: ReturnType<typeof remaining>): WindowState | undefined {
  if (percent <= 0 || budget.remainingTokens === undefined || !hasFreshUsage(entries, window)) return undefined;
  const kind = budget.remainingTokens <= 0 ? "fallback" : "reminder";
  if (kind === "reminder" && budget.remainingTokens > Math.floor(budget.contextWindow * percent / 100)) return undefined;
  if (entries.some((entry) => {
    const record = marker(entry, window.sessionId, window.scope);
    return record?.currentWindowId === window.currentWindowId && record.kind === kind;
  })) return undefined;
  return { ...window, id: randomUUID(), kind };
}
