/**
 * Mid-run threshold trigger for transparent OpenAI Responses compaction.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ExtensionConfig, loadConfig } from "./config.ts";
import {
  resolveCompactThreshold,
  supportsRemoteCompactionModel,
  type ModelLike,
} from "./openai.ts";
import {
  compactInlineAtTurnBoundary,
  InlineAutoCompactionUnavailableError,
  type InlineAutoCompaction,
  type InlineAutoCompactionAdapterStatus,
} from "./inline-auto-compaction.ts";

export const MID_RUN_RETRY_MAX_DELAY_MS = 30_000;

type RuntimeConfig = Required<ExtensionConfig>;

type ConfigLoader = (cwd: string) => RuntimeConfig;

interface MidRunDependencies {
  inlineCompact?: InlineAutoCompaction;
  configLoader?: ConfigLoader;
  now?: () => number;
}

interface MidRunState {
  inFlight: boolean;
  failures: number;
  retryAfter: number;
  unsupportedReason?: string;
  warningEmitted: boolean;
}

interface SessionManagerContextLike {
  getSessionId(): string;
}

interface MidRunContextLike {
  cwd: string;
  model: ModelLike | undefined;
  sessionManager: SessionManagerContextLike & object;
  signal?: AbortSignal;
  hasUI: boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWorkingVisible?(visible: boolean): void;
  };
}

interface TurnEndLike {
  message?: { role?: unknown; stopReason?: unknown };
  toolResults?: unknown[];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isStaleExtensionContextError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}

function notifySafely(
  ctx: MidRunContextLike,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, type);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

function resetRetry(state: MidRunState): void {
  state.failures = 0;
  state.retryAfter = 0;
}

function recordFailure(state: MidRunState, now: number): number {
  state.failures += 1;
  const delay = Math.min(
    MID_RUN_RETRY_MAX_DELAY_MS,
    1000 * 2 ** (state.failures - 1),
  );
  state.retryAfter = now + delay;
  return delay;
}

function retrySuffix(delayMs: number): string {
  return `; retrying in ${Math.ceil(delayMs / 1000)}s`;
}

function shouldContinueAfterTurn(event: TurnEndLike, ctx: MidRunContextLike): boolean {
  if (Array.isArray(event.toolResults) && event.toolResults.length > 0) return true;
  return ctx.hasPendingMessages();
}

function createState(): MidRunState {
  return {
    inFlight: false,
    failures: 0,
    retryAfter: 0,
    warningEmitted: false,
  };
}

function warnUnavailable(
  state: MidRunState,
  ctx: MidRunContextLike,
  reason: string,
): void {
  state.unsupportedReason = reason;
  if (state.warningEmitted) return;
  state.warningEmitted = true;
  notifySafely(
    ctx,
    `OpenAI transparent mid-run compaction is unavailable: ${reason}. The current run will continue without interrupting.`,
    "warning",
  );
}

export function registerMidRunCompaction(
  pi: ExtensionAPI,
  adapterStatus: InlineAutoCompactionAdapterStatus,
  dependencies: MidRunDependencies = {},
): void {
  const inlineCompact = dependencies.inlineCompact ?? compactInlineAtTurnBoundary;
  const configLoader = dependencies.configLoader ?? loadConfig;
  const now = dependencies.now ?? Date.now;
  const states = new WeakMap<object, MidRunState>();

  const getState = (sessionManager: object): MidRunState => {
    const existing = states.get(sessionManager);
    if (existing) return existing;
    const state = createState();
    states.set(sessionManager, state);
    return state;
  };

  pi.on("session_start", (_event, rawCtx) => {
    const ctx = rawCtx as unknown as MidRunContextLike;
    try {
      const cfg = configLoader(ctx.cwd);
      if (!cfg.enabled || cfg.midRunCompaction !== "resume") return;
      if (adapterStatus.supported) return;
      const state = getState(ctx.sessionManager);
      warnUnavailable(
        state,
        ctx,
        adapterStatus.reason ?? "the installed Pi version is not supported",
      );
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
  });

  pi.on("turn_end", async (rawEvent, rawCtx) => {
    const event = rawEvent as unknown as TurnEndLike;
    const ctx = rawCtx as unknown as MidRunContextLike;

    try {
      const cfg = configLoader(ctx.cwd);
      if (!cfg.enabled || cfg.midRunCompaction !== "resume") return;
      if (!ctx.model || !supportsRemoteCompactionModel(ctx.model)) return;
      if (ctx.signal?.aborted) return;
      if (
        event.message?.stopReason === "error" ||
        event.message?.stopReason === "aborted"
      ) {
        return;
      }
      if (!shouldContinueAfterTurn(event, ctx)) return;

      const state = getState(ctx.sessionManager);
      if (state.inFlight) return;
      if (!adapterStatus.supported) {
        warnUnavailable(
          state,
          ctx,
          adapterStatus.reason ?? "the installed Pi version is not supported",
        );
        return;
      }
      if (state.unsupportedReason) {
        warnUnavailable(state, ctx, state.unsupportedReason);
        return;
      }

      const usage = ctx.getContextUsage();
      const tokens = usage?.tokens;
      if (tokens === null || tokens === undefined) return;

      const threshold = resolveCompactThreshold(ctx.model, cfg);
      if (tokens < threshold) {
        resetRetry(state);
        return;
      }
      const currentTime = now();
      if (currentTime < state.retryAfter) return;

      state.inFlight = true;
      if (cfg.notify) {
        notifySafely(
          ctx,
          `OpenAI compaction threshold reached mid-run (~${Math.round(tokens).toLocaleString()} tokens); compacting inline`,
          "info",
        );
      }

      try {
        await inlineCompact(ctx.sessionManager, ctx.signal);
        resetRetry(state);
        if (cfg.notify) {
          notifySafely(ctx, "OpenAI transparent mid-run compaction complete", "info");
        }
      } catch (error) {
        if (isStaleExtensionContextError(error)) throw error;
        const message = getErrorMessage(error);
        if (error instanceof InlineAutoCompactionUnavailableError) {
          warnUnavailable(state, ctx, message);
          return;
        }

        const delay = recordFailure(state, now());
        if (message !== "Compaction cancelled" && !ctx.signal?.aborted) {
          notifySafely(
            ctx,
            `OpenAI transparent mid-run compaction failed: ${message}${retrySuffix(delay)}`,
            "error",
          );
        }
      } finally {
        state.inFlight = false;
        if (ctx.hasUI && !ctx.signal?.aborted) {
          try {
            ctx.ui.setWorkingVisible?.(true);
          } catch (error) {
            if (!isStaleExtensionContextError(error)) throw error;
          }
        }
      }
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
  });
}
