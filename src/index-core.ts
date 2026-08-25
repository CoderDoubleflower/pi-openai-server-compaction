/**
 * Main extension entrypoint.
 *
 * Wires together request patching, remote compaction, runtime state
 * reconstruction, session lifecycle cleanup, and provider override registration.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord, loadConfig } from "./config.ts";
import { streamOpenAIResponsesWithPhase2B } from "./custom-stream.ts";
import {
  applyPayloadPatch,
  applyRemoteHistoryPayloadPatch,
  extractAssistantResponseId,
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
  isOpenAICodexResponsesModel,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  supportsPreviousResponseId,
  supportsRemoteCompactionModel,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import { releaseAllWsSessions, releaseWsSession } from "./openai-ws-stream.ts";
import { normalizeProviderHeaders } from "./provider-headers.ts";
import {
  buildCompactionSummaryText,
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateBestEffortLocalSummary,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
} from "./remote-compaction.ts";
import {
  clearAllContinuationState,
  clearContinuationState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getContinuationState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setContinuationState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  return branchEntries.flatMap((entry) =>
    entry.type === "message" && entry.message ? [entry.message as AgentMessage] : [],
  );
}

function getBranchMessageCount(branchEntries: BranchEntry[]): number {
  return branchEntries.filter((entry) => entry.type === "message" && Boolean(entry.message)).length;
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearLiveContinuation(sessionId: string | undefined): void {
  clearContinuationState(sessionId);
  releaseWsSession(sessionId);
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearLiveContinuation(sessionId);
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && !messageMatchesModel(params.message, params.model)) {
    return;
  }

  const items = messageToResponseItems(params.message);
  if (items.length === 0) return;

  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

function maybeNotifyRequestFeatures(params: {
  notifiedModels: Set<string>;
  hasUI: boolean;
  notify: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
  model: TargetModel;
  features: string[];
}): void {
  if (!params.notify || !params.hasUI || params.features.length === 0) return;

  const key = `${String(params.model.provider)}/${String(params.model.id)}`;
  const noticeKey = `${key}:${params.features.join(",")}`;
  if (params.notifiedModels.has(noticeKey)) return;

  params.notifiedModels.add(noticeKey);
  params.ui.notify(`OpenAI compaction active for ${key} (${params.features.join(", ")})`, "info");
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  const notifiedModels = new Set<string>();

  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple: streamOpenAIResponsesWithPhase2B,
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearLiveContinuation(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

  pi.on("model_select", (_event, ctx) => {
    clearLiveContinuation(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllContinuationState();
    releaseAllWsSessions();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const model = ctx.model;
    if (!cfg.enabled || !model || !supportsRemoteCompactionModel(model)) return undefined;

    let compactionModel = model;
    if (cfg.model.toLowerCase() !== "current") {
      const slashIndex = cfg.model.indexOf("/");
      if (slashIndex <= 0 || slashIndex === cfg.model.length - 1) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Invalid OpenAI compaction model \"${cfg.model}\"; expected \"provider/model-id\". Using the current model.`,
            "warning",
          );
        }
      } else {
        const provider = cfg.model.slice(0, slashIndex);
        const modelId = cfg.model.slice(slashIndex + 1);
        const configuredModel = ctx.modelRegistry.find(provider, modelId);
        if (!configuredModel) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Configured OpenAI compaction model \"${cfg.model}\" was not found. Using the current model.`,
              "warning",
            );
          }
        } else if (!supportsRemoteCompactionModel(configuredModel)) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Configured model \"${cfg.model}\" does not support OpenAI remote compaction. Using the current model.`,
              "warning",
            );
          }
        } else if (configuredModel.provider !== model.provider || configuredModel.api !== model.api) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Configured compaction model \"${cfg.model}\" must use the same provider/API as the current model. Using the current model.`,
              "warning",
            );
          }
        } else {
          compactionModel = configuredModel;
        }
      }
    }

    let auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
    if ((!auth.ok || !auth.apiKey) && modelKey(compactionModel) !== modelKey(model)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Could not authenticate configured compaction model ${String(compactionModel.provider)}/${String(compactionModel.id)}; using the current model.`,
          "warning",
        );
      }
      compactionModel = model;
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
    }
    if (!auth.ok || !auth.apiKey) return undefined;
    const requestHeaders = normalizeProviderHeaders(auth.headers);

    const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
    const sessionId = getSessionId(ctx);
    const branchEntries = event.branchEntries as BranchEntry[];
    const remoteState = getMatchingRemoteState(sessionId, model);
    const observedRequestShape = getResponsesRequestShapeState(sessionId);
    const fullBranchMessages = getBranchMessages(branchEntries);
    const responseItems = remoteState
      ? remoteState.explicitHistory
      : messagesToResponseItems(fullBranchMessages);
    const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, compactionModel);
    const currentThinkingLevel = pi.getThinkingLevel();
    const effectiveThinkingLevel =
      cfg.reasoningEffort === "inherit"
        ? currentThinkingLevel
        : cfg.reasoningEffort === "none"
          ? undefined
          : cfg.reasoningEffort;
    const fallbackReasoning = compactionModel.reasoning
      ? thinkingLevelToResponsesReasoning(effectiveThinkingLevel ?? getBranchThinkingLevel(branchEntries))
      : undefined;
    const configuredReasoning =
      cfg.reasoningEffort !== "inherit"
        ? { effort: cfg.reasoningEffort, summary: "auto" as const }
        : undefined;
    const reasoning = configuredReasoning ?? observedRequestShape?.reasoning ?? fallbackReasoning;
    const text = observedRequestShape?.text;

    const [localResult, remoteResult] = await Promise.allSettled([
      generateBestEffortLocalSummary({
        preparation: event.preparation,
        messages: fullBranchMessages,
        model: compactionModel,
        apiKey: auth.apiKey,
        headers: requestHeaders,
        customInstructions: event.customInstructions,
        signal: event.signal,
        thinkingLevel: effectiveThinkingLevel,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      }),
      callRemoteCompactionEndpoint({
        model: compactionModel,
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
      if (localResult.status === "fulfilled") {
        return { compaction: localResult.value };
      }
      if (!event.signal.aborted && ctx.hasUI) {
        const message = remoteResult.reason instanceof Error ? remoteResult.reason.message : String(remoteResult.reason);
        ctx.ui.notify(`OpenAI remote compaction failed; falling back to default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    const remoteDetails = {
      ...buildRemoteCompactionDetails(
        model,
        remoteResult.value.output,
        remoteResult.value.usage,
      ),
      compactionModelKey: modelKey(compactionModel),
    };
    const localSummary =
      localResult.status === "fulfilled"
        ? localResult.value
        : {
            summary: buildCompactionSummaryText(model),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          };

    return {
      compaction: {
        summary: localSummary.summary,
        firstKeptEntryId: localSummary.firstKeptEntryId,
        tokensBefore: localSummary.tokensBefore,
        details: {
          ...(localSummary.details !== undefined ? { localSummaryDetails: localSummary.details } : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;

    extendRemoteHistoryIfCompatible({
      sessionId,
      model,
      message: event.message,
    });

    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled || !supportsPreviousResponseId(model, cfg)) return;
    if (!messageMatchesModel(event.message, model)) return;

    const responseId = extractAssistantResponseId(event.message);
    if (!responseId) return;

    setContinuationState(sessionId, {
      responseId,
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      contextLength: getBranchMessageCount(ctx.sessionManager.getBranch() as BranchEntry[]),
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return undefined;

    const model = ctx.model;
    if (!model || !isRecord(event.payload) || !looksLikeResponsesPayload(event.payload)) return undefined;

    const sessionId = getSessionId(ctx);
    setResponsesRequestShapeState(sessionId, {
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });
    const remoteState = getMatchingRemoteState(sessionId, model);

    if (isOpenAICodexResponsesModel(model)) {
      if (!remoteState) return undefined;
      const payload = applyRemoteHistoryPayloadPatch({
        payload: event.payload,
        explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
      });
      maybeNotifyRequestFeatures({
        notifiedModels,
        hasUI: ctx.hasUI,
        notify: cfg.notify,
        ui: ctx.ui,
        model,
        features: ["remote_compaction_history"],
      });
      return payload;
    }

    if (!supportsPreviousResponseId(model, cfg)) return undefined;

    const continuation = getContinuationState(sessionId);
    const previousResponseId =
      remoteState === undefined && continuation && continuation.modelKey === modelKey(model)
        ? continuation.responseId
        : undefined;

    const payload = applyPayloadPatch({
      payload: event.payload,
      model,
      cfg,
      previousResponseId,
    });

    const features = ["store=true", "context_management"];
    if (remoteState !== undefined) {
      features.push("remote_compaction_history");
    } else if (previousResponseId) {
      features.push("previous_response_id");
    }

    maybeNotifyRequestFeatures({
      notifiedModels,
      hasUI: ctx.hasUI,
      notify: cfg.notify,
      ui: ctx.ui,
      model,
      features,
    });

    return payload;
  });
}
