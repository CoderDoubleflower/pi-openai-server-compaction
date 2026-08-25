# Transparent mid-run compaction

`pi-openai-server-compaction` can compact a long-running tool loop before Pi sends its next provider request, without aborting or replacing the active agent run.

## Enable it

The feature is opt-in:

```json
{
  "midRunCompaction": "resume"
}
```

The same setting can be supplied through the environment:

```bash
PI_OPENAI_SERVER_COMPACTION_MID_RUN=resume pi
```

The default is `"off"`.

The trigger reuses the normal compaction threshold:

- `compactThreshold` when it is greater than zero;
- otherwise `model.contextWindow * thresholdRatio`;
- otherwise the existing 80,000-token fallback.

## Custom providers and model fallback

Mid-run compaction no longer uses an `openai` / `openai-codex` provider allowlist.

When `model` is set to an explicit Pi model reference, that exact registered provider/model is attempted first:

```json
{
  "midRunCompaction": "resume",
  "model": "my-responses-provider/my-model"
}
```

The selected model may use a custom provider name or custom API identifier. It must expose a usable `baseUrl` (either on the model or through the provider's resolved authentication configuration) whose Responses endpoint is one of:

- the configured URL itself when it already ends in `/responses`;
- `<baseUrl>/responses` when it ends in `/v1`;
- otherwise `<baseUrl>/v1/responses`.

Provider-supplied headers are preserved. Built-in `openai/*` and `openai-codex/*` models continue to use their existing endpoint and identity-header behavior.

The fallback order is:

```text
configured provider/model
        ↓ on authentication, HTTP, or protocol failure
current session model
        ↓ if remote compaction still fails
portable local summary
        ↓ if local summarization also fails
Pi default compaction
```

A remote artifact that was successfully created for a custom provider is replayed on later matching requests based on its persisted model key, not on a provider-name allowlist.

## Runtime behavior

At an awaited `turn_end` boundary, after the current tool batch has completed and before the next model request is prepared, the extension:

1. checks `ctx.getContextUsage()` against the configured threshold;
2. verifies that the latest tool-call batch is fully paired with tool results;
3. invokes Pi 0.84.x's private `_runAutoCompaction("threshold", false)` method;
4. lets the existing `session_before_compact` pipeline produce the portable summary and Responses V2 encrypted compaction blob;
5. lets Pi append the normal compaction entry and rebuild `agent.state.messages`;
6. replaces the next low-level agent-loop message snapshot with the rebuilt compacted messages;
7. continues inside the original agent run and original `session.prompt()` promise.

It does not call public `ctx.compact()`, does not abort the run, and does not inject a synthetic user or custom continuation message.

## Compatibility and failure behavior

This feature intentionally relies on Pi private internals and is currently scoped to the package's supported Pi range, `>=0.84.2 <0.85.0`.

The adapter validates the private method shape before enabling transparent compaction. If the host class cannot be located, the method shape has drifted, the owning session cannot be captured, or a tool call remains unpaired, the feature fails closed: the active run is left alive and no interrupting fallback is attempted.

Transient failures use per-session exponential backoff:

```text
1s → 2s → 4s → 8s → 16s → 30s
```

A real user cancellation is forwarded to Pi's compaction controller through `abortCompaction()` while preserving the active run's cancellation semantics.

## Notifications

With `"notify": true`, successful threshold detection and completion are shown in the UI. Errors, configured-model fallback, and permanent compatibility warnings are surfaced even when ordinary feature notifications are disabled, because otherwise `midRunCompaction: "resume"` could appear to be active while doing nothing.

## Validation

Run the offline adapter and trigger regression suite:

```bash
npm run smoke:midrun
```

Run the custom-provider transport, fallback, trigger, and replay regression suite:

```bash
npm run smoke:custom-provider
```

The full repository test command also includes both:

```bash
npm test
```
