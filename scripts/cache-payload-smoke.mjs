import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
  applyOpenAIPromptCacheFields,
  buildOpenAIPromptCacheFields,
  clampOpenAIPromptCacheKey,
  resolveOpenAIPromptCacheRetention,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-prompt-cache.ts")).href);

const longSessionId = `session_${"x".repeat(100)}`;
const clampedSessionId = clampOpenAIPromptCacheKey(longSessionId);
assert.equal(Array.from(clampedSessionId).length, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
assert.equal(clampedSessionId, Array.from(longSessionId).slice(0, 64).join(""));

const unicodeSessionId = "会".repeat(65);
assert.equal(Array.from(clampOpenAIPromptCacheKey(unicodeSessionId)).length, 64);

assert.equal(
  resolveOpenAIPromptCacheRetention({ cacheRetention: "short", env: { PI_CACHE_RETENTION: "long" } }),
  "short",
  "explicit cacheRetention must override the compatibility environment variable",
);
assert.equal(
  resolveOpenAIPromptCacheRetention({ env: { PI_CACHE_RETENTION: "long" } }),
  "long",
  "PI_CACHE_RETENTION=long should retain Pi's compatibility behavior",
);
assert.equal(
  resolveOpenAIPromptCacheRetention({ env: { PI_CACHE_RETENTION: "" } }),
  "short",
);

const shortFields = buildOpenAIPromptCacheFields({
  model: { compat: {} },
  options: { sessionId: longSessionId, cacheRetention: "short" },
});
assert.equal(shortFields.prompt_cache_key, clampedSessionId);
assert.equal(shortFields.prompt_cache_retention, undefined);
assert.equal(shortFields.prompt_cache_options, undefined);

const longFields = buildOpenAIPromptCacheFields({
  model: { compat: { supportsLongCacheRetention: true } },
  options: { sessionId: "session-long", cacheRetention: "long" },
});
assert.equal(longFields.prompt_cache_key, "session-long");
assert.equal(longFields.prompt_cache_retention, "24h");
assert.equal(longFields.prompt_cache_options, undefined);

const unsupportedLongFields = buildOpenAIPromptCacheFields({
  model: { compat: { supportsLongCacheRetention: false } },
  options: { sessionId: "session-no-long", cacheRetention: "long" },
});
assert.equal(unsupportedLongFields.prompt_cache_key, "session-no-long");
assert.equal(unsupportedLongFields.prompt_cache_retention, undefined);

const disabledExplicitFields = buildOpenAIPromptCacheFields({
  model: { compat: { supportsExplicitPromptCacheMode: true } },
  options: { sessionId: "session-disabled", cacheRetention: "none" },
});
assert.equal(disabledExplicitFields.prompt_cache_key, undefined);
assert.equal(disabledExplicitFields.prompt_cache_retention, undefined);
assert.deepEqual(disabledExplicitFields.prompt_cache_options, { mode: "explicit" });

const disabledLegacyFields = buildOpenAIPromptCacheFields({
  model: { compat: { supportsExplicitPromptCacheMode: false } },
  options: { sessionId: "session-disabled", cacheRetention: "none" },
});
assert.equal(disabledLegacyFields.prompt_cache_key, undefined);
assert.equal(disabledLegacyFields.prompt_cache_retention, undefined);
assert.equal(disabledLegacyFields.prompt_cache_options, undefined);

const patchedPayload = applyOpenAIPromptCacheFields({
  payload: {
    type: "response.create",
    model: "gpt-5.6-sol",
    prompt_cache_key: "stale",
    prompt_cache_retention: "24h",
    prompt_cache_options: { mode: "explicit" },
  },
  model: { compat: { supportsExplicitPromptCacheMode: true } },
  options: { sessionId: "fresh-session", cacheRetention: "short" },
});
assert.equal(patchedPayload.prompt_cache_key, "fresh-session");
assert.equal(patchedPayload.prompt_cache_retention, undefined);
assert.equal(patchedPayload.prompt_cache_options, undefined);
assert.equal(patchedPayload.type, "response.create");

const primitivePayload = "unchanged";
assert.equal(
  applyOpenAIPromptCacheFields({
    payload: primitivePayload,
    model: {},
    options: { sessionId: "session" },
  }),
  primitivePayload,
);

console.log("cache payload smoke ok");
