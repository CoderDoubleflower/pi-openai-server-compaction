import assert from "node:assert/strict";
import {
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  parseRemoteCompactionV2Events,
  readRemoteCompactionV2Stream,
} from "../src/remote-compaction.ts";

function encodeSse(events, lineEnding = "\n") {
  return events
    .map((event) => {
      if (event === "[DONE]") return `data: [DONE]${lineEnding}${lineEnding}`;
      return `data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`;
    })
    .join("");
}

function chunkedResponse(text, options = {}) {
  const bytes = new TextEncoder().encode(text);
  const pattern = options.pattern ?? [1, 2, 5, 3, 8, 13];
  let offset = 0;
  let patternIndex = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = pattern[patternIndex % pattern.length];
      patternIndex += 1;
      const end = Math.min(bytes.length, offset + size);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const parsedAlias = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: {
      type: "compaction_summary",
      id: "cmp_alias",
      encrypted_content: "ALIAS_BLOB",
    },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedAlias.compactionItem.type, "compaction");
assert.equal(parsedAlias.compactionItem.encrypted_content, "ALIAS_BLOB");
assert.equal(parsedAlias.compactionItem.id, "cmp_alias");

assert.throws(
  () => parseRemoteCompactionV2Events([
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "" },
    },
    { type: "response.completed", response: {} },
  ]),
  /exactly one encrypted compaction item, got 0/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "one" },
    },
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "two" },
    },
    { type: "response.completed", response: {} },
  ]),
  /got 2/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([
    {
      type: "response.failed",
      response: { error: { message: "nested failure" } },
    },
  ]),
  /nested failure/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "blob" },
    },
  ]),
  /before response\.completed/,
);

const unicodeBlob = "加密-blob-🔐";
const streamBody = [
  ": keepalive\r\n\r\n",
  encodeSse([
    {
      type: "response.output_item.done",
      item: {
        type: "compaction",
        id: "cmp_stream",
        encrypted_content: unicodeBlob,
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_stream",
        usage: { input_tokens: 42, output_tokens: 3, total_tokens: 45 },
      },
    },
    "[DONE]",
  ], "\r\n"),
].join("");
const streamed = await readRemoteCompactionV2Stream(chunkedResponse(streamBody));
assert.equal(streamed.compactionItem.type, "compaction");
assert.equal(streamed.compactionItem.encrypted_content, unicodeBlob);
assert.equal(streamed.compactionItem.id, "cmp_stream");
assert.deepEqual(streamed.usage, { input_tokens: 42, output_tokens: 3, total_tokens: 45 });

await assert.rejects(
  () => readRemoteCompactionV2Stream({ body: null }),
  /response body is empty/,
);
await assert.rejects(
  () => readRemoteCompactionV2Stream(chunkedResponse("data: {bad json}\n\n")),
  /invalid SSE JSON/,
);

const abortController = new AbortController();
abortController.abort();
await assert.rejects(
  () => readRemoteCompactionV2Stream(chunkedResponse(streamBody), abortController.signal),
  (error) => error?.name === "AbortError",
);

assert.throws(
  () => buildRemoteCompactionV2History(
    [],
    { type: "compaction", encrypted_content: "" },
  ),
  /non-empty encrypted compaction item/,
);

const model = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-v2-smoke",
  name: "gpt-v2-smoke",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};
const input = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "retain me" }],
  },
];
let capturedUrl;
let capturedHeaders;
let capturedBody;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = new Headers(init?.headers);
  capturedBody = JSON.parse(String(init?.body));
  const response = chunkedResponse(streamBody, { pattern: [2, 1, 4, 1, 7] });
  Object.defineProperty(response, "text", {
    value: async () => {
      throw new Error("successful V2 responses must not be buffered with response.text()");
    },
  });
  return response;
};

try {
  const result = await callRemoteCompactionEndpoint({
    model,
    apiKey: "sk-test",
    sessionId: "session-v2-smoke",
    input,
    instructions: "system",
    tools: [],
    parallelToolCalls: true,
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  assert.equal(capturedHeaders.get("accept"), "text/event-stream");
  assert.equal(capturedHeaders.get("content-type"), "application/json");
  assert.match(capturedHeaders.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.store, false);
  assert.deepEqual(capturedBody.input.at(-1), { type: "compaction_trigger" });
  assert.deepEqual(capturedBody.include, ["reasoning.encrypted_content"]);

  assert.deepEqual(result.output.map((item) => item.type), ["message", "compaction"]);
  assert.equal(result.output.at(-1).encrypted_content, unicodeBlob);
  assert.equal(result.usage?.input, 42);
  assert.equal(result.usage?.output, 3);
  assert.equal(result.usage?.totalTokens, 45);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("remote compaction v2 smoke ok");
