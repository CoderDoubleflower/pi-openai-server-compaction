import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: publicExtension } = await import(
  pathToFileURL(join(repoRoot, "src", "extension.ts")).href
);
assert.equal(typeof publicExtension, "function", "public extension entrypoint should load");
const inlineModule = await import(
  pathToFileURL(join(repoRoot, "src", "inline-auto-compaction.ts")).href
);
const triggerModule = await import(
  pathToFileURL(join(repoRoot, "src", "mid-run-compaction.ts")).href
);

const {
  compactInlineAtTurnBoundary,
  installInlineAutoCompactionAdapter,
} = inlineModule;
const { registerMidRunCompaction } = triggerModule;
const { loadConfig } = await import(
  pathToFileURL(join(repoRoot, "src", "config.ts")).href
);

const previousMidRunEnv = process.env.PI_OPENAI_SERVER_COMPACTION_MID_RUN;
process.env.PI_OPENAI_SERVER_COMPACTION_MID_RUN = "resume";
assert.equal(loadConfig("/tmp/nonexistent-mid-run-config").midRunCompaction, "resume");
if (previousMidRunEnv === undefined) {
  delete process.env.PI_OPENAI_SERVER_COMPACTION_MID_RUN;
} else {
  process.env.PI_OPENAI_SERVER_COMPACTION_MID_RUN = previousMidRunEnv;
}

function createDeferred() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

function createSessionClass({ activeMessages, gate } = {}) {
  return class FakeSession {
    constructor() {
      this.runCalls = [];
      this.abortCompactionCalls = 0;
      this._extensionRunner = { emit: async () => undefined };
      this.compactedMessages = [
        { role: "user", content: "summary" },
        { role: "toolResult", toolCallId: "tool-1", content: "kept" },
      ];
      this.branch = [
        { type: "message", id: "m-1" },
        { type: "message", id: "m-2" },
      ];
      const messages = activeMessages ?? [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "tool-1", content: "ok" },
      ];
      this.sessionManager = {
        getBranch: () => this.branch,
        appendCompaction: () => {
          this.branch = [
            ...this.branch,
            { type: "compaction", id: `cmp-${this.runCalls.length}` },
          ];
        },
        buildSessionContext: () => ({
          messages: this.branch.some((entry) => entry.type === "compaction")
            ? this.compactedMessages
            : messages,
        }),
      };
      this.agent = {
        state: { messages },
        prepareNextTurnWithContext: async (turn) => ({ context: turn.context }),
      };
      this.gate = gate;
    }

    _bindExtensionCore() {}

    abortCompaction() {
      this.abortCompactionCalls += 1;
      this._autoCompactionAbortController?.abort();
    }

    async _runAutoCompaction(reason, willRetry) {
      // These are real operational markers used by the compatibility detector.
      if (false) await this._extensionRunner.emit({ type: "session_before_compact" });
      this._autoCompactionAbortController = new AbortController();
      try {
        await this.gate;
        if (this._autoCompactionAbortController.signal.aborted) return false;
        this.runCalls.push([reason, willRetry]);
        this.sessionManager.appendCompaction();
        const sessionContext = this.sessionManager.buildSessionContext();
        this.agent.state.messages = sessionContext.messages;
        if (false) await this._extensionRunner.emit({ type: "session_compact" });
        return false;
      } finally {
        this._autoCompactionAbortController = undefined;
      }
    }
  };
}

{
  const SessionClass = createSessionClass();
  assert.deepEqual(installInlineAutoCompactionAdapter({ sessionClass: SessionClass }), {
    supported: true,
  });
  const session = new SessionClass();
  session._bindExtensionCore({});

  const result = await compactInlineAtTurnBoundary(session.sessionManager);
  assert.equal(result.compactionEntryId, "cmp-1");
  assert.deepEqual(session.runCalls, [["threshold", false]]);

  const next = await session.agent.prepareNextTurnWithContext({
    context: { messages: [{ role: "user", content: "stale" }] },
  });
  assert.deepEqual(next.context.messages, session.compactedMessages);
}

