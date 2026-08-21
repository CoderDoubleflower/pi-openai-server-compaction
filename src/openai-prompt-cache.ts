/**
 * OpenAI Responses prompt-cache helpers.
 *
 * Mirrors Pi's native OpenAI Responses cache behavior so the custom WebSocket
 * transport preserves the same cache key, retention, and cache-disable semantics
 * as Pi's HTTP transport.
 */

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export type OpenAIPromptCacheRetention = "none" | "short" | "long";

export type OpenAIPromptCacheOptionsLike = {
  sessionId?: unknown;
  cacheRetention?: unknown;
  env?: Record<string, string>;
};

export type OpenAIPromptCacheModelLike = {
  compat?: unknown;
};

export type OpenAIPromptCacheFields = {
  prompt_cache_key: string | undefined;
  prompt_cache_retention: "24h" | undefined;
  prompt_cache_options: { mode: "explicit" } | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCompat(model: OpenAIPromptCacheModelLike): Record<string, unknown> | undefined {
  return isRecord(model.compat) ? model.compat : undefined;
}

function getProviderEnvValue(
  name: string,
  env: Record<string, string> | undefined,
): string | undefined {
  return env?.[name] ?? process.env[name];
}

/** OpenAI currently limits prompt_cache_key to 64 Unicode code points. */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Match Pi's cache-retention resolution:
 * - an explicit option wins;
 * - PI_CACHE_RETENTION=long is retained for backward compatibility;
 * - otherwise use short retention.
 */
export function resolveOpenAIPromptCacheRetention(
  options: OpenAIPromptCacheOptionsLike | undefined,
): OpenAIPromptCacheRetention {
  const configured = options?.cacheRetention;
  if (configured === "none" || configured === "short" || configured === "long") {
    return configured;
  }
  return getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short";
}

/** Build the cache fields exactly as Pi's native OpenAI Responses transport does. */
export function buildOpenAIPromptCacheFields(params: {
  model: OpenAIPromptCacheModelLike;
  options: OpenAIPromptCacheOptionsLike | undefined;
}): OpenAIPromptCacheFields {
  const retention = resolveOpenAIPromptCacheRetention(params.options);
  const compat = getCompat(params.model);
  const supportsLongCacheRetention = compat?.supportsLongCacheRetention !== false;
  const supportsExplicitPromptCacheMode = compat?.supportsExplicitPromptCacheMode === true;
  const sessionId =
    typeof params.options?.sessionId === "string" ? params.options.sessionId : undefined;

  return {
    prompt_cache_key:
      retention === "none" ? undefined : clampOpenAIPromptCacheKey(sessionId),
    prompt_cache_retention:
      retention === "long" && supportsLongCacheRetention ? "24h" : undefined,
    prompt_cache_options:
      retention === "none" && supportsExplicitPromptCacheMode
        ? { mode: "explicit" }
        : undefined,
  };
}

/**
 * Add native-equivalent cache fields before a caller's onPayload hook runs.
 * Undefined values are intentional: JSON serialization omits them, matching the
 * object shape produced by Pi's native transport.
 */
export function applyOpenAIPromptCacheFields(params: {
  payload: unknown;
  model: OpenAIPromptCacheModelLike;
  options: OpenAIPromptCacheOptionsLike | undefined;
}): unknown {
  if (!isRecord(params.payload)) return params.payload;
  return {
    ...params.payload,
    ...buildOpenAIPromptCacheFields({
      model: params.model,
      options: params.options,
    }),
  };
}
