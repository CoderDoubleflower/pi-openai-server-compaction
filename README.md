# pi-openai-server-compaction

A Pi extension that adds **Codex-style Responses server-side compaction** while preserving Pi's normal session, tool, fork, tree, and portability behavior.

The extension sends the active conversation to a Responses-compatible endpoint with a trailing `compaction_trigger`, stores the returned opaque compaction item, and keeps a portable Pi text summary as a fallback.

> **Status:** experimental. Built-in OpenAI backends are live-tested; custom-provider behavior has offline transport and fallback coverage.

## Support matrix

| Provider/model family | Remote compaction | `previous_response_id` continuity | Custom WS stream | Validation |
|---|---:|---:|---:|---:|
| `openai/*` | Yes | Yes | Yes | Live-tested |
| `openai-codex/*` | Yes | No (built-in transport retained) | No (built-in transport retained) | Live-tested |
| Custom Responses-compatible provider | Yes, with a usable `baseUrl` | Provider-dependent | No | Offline-tested |
| Azure | Partial (opt-in via config) | Partial | No | Not live-tested |

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

- Node `>=22.19.0`
- Pi `>=0.84.4 <0.85.0`
- working Pi authentication/configuration for the model used for compaction
- a Responses-compatible compaction model, either built in or registered through a custom Pi provider
- for custom providers, a usable `baseUrl` on the model or returned by the provider's auth resolution

Pi 0.84.4 is the minimum because Pi itself now performs the auto-compaction threshold check after tool results and before the next assistant response in the same agent run.

## What it does

On compaction, the extension runs two paths in parallel:

1. Generates a **portable Pi text summary** for cross-model/session portability.
2. Calls a Responses V2 remote-compaction endpoint and stores the returned opaque `compaction` item for higher-fidelity continuation on a compatible model.

For direct `openai/*` models between compactions, the extension also:

- patches requests with `store: true` and `context_management`
- uses `previous_response_id` for live continuation when safe
- provides a WebSocket-backed transport path with HTTP fallback
- preserves Pi's native OpenAI prompt-cache fields on both the WebSocket and HTTP paths

For `openai-codex/*` models, the extension keeps Pi's built-in Codex transport and injects reconstructed remote-compaction history after compaction boundaries.

For a custom provider, the extension uses the registered model, resolved auth/base URL, and provider-supplied headers. It does not register or replace that provider's normal stream implementation.

## Pi-native tool-boundary auto-compaction

The extension no longer contains a separate same-run trigger or patches private `AgentSession` methods.

With Pi 0.84.4 or newer, Pi owns the complete trigger sequence:

```text
assistant requests tools
→ tools finish and results are appended
→ Pi checks its auto-compaction threshold
→ Pi emits session_before_compact when the threshold is crossed
→ this extension supplies the portable summary and Responses V2 artifact
→ Pi persists the compaction, refreshes agent context, and starts the next assistant response
```

Pi only performs this between-turn check when the agent loop will actually continue. A terminating tool batch with no queued steering or follow-up message does not cause an unnecessary compaction.

The trigger uses Pi's normal compaction settings, including `compaction.enabled`, `compaction.reserveTokens`, and `compaction.keepRecentTokens`. The obsolete extension setting `midRunCompaction` and environment variable `PI_OPENAI_SERVER_COMPACTION_MID_RUN` have been removed; old occurrences are ignored as unknown configuration.

The extension's `compactThreshold` and `thresholdRatio` settings remain separate: they control the OpenAI Responses `context_management[].compact_threshold` field for direct `openai/*` requests. They do **not** control Pi's local tool-boundary trigger.

Manual `/compact` and overflow recovery use the same public Pi compaction lifecycle and therefore use the same extension implementation.

## Prompt-cache behavior

The custom WebSocket path for direct `openai/*` models mirrors Pi's native OpenAI Responses cache behavior instead of silently dropping cache configuration:

