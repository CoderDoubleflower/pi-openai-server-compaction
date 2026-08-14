# pi-openai-server-compaction

A Pi extension that adds **Codex-style OpenAI server-side compaction** while preserving Pi's normal session, tool, fork, tree, and portability behavior.

The extension mirrors the OpenAI Responses compaction flow used by Codex: it sends the active conversation to the Responses API with a trailing `compaction_trigger`, stores the returned opaque compaction item, and keeps a portable Pi text summary as a fallback.

> **Status:** experimental but live-tested against real Pi + OpenAI backends.

## Support matrix

| Provider/model family | Remote compaction | `previous_response_id` continuity | Custom WS stream | Live-tested |
|---|---:|---:|---:|---:|
| `openai/*` | Yes | Yes | Yes | Yes |
| `openai-codex/*` | Yes | No (built-in transport retained) | No (built-in transport retained) | Yes |
| Azure | Partial (opt-in via config) | Partial | No | No |

## Install

**Only GitHub installation is supported.**

Project-local installation is recommended:

```bash
pi install -l git:github.com/CoderDoubleflower/pi-openai-server-compaction
```

Or install globally:

```bash
pi install git:github.com/CoderDoubleflower/pi-openai-server-compaction
```

After updating the extension, run `/reload` in Pi if needed.

## Requirements

- Node `>= 22`
- Pi `>=0.80.9 <0.81.0`
- Working Pi authentication/configuration for the model used for compaction
- A supported OpenAI Responses model, for example `openai/gpt-5.6-sol` or `openai-codex/gpt-5.6-sol`

## What it does

On compaction, the extension runs two paths in parallel:

1. Generates a **portable Pi text summary** for cross-model/session portability.
2. Calls OpenAI Responses remote compaction and stores the returned opaque `compaction` item for higher-fidelity continuation on compatible OpenAI models.

For direct `openai/*` models between compactions, the extension also:

- patches requests with `store: true` and `context_management`
- uses `previous_response_id` for live continuation when safe
- provides a WebSocket-backed transport path with HTTP fallback

For `openai-codex/*` models, the extension keeps Pi's built-in Codex transport and injects reconstructed remote-compaction history after compaction boundaries.

## Configurable compaction model and reasoning effort

The compaction request no longer has to use exactly the same concrete model and thinking strength as the active Pi session.

You can configure:

- `model`: which model performs compaction
- `reasoningEffort`: how much reasoning effort the compaction request uses

Example:

