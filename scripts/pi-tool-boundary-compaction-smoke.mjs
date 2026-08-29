import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentSession } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: extension } = await import(
  pathToFileURL(join(repoRoot, "src", "extension.ts")).href
);
assert.equal(typeof extension, "function", "public extension entrypoint should load");

// Confirm the extension consumes Pi's public compaction lifecycle and does not
// install its own turn_end trigger.
const handlers = new Map();
const providers = [];
const pi = {
  registerProvider(provider, definition) {
    providers.push([provider, definition]);
  },
  on(name, handler) {
    const eventHandlers = handlers.get(name) ?? [];
    eventHandlers.push(handler);
    handlers.set(name, eventHandlers);
  },
};
extension(pi);
assert.equal(providers.some(([provider]) => provider === "openai"), true);
assert.equal(handlers.has("session_before_compact"), true);
assert.equal(handlers.has("session_compact"), true);
assert.equal(handlers.has("turn_end"), false);

// Pi 0.84.4's host implementation owns the threshold check. Exercise the real
// host method against a minimal session-shaped object to verify that a large
// post-tool context invokes the standard non-retrying auto-compaction path and
// refreshes the messages used by the next assistant request.
const hostPrototype = AgentSession.prototype;
const compactBeforeNextAssistantResponse =
  hostPrototype._compactBeforeNextAssistantResponse;
assert.equal(
  typeof compactBeforeNextAssistantResponse,
  "function",
  "Pi 0.84.4+ should expose its internal tool-boundary threshold check",
);

const compactCalls = [];
const compactedMessages = [
  {
    role: "compactionSummary",
    summary: "compacted history from Pi",
    timestamp: Date.now(),
  },
];
const hostLike = {
  model: { contextWindow: 1_000 },
  settingsManager: {
    getCompactionSettings: () => ({
      enabled: true,
      reserveTokens: 100,
      keepRecentTokens: 100,
    }),
  },
  agent: { state: { messages: compactedMessages } },
  async _runAutoCompaction(reason, willRetry) {
    compactCalls.push([reason, willRetry]);
    return false;
  },
};

const largeContext = {
  systemPrompt: "",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: `large-tool-result:${"x".repeat(16_000)}` }],
      timestamp: Date.now(),
    },
  ],
  tools: [],
};
const refreshed = await compactBeforeNextAssistantResponse.call(hostLike, largeContext);
assert.deepEqual(compactCalls, [["threshold", false]]);
assert.deepEqual(refreshed.messages, compactedMessages);
assert.notEqual(refreshed.messages, compactedMessages, "host should return a fresh message snapshot");

compactCalls.length = 0;
const smallContext = {
  ...largeContext,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "small tool result" }],
      timestamp: Date.now(),
    },
  ],
};
const unchanged = await compactBeforeNextAssistantResponse.call(hostLike, smallContext);
assert.equal(unchanged, smallContext);
assert.deepEqual(compactCalls, []);

// The host auto-compaction implementation must continue routing through the
// public hooks that this extension registers.
const runAutoCompactionSource = Function.prototype.toString.call(
  hostPrototype._runAutoCompaction,
);
assert.match(runAutoCompactionSource, /session_before_compact/);
assert.match(runAutoCompactionSource, /session_compact/);

console.log("Pi tool-boundary compaction compatibility smoke ok");
