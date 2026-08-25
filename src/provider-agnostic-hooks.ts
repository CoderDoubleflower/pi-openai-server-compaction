/**
 * Provider-agnostic wrappers around the original extension hooks.
 *
 * The core implementation remains the compatibility baseline for built-in
 * OpenAI/Codex models. These wrappers add two behaviors without duplicating the
 * rest of the extension lifecycle:
 *
 * 1. an explicitly configured provider/model is attempted directly, even when
 *    it differs from the active provider/API; failures fall back to the current
 *    model through the original handler;
 * 2. persisted remote history is replayed for any model that previously
 *    completed remote compaction, regardless of provider name.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  modelReference,
  resolveCompactionModelCandidates,
} from "./compaction-model-fallback.ts";
import { isRecord, loadConfig } from "./config.ts";
import {
  applyRemoteHistoryPayloadPatch,
  looksLikeResponsesPayload,
  modelKey,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import { normalizeProviderHeaders } from "./provider-headers.ts";
import {
  buildCompactionSummaryText,
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateBestEffortLocalSummary,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
} from "./remote-compaction.ts";
import {
  getRemoteCompactionState,
  getResponsesRequestShapeState,
} from "./state.ts";

type ExtensionHandler = (event: any, ctx: any) => unknown | Promise<unknown>;

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  return branchEntries.flatMap((entry) =>
    entry.type === "message" && entry.message
      ? [entry.message as AgentMessage]
      : [],
  );
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string"
      ? entry.thinkingLevel
      : undefined;
  }
  return undefined;
}

function getSessionId(ctx: {
  sessionManager: { getSessionId(): string };
}): string {
  return ctx.sessionManager.getSessionId();
}

function matchingRemoteState(sessionId: string, model: Model<any>) {
  const state = getRemoteCompactionState(sessionId);
  return state && state.modelKey === modelKey(model) ? state : undefined;
}

function configuredReference(value: string): {
  provider: string;
  modelId: string;
} | undefined {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;
  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

function createCurrentModelFallbackContext(
  ctx: any,
  configuredModel: string,
): any {
  const selected = configuredReference(configuredModel);
  if (!selected) return ctx;

  const registry = ctx.modelRegistry;
  const registryProxy = new Proxy(registry, {
    get(target, property, receiver) {
      if (property === "find") {
        return (provider: string, modelId: string) => {
          if (
            provider === selected.provider &&
            modelId === selected.modelId
          ) {
            return ctx.model;
          }
          return target.find(provider, modelId);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "modelRegistry") return registryProxy;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function attemptConfiguredCompaction(params: {
  pi: ExtensionAPI;
  event: any;
  ctx: any;
  compactionModel: Model<any>;
}): Promise<unknown> {
  const { pi, event, ctx, compactionModel } = params;
  const cfg = loadConfig(ctx.cwd);
  const activeModel = ctx.model as Model<any>;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
  if (!auth.ok) {
    throw new Error(
      `Could not authenticate compaction model ${modelReference(compactionModel)}: ${auth.error}`,
    );
  }
  if (!auth.apiKey) {
    throw new Error(
      `Compaction model ${modelReference(compactionModel)} did not resolve an API key.`,
    );
  }

  const requestModel = auth.baseUrl
    ? ({ ...compactionModel, baseUrl: auth.baseUrl } as Model<any>)
    : compactionModel;
  const requestHeaders = normalizeProviderHeaders(auth.headers);
  const sessionId = getSessionId(ctx);
  const branchEntries = event.branchEntries as BranchEntry[];
  const fullBranchMessages = getBranchMessages(branchEntries);
  const remoteState = matchingRemoteState(sessionId, activeModel);
  const responseItems = remoteState
    ? remoteState.explicitHistory
    : messagesToResponseItems(fullBranchMessages);
  const promptResponseItems = normalizeResponseItemsForPrompt(
    responseItems,
    requestModel,
  );
  const observedRequestShape = getResponsesRequestShapeState(sessionId);
  const currentThinkingLevel = pi.getThinkingLevel();
  const effectiveThinkingLevel =
    cfg.reasoningEffort === "inherit"
      ? currentThinkingLevel
      : cfg.reasoningEffort === "none"
        ? undefined
        : cfg.reasoningEffort;
  const fallbackReasoning = requestModel.reasoning
    ? thinkingLevelToResponsesReasoning(
        effectiveThinkingLevel ?? getBranchThinkingLevel(branchEntries),
      )
    : undefined;
  const configuredReasoning =
    cfg.reasoningEffort !== "inherit"
      ? { effort: cfg.reasoningEffort, summary: "auto" as const }
      : undefined;
  const reasoning =
    configuredReasoning ?? observedRequestShape?.reasoning ?? fallbackReasoning;
  const text = observedRequestShape?.text;
  const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());

  const [localResult, remoteResult] = await Promise.allSettled([
    generateBestEffortLocalSummary({
      preparation: event.preparation,
      messages: fullBranchMessages,
      model: requestModel,
      apiKey: auth.apiKey,
      headers: requestHeaders,
      customInstructions: event.customInstructions,
      signal: event.signal,
      thinkingLevel: effectiveThinkingLevel,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    }),
    callRemoteCompactionEndpoint({
      model: requestModel,
      apiKey: auth.apiKey,
      headers: requestHeaders,
      sessionId,
      input: promptResponseItems,
      instructions: ctx.getSystemPrompt(),
      tools,
      parallelToolCalls: true,
      reasoning,
      text,
      signal: event.signal,
    }),
  ]);

  if (remoteResult.status !== "fulfilled") {
    throw remoteResult.reason;
  }

  const localSummary =
    localResult.status === "fulfilled"
      ? localResult.value
      : {
          summary: buildCompactionSummaryText(activeModel),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: undefined,
        };
  const remoteDetails = {
    ...buildRemoteCompactionDetails(
      activeModel,
      remoteResult.value.output,
      remoteResult.value.usage,
    ),
    compactionModelKey: modelKey(compactionModel),
  };

  return {
    compaction: {
      summary: localSummary.summary,
      firstKeptEntryId: localSummary.firstKeptEntryId,
      tokensBefore: localSummary.tokensBefore,
      details: {
        ...(localSummary.details !== undefined
          ? { localSummaryDetails: localSummary.details }
          : {}),
        remoteCompaction: remoteDetails,
      },
    },
  };
}

function wrapSessionBeforeCompact(
  pi: ExtensionAPI,
  original: ExtensionHandler,
): ExtensionHandler {
  return async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const activeModel = ctx.model as Model<any> | undefined;
    if (
      !cfg.enabled ||
      !activeModel ||
      cfg.model.trim().toLowerCase() === "current"
    ) {
      return await original(event, ctx);
    }

    const resolution = resolveCompactionModelCandidates({
      configuredModel: cfg.model,
      currentModel: activeModel,
      find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
    });
    if (resolution.warnings.length > 0) {
      return await original(event, ctx);
    }

    const configuredModel = resolution.models[0];
    if (!configuredModel || modelKey(configuredModel) === modelKey(activeModel)) {
      return await original(event, ctx);
    }

    try {
      return await attemptConfiguredCompaction({
        pi,
        event,
        ctx,
        compactionModel: configuredModel,
      });
    } catch (error) {
      if (event.signal?.aborted) return undefined;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Compaction model ${modelReference(configuredModel)} failed; falling back to current model ${modelReference(activeModel)}. ${getErrorMessage(error)}`,
          "warning",
        );
      }
      return await original(
        event,
        createCurrentModelFallbackContext(ctx, cfg.model),
      );
    }
  };
}

function wrapBeforeProviderRequest(original: ExtensionHandler): ExtensionHandler {
  return async (event, ctx) => {
    const originalResult = await original(event, ctx);
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled || !ctx.model) return originalResult;

    const payload = originalResult ?? event.payload;
    if (!isRecord(payload) || !looksLikeResponsesPayload(payload)) {
      return originalResult;
    }

    const sessionId = getSessionId(ctx);
    const remoteState = matchingRemoteState(sessionId, ctx.model as Model<any>);
    if (!remoteState) return originalResult;

    // A matching persisted state proves this provider/model completed remote
    // compaction successfully, so replay must not depend on a provider allowlist.
    return applyRemoteHistoryPayloadPatch({
      payload,
      explicitHistory: normalizeResponseItemsForPrompt(
        remoteState.explicitHistory,
        ctx.model,
      ) as unknown[],
    });
  };
}

/**
 * Intercept only the two hooks that need provider-agnostic behavior. Every other
 * method and handler registration is delegated to Pi's original ExtensionAPI.
 */
export function createProviderAgnosticExtensionApi(
  pi: ExtensionAPI,
): ExtensionAPI {
  const register = (
    eventName: string,
    handler: ExtensionHandler,
  ): unknown => {
    const wrapped =
      eventName === "session_before_compact"
        ? wrapSessionBeforeCompact(pi, handler)
        : eventName === "before_provider_request"
          ? wrapBeforeProviderRequest(handler)
          : handler;
    return (pi.on as unknown as (
      event: string,
      callback: ExtensionHandler,
    ) => unknown)(eventName, wrapped);
  };

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "on") return register;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
