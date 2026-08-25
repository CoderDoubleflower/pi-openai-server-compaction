/**
 * Incremental Responses V2 remote-compaction protocol.
 *
 * Keeps transport/SSE parsing separate from the Pi history conversion and
 * persistence helpers in remote-compaction-core.ts.
 */
import { calculateCost, type Model } from "@earendil-works/pi-ai";
import { isRecord } from "./config.ts";
import { supportsRemoteCompactionModel } from "./openai.ts";
import {
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History as buildRemoteCompactionV2HistoryCore,
  type RemoteCompactionResult,
  type RemoteCompactionUsageSnapshot,
  type ResponseItem,
  type ResponsesReasoningConfig,
  type ResponsesTextConfig,
} from "./remote-compaction-core.ts";
import {
  buildRemoteCompactionHeaders,
  remoteCompactionV2EndpointUrl,
} from "./remote-compaction-transport.ts";

export type RemoteCompactionV2Events = {
  compactionItem: ResponseItem;
  usage?: unknown;
};

function normalizeRemoteCompactionItem(value: unknown): ResponseItem | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "compaction" && value.type !== "compaction_summary") return undefined;
  if (typeof value.encrypted_content !== "string" || value.encrypted_content.length === 0) return undefined;
  return {
    ...value,
    type: "compaction",
    encrypted_content: value.encrypted_content,
  } as ResponseItem;
}

function remoteCompactionStreamErrorMessage(
  event: Record<string, unknown>,
  fallback: string,
): string {
  const response = isRecord(event.response) ? event.response : undefined;
  const candidates = [event.error, response?.error, event];
  for (const candidate of candidates) {
    if (
      isRecord(candidate) &&
      typeof candidate.message === "string" &&
      candidate.message.trim()
    ) {
      return candidate.message;
    }
  }
  return fallback;
}

export function parseRemoteCompactionV2Events(
  events: unknown[],
): RemoteCompactionV2Events {
  let completed = false;
  let usage: unknown;
  const compactionItems: ResponseItem[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      throw new Error(
        `OpenAI remote compaction v2 failed: ${remoteCompactionStreamErrorMessage(
          event,
          "Unknown Responses API error",
        )}`,
      );
    }
    if (event.type === "response.failed") {
      throw new Error(
        `OpenAI remote compaction v2 failed: ${remoteCompactionStreamErrorMessage(
          event,
          "Response failed",
        )}`,
      );
    }
    if (event.type === "response.output_item.done") {
      const item = normalizeRemoteCompactionItem(event.item);
      if (item) compactionItems.push(item);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      const response = isRecord(event.response) ? event.response : undefined;
      usage = response?.usage;
    }
  }

  if (!completed) {
    throw new Error(
      "OpenAI remote compaction v2 stream ended before response.completed.",
    );
  }
  if (compactionItems.length !== 1) {
    throw new Error(
      `OpenAI remote compaction v2 expected exactly one encrypted compaction item, got ${compactionItems.length}.`,
    );
  }
  return { compactionItem: compactionItems[0], usage };
}