```json
{
  "enabled": true,
  "model": "openai/gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

### `model`

Default:

```json
{
  "model": "current"
}
```

`"current"` means the active Pi model is used, preserving the extension's original behavior.

To override it, use Pi's `provider/model-id` syntax:

```json
{
  "model": "openai/gpt-5.6-sol"
}
```

The configured model must:

- exist in Pi's model registry
- support this extension's OpenAI remote-compaction flow
- use the **same provider/API family** as the active session model

Changing only the concrete model id is supported. For example, an `openai/*` session can use another compatible `openai/*` model for compaction.

If the configured model is invalid, unavailable, incompatible, or cannot be authenticated, the extension falls back to the current session model and shows a warning when UI is available.

### `reasoningEffort`

Default:

```json
{
  "reasoningEffort": "inherit"
}
```

Supported values:

- `inherit`
- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

`inherit` keeps the original behavior: the extension mirrors the surrounding Responses request when available, otherwise it falls back to Pi's current thinking level.

An explicit value overrides that behavior for the compaction request. For example:

```json
{
  "model": "openai/gpt-5.6-sol",
  "reasoningEffort": "xhigh"
}
```

This is useful when the interactive session uses a faster/cheaper model or lower thinking level, but you want compaction to spend more compute preserving long-term context.

## Configuration

Configuration is read from:

- `~/.pi/agent/openai-server-compaction.json` — global
- `.pi/openai-server-compaction.json` — project-local, takes precedence

Full example:

```json
{
  "enabled": true,
  "includeAzure": false,
  "thresholdRatio": 0.7,
  "compactThreshold": 0,
  "usePreviousResponseId": true,
  "notify": false,
  "model": "current",
  "reasoningEffort": "inherit"
}
```

Environment overrides:

| Variable | Effect |
|---|---|
| `PI_OPENAI_SERVER_COMPACTION_ENABLED` | Enable/disable the extension |
| `PI_OPENAI_SERVER_COMPACTION_AZURE` | Include Azure OpenAI models |
| `PI_OPENAI_SERVER_COMPACTION_THRESHOLD` | Explicit compact threshold in tokens |
| `PI_OPENAI_SERVER_COMPACTION_RATIO` | Compact threshold as a ratio of context window; default `0.7` |
| `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | Enable/disable `previous_response_id` |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY` | Show UI notifications when features activate |
| `PI_OPENAI_SERVER_COMPACTION_MODEL` | Compaction model: `current` or `provider/model-id` |
| `PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT` | Compaction reasoning effort: `inherit`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` |

Example using environment variables:

```bash
PI_OPENAI_SERVER_COMPACTION_MODEL=openai/gpt-5.6-sol \
PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT=high \
pi
```

## How compaction works

On a supported Pi compaction event, the extension:

1. Resolves the configured compaction model, or uses the current model.
2. Resolves authentication for that model.
3. Converts the current Pi branch into OpenAI Responses items.
4. Normalizes the history for the selected compaction model.
5. Generates a portable Pi text summary.
6. Calls the Responses endpoint with conversation history, tools, system instructions, reasoning configuration, text configuration, and a trailing `compaction_trigger`.
7. Stores the returned opaque compaction artifact in `CompactionEntry.details.remoteCompaction`.
8. Records `compactionModelKey` so the model that actually generated the artifact can be inspected later.

The replay compatibility key remains tied to the active session model so existing session reconstruction and continuation behavior are preserved.

## Safety and fallback behavior

The extension clears live continuation state on session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

If remote compaction fails but the portable local summary succeeds, Pi continues using the local summary rather than losing the compaction operation entirely.

## Data handling

Users should be aware:

- direct `openai/*` requests are patched with `store: true`
- conversation context is sent to OpenAI's Responses compaction protocol
- returned opaque compaction artifacts are stored in Pi's local session JSONL
- these artifacts are provider-native and not human-readable

## Troubleshooting

If something goes wrong:

1. Disable the extension with `PI_OPENAI_SERVER_COMPACTION_ENABLED=0` or `"enabled": false`.
2. Run Pi with `--no-extensions` to bypass extensions entirely.
3. Run `/reload` after changing configuration or updating the GitHub installation.
4. Remove the extension with `pi remove pi-openai-server-compaction`.
5. Inspect session JSONL for `compaction` entries containing `details.remoteCompaction` and `compactionModelKey`.

## Testing

Smoke test:

```bash
npm run smoke
```

Live end-to-end test, requiring working Pi + OpenAI authentication:

```bash
npm run test:live
```

Override the live-test model:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:live
```

## Limitations

- Pi's local JSONL/tree model remains authoritative.
- Opaque remote compaction artifacts are only reused for compatible OpenAI Responses turns.
- A configured compaction model may change the model id, but not the provider/API family of the active session model.
- Switching to a different provider/model falls back to Pi's portable text-summary path.
- Compaction usage/cost is captured in details but is not yet folded into Pi's `get_session_stats()`.

## Repo layout

| File | Purpose |
|---|---|
| `src/index.ts` | Extension wiring, compaction hook, lifecycle handling |
| `src/remote-compaction.ts` | Responses compaction v2 integration and replacement-history handling |
| `src/openai-ws-stream.ts` | WebSocket continuation path |
| `src/openai-ws-connection.ts` | WebSocket connection manager |
| `src/openai.ts` | Model detection and payload patching |
| `src/custom-stream.ts` | Provider override entrypoint |
| `src/config.ts` | Configuration loading |
| `src/state.ts` | Ephemeral per-session runtime state |
| `src/stream-message-shared.ts` | Shared assistant message builders |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test |
| `scripts/smoke.mjs` | Offline smoke test |
| `ARCHITECTURE.md` | Design and control-flow documentation |
| `TESTPLAN.md` | Manual and automated test plan |
| `CHANGELOG.md` | Version history |

## License

MIT. See `LICENSE.md`.
