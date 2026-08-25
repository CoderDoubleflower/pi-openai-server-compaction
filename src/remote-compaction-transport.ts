import type { Model } from "@earendil-works/pi-ai";
import {
  buildCodexIdentityHeaders,
  buildRemoteCompactionHeaders as buildBuiltInRemoteCompactionHeaders,
  remoteCompactionV2EndpointUrl as builtInRemoteCompactionV2EndpointUrl,
} from "./remote-compaction-core.ts";
import {
  isDirectOpenAIResponsesModel,
  isOpenAICodexResponsesModel,
  supportsRemoteCompactionModel,
} from "./openai.ts";

const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function resolveCompatibleResponsesEndpoint(model: Model<any>): string {
  const baseUrl =
    typeof model.baseUrl === "string" && model.baseUrl.trim()
      ? normalizeBaseUrl(model.baseUrl)
      : undefined;
  if (!baseUrl) {
    throw new Error(
      `Configured compaction model ${String(model.provider)}/${String(model.id)} does not expose a baseUrl for a Responses request.`,
    );
  }
  if (baseUrl.endsWith("/responses")) return baseUrl;
  return baseUrl.endsWith("/v1")
    ? `${baseUrl}/responses`
    : `${baseUrl}/v1/responses`;
}

/**
 * Preserve the built-in OpenAI and ChatGPT/Codex endpoint behavior, while
 * allowing any user-selected model with a compatible base URL to be attempted.
 */
export function remoteCompactionV2EndpointUrl(model: Model<any>): string {
  if (
    isDirectOpenAIResponsesModel(model) ||
    isOpenAICodexResponsesModel(model)
  ) {
    return builtInRemoteCompactionV2EndpointUrl(model);
  }
  if (!supportsRemoteCompactionModel(model)) {
    throw new Error(
      `Configured compaction model ${String(model.provider)}/${String(model.id)} is not a usable Responses compaction candidate.`,
    );
  }
  return resolveCompatibleResponsesEndpoint(model);
}

function withRemoteCompactionV2Feature(
  headers: Record<string, string>,
): Record<string, string> {
  const existingFeatures = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "x-codex-beta-features")?.[1]
    ?.split(",")
    .map((feature) => feature.trim())
    .filter(Boolean) ?? [];
  const withoutFeature = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "x-codex-beta-features",
    ),
  );
  return {
    ...withoutFeature,
    "x-codex-beta-features": [
      ...new Set([...existingFeatures, REMOTE_COMPACTION_V2_FEATURE]),
    ].join(","),
  };
}

function hasAuthorizationHeader(
  headers: Record<string, string> | undefined,
): boolean {
  return Boolean(
    headers &&
      Object.keys(headers).some(
        (name) => name.toLowerCase() === "authorization",
      ),
  );
}

/**
 * Preserve provider-supplied headers for custom providers. Built-in OpenAI and
 * Codex models keep their existing identity/account headers unchanged.
 */
export function buildRemoteCompactionHeaders(params: {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId?: string;
}): Record<string, string> {
  if (
    isDirectOpenAIResponsesModel(params.model) ||
    isOpenAICodexResponsesModel(params.model)
  ) {
    return buildBuiltInRemoteCompactionHeaders(params);
  }
  if (!supportsRemoteCompactionModel(params.model)) {
    throw new Error(
      `Configured compaction model ${String(params.model.provider)}/${String(params.model.id)} is not a usable Responses compaction candidate.`,
    );
  }

  const providerHeaders = params.headers ?? {};
  return withRemoteCompactionV2Feature({
    ...buildCodexIdentityHeaders(params.sessionId),
    ...(!hasAuthorizationHeader(providerHeaders)
      ? { authorization: `Bearer ${params.apiKey}` }
      : {}),
    ...providerHeaders,
    accept: "text/event-stream",
    "content-type": "application/json",
  });
}