function parseSseEventBlock(block: string): unknown | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const value = line.slice(5);
      return value.startsWith(" ") ? value.slice(1) : value;
    })
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(
      `OpenAI remote compaction v2 received invalid SSE JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function drainSseBuffer(
  buffer: string,
  final = false,
): { events: unknown[]; remainder: string } {
  let normalized = buffer.replace(/\r\n/g, "\n");
  if (final) normalized = normalized.replace(/\r/g, "\n");

  const events: unknown[] = [];
  let boundary = normalized.indexOf("\n\n");
  while (boundary >= 0) {
    const block = normalized.slice(0, boundary);
    normalized = normalized.slice(boundary + 2);
    const event = parseSseEventBlock(block);
    if (event !== undefined) events.push(event);
    boundary = normalized.indexOf("\n\n");
  }

  if (final && normalized.trim()) {
    const event = parseSseEventBlock(normalized);
    if (event !== undefined) events.push(event);
    normalized = "";
  }

  return { events, remainder: normalized };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function isTerminalRemoteCompactionEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "error"
    )
  );
}

export async function readRemoteCompactionV2Stream(
  response: Response,
  signal?: AbortSignal,
): Promise<RemoteCompactionV2Events> {
  if (!response.body) {
    throw new Error("OpenAI remote compaction v2 response body is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";

  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseBuffer(buffer);
      buffer = drained.remainder;
      events.push(...drained.events);

      if (drained.events.some(isTerminalRemoteCompactionEvent)) {
        await reader.cancel().catch(() => undefined);
        return parseRemoteCompactionV2Events(events);
      }
    }

    buffer += decoder.decode();
    const drained = drainSseBuffer(buffer, true);
    events.push(...drained.events);
    return parseRemoteCompactionV2Events(events);
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released/cancelled.
    }
  }
}

export function buildRemoteCompactionV2History(
  input: ResponseItem[],
  compactionItem: ResponseItem,
): ResponseItem[] {
  const encryptedContent =
    "encrypted_content" in compactionItem
      ? compactionItem.encrypted_content
      : undefined;
  if (
    compactionItem.type !== "compaction" ||
    typeof encryptedContent !== "string" ||
    encryptedContent.length === 0
  ) {
    throw new Error(
      "OpenAI remote compaction v2 did not return a non-empty encrypted compaction item.",
    );
  }
  return buildRemoteCompactionV2HistoryCore(input, compactionItem);
}

function extractCacheWriteTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  const cacheCreationTokens = value.cache_creation_tokens;
  if (
    typeof cacheCreationTokens === "number" &&
    Number.isFinite(cacheCreationTokens)
  ) {
    return cacheCreationTokens;
  }
  const cacheWriteTokens = value.cache_write_tokens;
  return typeof cacheWriteTokens === "number" &&
    Number.isFinite(cacheWriteTokens)
    ? cacheWriteTokens
    : 0;
}

function extractRemoteCompactionUsage(
  model: Model<any>,
  value: unknown,
): RemoteCompactionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens =
    typeof value.input_tokens === "number" &&
    Number.isFinite(value.input_tokens)
      ? value.input_tokens
      : 0;
  const outputTokens =
    typeof value.output_tokens === "number" &&
    Number.isFinite(value.output_tokens)
      ? value.output_tokens
      : 0;
  const totalTokens =
    typeof value.total_tokens === "number" &&
    Number.isFinite(value.total_tokens)
      ? value.total_tokens
      : inputTokens + outputTokens;
  const inputTokenDetails = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const cachedTokens =
    typeof inputTokenDetails?.cached_tokens === "number" &&
    Number.isFinite(inputTokenDetails.cached_tokens)
      ? inputTokenDetails.cached_tokens
      : 0;
  const cacheWriteTokens = extractCacheWriteTokens(inputTokenDetails);

  const usage: RemoteCompactionUsageSnapshot = {
    input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  calculateCost(model, usage);
  return usage;
}

export async function callRemoteCompactionEndpoint(params: {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  if (!supportsRemoteCompactionModel(params.model)) {
    throw new Error(
      `Configured compaction model ${String(params.model.provider)}/${String(params.model.id)} does not expose a Responses-compatible remote compaction endpoint.`,
    );
  }

  const response = await fetch(remoteCompactionV2EndpointUrl(params.model), {
    method: "POST",
    headers: buildRemoteCompactionHeaders({
      model: params.model,
      apiKey: params.apiKey,
      headers: params.headers,
      sessionId: params.sessionId,
    }),
    body: JSON.stringify(
      buildRemoteCompactionRequestBody({
        model: params.model,
        input: params.input,
        instructions: params.instructions,
        tools: params.tools,
        parallelToolCalls: params.parallelToolCalls,
        reasoning: params.reasoning,
        text: params.text,
        sessionId: params.sessionId,
      }),
    ),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI remote compaction v2 failed (${response.status}): ${
        text || response.statusText
      }`,
    );
  }

  const parsed = await readRemoteCompactionV2Stream(response, params.signal);
  return {
    output: buildRemoteCompactionV2History(
      params.input,
      parsed.compactionItem,
    ),
    usage: extractRemoteCompactionUsage(params.model, parsed.usage),
  };
}
