import assert from "node:assert/strict";
import {
  modelReference,
  resolveCompactionModelCandidates,
  tryCompactionModels,
} from "../src/compaction-model-fallback.ts";
import {
  modelKey,
  supportsRemoteCompactionModel,
} from "../src/openai.ts";
import { createProviderAgnosticExtensionApi } from "../src/provider-agnostic-hooks.ts";
import {
  buildRemoteCompactionHeaders,
  callRemoteCompactionEndpoint,
  remoteCompactionV2EndpointUrl,
} from "../src/remote-compaction.ts";
import {
  clearRemoteCompactionState,
  setRemoteCompactionState,
} from "../src/state.ts";

function sseResponse(encryptedContent = "CUSTOM_BLOB") {
  const body = [
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: encryptedContent },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const customModel = {
  provider: "my-responses-gateway",
  api: "custom-responses-v2",
  id: "custom-model",
  name: "custom-model",
  baseUrl: "https://gateway.example/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};
const currentModel = {
  provider: "openai",
  api: "openai-responses",
  id: "current-model",
  name: "current-model",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};

assert.equal(supportsRemoteCompactionModel(customModel), true);
assert.equal(
  remoteCompactionV2EndpointUrl(customModel),
  "https://gateway.example/v1/responses",
);
assert.equal(modelReference(customModel), "my-responses-gateway/custom-model");

const customHeaders = buildRemoteCompactionHeaders({
  model: customModel,
  apiKey: "unused-bearer",
  headers: {
    Authorization: "Custom custom-token",
    "x-provider-feature": "enabled",
  },
  sessionId: "custom-session",
});
assert.equal(customHeaders.Authorization, "Custom custom-token");
assert.equal(customHeaders["x-provider-feature"], "enabled");
assert.match(customHeaders["x-codex-beta-features"], /remote_compaction_v2/);
assert.equal(customHeaders["x-codex-installation-id"], undefined);
assert.equal(customHeaders["x-codex-window-id"], undefined);
assert.equal(customHeaders.session_id, undefined);

let capturedUrl;
let capturedBody;
let capturedHeaders;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedBody = JSON.parse(String(init?.body));
  capturedHeaders = new Headers(init?.headers);
  return sseResponse();
};
try {
  const result = await callRemoteCompactionEndpoint({
    model: customModel,
    apiKey: "custom-key",
    headers: { "x-provider-feature": "enabled" },
    sessionId: "custom-session",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep me" }],
      },
    ],
    instructions: "system",
    tools: [],
    parallelToolCalls: true,
  });

  assert.equal(capturedUrl, "https://gateway.example/v1/responses");
  assert.equal(capturedHeaders.get("x-provider-feature"), "enabled");
  assert.equal(capturedHeaders.get("x-codex-installation-id"), null);
  assert.equal(capturedBody.model, "custom-model");
  assert.deepEqual(capturedBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(result.output.at(-1).encrypted_content, "CUSTOM_BLOB");
} finally {
  globalThis.fetch = originalFetch;
}

const resolution = resolveCompactionModelCandidates({
  configuredModel: "my-responses-gateway/custom-model",
  currentModel,
  find: (provider, modelId) =>
    provider === customModel.provider && modelId === customModel.id
      ? customModel
      : undefined,
});
assert.deepEqual(
  resolution.models.map((model) => modelKey(model)),
  [modelKey(customModel), modelKey(currentModel)],
  "the user-selected provider/model must be attempted before the current model",
);
assert.deepEqual(resolution.warnings, []);

const attemptOrder = [];
const fallbackResult = await tryCompactionModels({
  models: resolution.models,
  attempt: async (model) => {
    attemptOrder.push(modelReference(model));
    if (model.provider === customModel.provider) {
      throw new Error("custom endpoint rejected the request");
    }
    return "fallback-ok";
  },
});
assert.equal(fallbackResult.success, true);
if (fallbackResult.success) {
  assert.equal(modelKey(fallbackResult.model), modelKey(currentModel));
  assert.equal(fallbackResult.value, "fallback-ok");
}
assert.deepEqual(attemptOrder, [
  "my-responses-gateway/custom-model",
  "openai/current-model",
]);

{
  const previousConfiguredModel =
    process.env.PI_OPENAI_SERVER_COMPACTION_MODEL;
  process.env.PI_OPENAI_SERVER_COMPACTION_MODEL =
    "my-responses-gateway/custom-model";
  try {
    const handlers = new Map();
    const notices = [];
    let fallbackCalls = 0;
    let fallbackResolvedModel;
    const basePi = {
      on(name, handler) {
        handlers.set(name, handler);
      },
    };
    const wrappedPi = createProviderAgnosticExtensionApi(basePi);
    wrappedPi.on("session_before_compact", (_event, fallbackCtx) => {
      fallbackCalls += 1;
      fallbackResolvedModel = fallbackCtx.modelRegistry.find(
        customModel.provider,
        customModel.id,
      );
      return {
        compaction: {
          summary: "current-model fallback",
          firstKeptEntryId: "m-1",
          tokensBefore: 100,
        },
      };
    });

    const result = await handlers.get("session_before_compact")(
      {
        preparation: { firstKeptEntryId: "m-1", tokensBefore: 100 },
        branchEntries: [],
        signal: new AbortController().signal,
      },
      {
        cwd: "/tmp/custom-provider-project",
        model: currentModel,
        hasUI: true,
        ui: {
          notify(message, type) {
            notices.push([message, type]);
          },
        },
        sessionManager: { getSessionId: () => "fallback-session" },
        modelRegistry: {
          find(provider, modelId) {
            return provider === customModel.provider &&
              modelId === customModel.id
              ? customModel
              : undefined;
          },
          async getApiKeyAndHeaders(model) {
            if (model.provider === customModel.provider) {
              return { ok: false, error: "custom credentials rejected" };
            }
            return { ok: true, apiKey: "current-key" };
          },
        },
      },
    );

    assert.equal(fallbackCalls, 1);
    assert.equal(modelKey(fallbackResolvedModel), modelKey(currentModel));
    assert.equal(result.compaction.summary, "current-model fallback");
    assert.match(notices[0][0], /falling back to current model/);
  } finally {
    if (previousConfiguredModel === undefined) {
      delete process.env.PI_OPENAI_SERVER_COMPACTION_MODEL;
    } else {
      process.env.PI_OPENAI_SERVER_COMPACTION_MODEL = previousConfiguredModel;
    }
  }
}

{
  const handlers = new Map();
  const basePi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const wrappedPi = createProviderAgnosticExtensionApi(basePi);
  wrappedPi.on("before_provider_request", () => undefined);

  const sessionId = "custom-replay-session";
  setRemoteCompactionState(sessionId, {
    compactionEntryId: "cmp-1",
    modelKey: modelKey(customModel),
    replacementHistory: [
      { type: "compaction", encrypted_content: "CUSTOM_REPLAY_BLOB" },
    ],
    explicitHistory: [
      { type: "compaction", encrypted_content: "CUSTOM_REPLAY_BLOB" },
    ],
  });
  try {
    const payload = await handlers.get("before_provider_request")(
      {
        payload: {
          model: customModel.id,
          input: [{ type: "message", role: "user", content: "stale" }],
        },
      },
      {
        cwd: "/tmp/custom-provider-project",
        model: customModel,
        sessionManager: { getSessionId: () => sessionId },
      },
    );
    assert.deepEqual(payload.input, [
      { type: "compaction", encrypted_content: "CUSTOM_REPLAY_BLOB" },
    ]);
  } finally {
    clearRemoteCompactionState(sessionId);
  }
}

console.log("custom provider compaction smoke ok");