{
  const SessionClass = createSessionClass({
    activeMessages: [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tool-unpaired", name: "read", arguments: {} }],
      },
    ],
  });
  installInlineAutoCompactionAdapter({ sessionClass: SessionClass });
  const session = new SessionClass();
  session._bindExtensionCore({});

  await assert.rejects(
    () => compactInlineAtTurnBoundary(session.sessionManager),
    /tool call is still in flight/,
  );
  assert.equal(session.runCalls.length, 0);
}

{
  const deferred = createDeferred();
  const SessionClass = createSessionClass({ gate: deferred.promise });
  installInlineAutoCompactionAdapter({ sessionClass: SessionClass });
  const session = new SessionClass();
  session._bindExtensionCore({});
  const controller = new AbortController();

  const pending = compactInlineAtTurnBoundary(session.sessionManager, controller.signal);
  await Promise.resolve();
  controller.abort();
  deferred.release();

  await assert.rejects(() => pending, /Compaction cancelled/);
  assert.ok(session.abortCompactionCalls >= 1);
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    includeAzure: false,
    compactThreshold: 70,
    thresholdRatio: 0.7,
    notify: false,
    usePreviousResponseId: true,
    midRunCompaction: "resume",
    model: "current",
    reasoningEffort: "inherit",
    ...overrides,
  };
}

function createPiHarness({ config, inlineCompact, adapterStatus = { supported: true }, now }) {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerMidRunCompaction(pi, adapterStatus, {
    inlineCompact,
    configLoader: () => config,
    now,
  });
  return handlers;
}

function createCtx(tokens = 75) {
  const notices = [];
  const sessionManager = { getSessionId: () => "session-1" };
  return {
    cwd: "/tmp/project",
    model: {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-test",
      contextWindow: 100,
    },
    sessionManager,
    signal: new AbortController().signal,
    hasUI: true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens, contextWindow: 100, percent: tokens }),
    ui: {
      notify: (message, type) => notices.push([message, type]),
      setWorkingVisible: () => undefined,
    },
    notices,
  };
}

{
  const calls = [];
  const handlers = createPiHarness({
    config: baseConfig(),
    inlineCompact: async (sessionManager, signal) => {
      calls.push([sessionManager, signal]);
      return { compactionEntryId: "cmp-trigger" };
    },
  });
  const ctx = createCtx();
  await handlers.get("turn_end")(
    { message: { stopReason: "toolUse" }, toolResults: [{}] },
    ctx,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx.sessionManager);
  assert.equal(calls[0][1], ctx.signal);
}

{
  let calls = 0;
  const handlers = createPiHarness({
    config: baseConfig({ midRunCompaction: "off" }),
    inlineCompact: async () => {
      calls += 1;
      return { compactionEntryId: "cmp" };
    },
  });
  await handlers.get("turn_end")(
    { message: { stopReason: "toolUse" }, toolResults: [{}] },
    createCtx(),
  );
  assert.equal(calls, 0);
}

{
  let currentTime = 0;
  let calls = 0;
  const handlers = createPiHarness({
    config: baseConfig(),
    inlineCompact: async () => {
      calls += 1;
      throw new Error("boom");
    },
    now: () => currentTime,
  });
  const ctx = createCtx();
  const event = { message: { stopReason: "toolUse" }, toolResults: [{}] };
  await handlers.get("turn_end")(event, ctx);
  assert.equal(calls, 1);
  currentTime = 500;
  await handlers.get("turn_end")(event, ctx);
  assert.equal(calls, 1, "backoff should suppress immediate retries");
  currentTime = 1001;
  await handlers.get("turn_end")(event, ctx);
  assert.equal(calls, 2);
}

console.log("mid-run compaction smoke ok");
