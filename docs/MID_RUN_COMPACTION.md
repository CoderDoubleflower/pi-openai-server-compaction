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

## Runtime behavior

At an awaited `turn_end` boundary, after the current tool batch has completed and before the next model request is prepared, the extension:

1. checks `ctx.getContextUsage()` against the configured threshold;
2. verifies that the latest tool-call batch is fully paired with tool results;
3. invokes Pi 0.84.x's private `_runAutoCompaction("threshold", false)` method;
4. lets the existing `session_before_compact` handler produce the portable summary and Responses V2 encrypted compaction blob;
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

With `"notify": true`, successful threshold detection and completion are shown in the UI. Errors and permanent compatibility warnings are surfaced even when ordinary feature notifications are disabled, because otherwise `midRunCompaction: "resume"` could appear to be active while doing nothing.

## Validation

Run the offline adapter and trigger regression suite:

```bash
npm run smoke:midrun
```

The full repository test command also includes it:

```bash
npm test
```
