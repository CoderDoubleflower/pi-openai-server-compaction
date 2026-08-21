/**
 * Provider override entrypoint.
 *
 * Chooses between Pi's normal HTTP Responses streaming path and this package's
 * custom WebSocket-backed continuation path for direct OpenAI Responses models.
 */
import type {
  SimpleStreamOptions,
  Context,
  Model,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { applyOpenAIPromptCacheFields } from "./openai-prompt-cache.ts";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.ts";
import { loadConfig } from "./config.ts";
import { isDirectOpenAIResponsesModel } from "./openai.ts";

const websocketStream = createOpenAIWebSocketStreamFn();

/**
 * The custom WebSocket implementation builds its own response.create payload.
 * Patch that payload before the caller's hook so it carries the same prompt-cache
 * fields as Pi's native OpenAI Responses HTTP transport. The caller remains free
 * to inspect or override those fields through its original onPayload callback.
 */
function withOpenAIPromptCacheParity(
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const originalOnPayload = options?.onPayload;
  return {
    ...(options ?? {}),
    onPayload: async (payload: unknown, payloadModel: Model<any>) => {
      const cacheAwarePayload = applyOpenAIPromptCacheFields({
        payload,
        model: payloadModel,
        options,
      });
      const replacement = await originalOnPayload?.(cacheAwarePayload, payloadModel);
      return replacement ?? cacheAwarePayload;
    },
  };
}

export const streamOpenAIResponsesWithPhase2B: StreamFunction = (
  model,
  context,
  options,
) => {
  const cfg = loadConfig(process.cwd());
  if (!cfg.enabled || !isDirectOpenAIResponsesModel(model)) {
    return streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context as Context,
      options as SimpleStreamOptions | undefined,
    );
  }
  return websocketStream(model, context, withOpenAIPromptCacheParity(options));
};