- the Pi session id is sent as a stable `prompt_cache_key`
- keys are clamped to OpenAI's 64-Unicode-code-point limit
- the default cache retention remains `short`
- `cacheRetention: "long"` sends `prompt_cache_retention: "24h"` only when the model declares support
- `cacheRetention: "none"` removes the cache key and only sends `prompt_cache_options: { "mode": "explicit" }` for models that declare support for that field
- a caller's `onPayload` hook still runs after these defaults are applied and can inspect or override them

Pi's compatibility environment setting is also preserved:

```bash
PI_CACHE_RETENTION=long pi
```

Compaction changes the effective prompt prefix. Therefore, the first request after an actual compaction can legitimately have a lower cache-hit rate; subsequent requests should establish a new reusable prefix.

## Configurable compaction model and fallback

The compaction request does not have to use the active Pi model.

You can configure:

- `model`: which registered provider/model is attempted first
- `reasoningEffort`: how much reasoning effort the compaction request uses

Example with a custom provider:

```json
{
  "enabled": true,
  "model": "my-responses-provider/my-model",
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

`"current"` means the active Pi model is used.

To override it, use Pi's `provider/model-id` syntax:

```json
{
  "model": "my-responses-provider/my-model"
}
```

The configured model must exist in Pi's model registry. It is **not** required to use the same provider name or API identifier as the active session model.

For a custom provider, the extension resolves its authentication and final base URL through Pi's model registry, preserves provider headers, and constructs the Responses endpoint as follows:

```text
base URL already ends in /responses → use it directly
base URL ends in /v1                → append /responses
otherwise                           → append /v1/responses
```

Built-in `openai/*` and `openai-codex/*` models continue to use their existing specialized endpoint and identity-header behavior.

The operational fallback order is:

```text
configured provider/model
        ↓ authentication, HTTP, or protocol failure
current session model
        ↓ remote compaction failure
portable local summary
        ↓ local summarization failure
Pi default compaction
```

Fallback warnings are shown when a UI is available. Cancellation does not start another fallback request.

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

`inherit` mirrors the surrounding Responses request when available, otherwise it falls back to Pi's current thinking level. An explicit value overrides that behavior for the compaction request.

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
| `PI_OPENAI_SERVER_COMPACTION_AZURE` | Include Azure OpenAI models for legacy continuation behavior |
| `PI_OPENAI_SERVER_COMPACTION_THRESHOLD` | Explicit Responses `context_management` threshold in tokens |
| `PI_OPENAI_SERVER_COMPACTION_RATIO` | Responses `context_management` threshold as a ratio of context window; default `0.7` |
| `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | Enable/disable `previous_response_id` and the direct-OpenAI custom WebSocket path |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY` | Show ordinary UI notifications when features activate |
| `PI_OPENAI_SERVER_COMPACTION_MODEL` | Compaction model: `current` or any registered `provider/model-id` |
| `PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT` | `inherit`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `PI_CACHE_RETENTION` | Pi/OpenAI prompt-cache compatibility setting |

Example:

```bash
PI_OPENAI_SERVER_COMPACTION_MODEL=my-responses-provider/my-model \
PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT=high \
pi
```

Pi's local automatic trigger is configured in Pi's own `settings.json`, not in this extension's configuration file.

## How compaction works

On a Pi compaction event, the extension:

1. Resolves the configured compaction model and retains the current model as fallback.
2. Resolves authentication, headers, and any auth-overridden base URL for the candidate.
3. Converts the current Pi branch into Responses items.
4. Normalizes the history for the candidate model.
5. Generates a portable Pi text summary.
6. Calls the candidate's Responses endpoint with conversation history, tools, system instructions, tuning fields, and a trailing `compaction_trigger`.
7. On candidate failure, retries with the current session model.
8. Stores a successful opaque artifact in `CompactionEntry.details.remoteCompaction`.
9. Records `compactionModelKey` so the model that actually generated the artifact can be inspected.

The replay compatibility key remains tied to the active session model, preserving Pi session reconstruction semantics while allowing a different model to perform compaction.

## Safety and fallback behavior

The extension clears live continuation state on session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Persisted remote history is replayed only when its model key matches the active request model. This matching rule applies equally to built-in and custom providers. Cross-model turns are filtered during reconstruction to prevent contamination after resume or tree navigation.

If all remote candidates fail but the portable local summary succeeds, Pi continues using the local summary. If local summarization also fails, the extension returns control to Pi's default compaction implementation.

## Data handling

Users should be aware:

- direct `openai/*` requests may be patched with `store: true`
- compaction context is sent to the selected provider's Responses-compatible endpoint
- returned opaque compaction artifacts are stored in Pi's local session JSONL
- these artifacts are provider-native and not human-readable

## Troubleshooting

1. Set `"model": "current"` to bypass a custom compaction model while keeping the extension enabled.
2. Disable Pi's own automatic compaction in Pi settings when isolating automatic-trigger behavior; manual `/compact` remains available.
3. Disable only direct-OpenAI `previous_response_id`/WebSocket behavior with `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID=0 pi`.
4. Disable the extension completely with `PI_OPENAI_SERVER_COMPACTION_ENABLED=0` or `"enabled": false`.
5. Run Pi with `--no-extensions` to bypass extensions entirely.
6. Run `/reload` after changing configuration or updating the GitHub installation.
7. Inspect session JSONL for `compaction` entries containing `details.remoteCompaction` and `compactionModelKey`.

For a custom provider, verify its resolved `baseUrl`, auth header behavior, and support for streaming Responses events containing exactly one encrypted `compaction` item.

## Testing

Offline prompt-cache payload regression:

```bash
npm run smoke:cache
```

Offline Responses V2 protocol regression:

```bash
npm run smoke:v2
```

Pi 0.84.4 host-contract regression for tool-boundary auto-compaction:

```bash
npm run smoke:tool-boundary
```

Offline custom-provider endpoint, header, fallback, and replay regression:

```bash
npm run smoke:custom-provider
```

Full local test suite:

```bash
npm test
```

Live end-to-end test, requiring working Pi + OpenAI authentication:

```bash
npm run test:live
```

The repository does not include credentials for a live custom-provider test.

## Limitations

- Pi's local JSONL/tree model remains authoritative.
- Pi 0.84.4+ decides when automatic compaction runs; the extension customizes the resulting compaction through public hooks only.
- A custom provider must implement the Responses V2 streaming compaction protocol expected by this extension.
- `previous_response_id` and the custom WebSocket transport remain limited to the existing direct-OpenAI compatibility path; custom-provider remote-history replay does not imply those features.
- An actual compaction creates a new prompt-cache boundary; the first post-compaction request may be a cold or partial hit.
- Compaction usage/cost is captured in details but is not yet folded into Pi's `get_session_stats()`.

## Repo layout

| File | Purpose |
|---|---|
| `src/extension.ts` | Public entrypoint; delegates to public Pi extension hooks without patching `AgentSession` |
| `src/index.ts` | Provider-agnostic wrapper around the compatibility core |
| `src/index-core.ts` | OpenAI/Codex lifecycle and compaction implementation |
| `src/provider-agnostic-hooks.ts` | Configured-model attempt/fallback and custom-provider replay wrappers |
| `src/remote-compaction-transport.ts` | Built-in and custom endpoint/header resolution |
| `src/remote-compaction-v2.ts` | Incremental Responses V2 transport and validation |
| `src/openai-ws-stream.ts` | Direct-OpenAI WebSocket continuation path |
| `src/config.ts` | Configuration loading |
| `src/state.ts` | Ephemeral per-session runtime state |
| `scripts/pi-tool-boundary-compaction-smoke.mjs` | Pi 0.84.4 native trigger and public-hook compatibility regression |
| `scripts/custom-provider-compaction-smoke.mjs` | Custom-provider regression suite |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test |

## License

MIT. See `LICENSE.md`.
