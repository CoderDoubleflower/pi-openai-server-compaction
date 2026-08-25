# Changelog

This changelog intentionally starts at **0.1.0**.

## Unreleased

## 0.1.3 - 2026-08-25
- add opt-in `midRunCompaction: "resume"` for transparent threshold compaction at awaited `turn_end` boundaries during long tool loops
- call Pi 0.84.x's private non-aborting `_runAutoCompaction("threshold", false)` pipeline so the original agent run and `session.prompt()` promise remain active without synthetic continuation messages
- capture the owning host `AgentSession`, fail closed on unknown private-method shapes, reject unpaired tool calls, forward real cancellation to `abortCompaction()`, and refresh the next low-level message snapshot from compacted `agent.state.messages`
- add per-session in-flight isolation, exponential retry backoff, one-time unsupported-host warnings, and an offline smoke suite covering same-run continuation, context refresh, tool-call safety, cancellation, configuration, threshold triggering, and retry suppression

## 0.1.2 - 2026-08-25
- consume Responses V2 compaction as an incremental SSE stream instead of buffering the successful response with `response.text()`
- validate that the stream completes with exactly one non-empty encrypted `compaction` blob and normalize the `compaction_summary` compatibility alias
- surface nested `error` and `response.failed` messages, preserve abort behavior during stream reads, and reject malformed or incomplete SSE responses
- add an offline protocol smoke test covering arbitrary byte chunking, split UTF-8 code points, CRLF framing, `[DONE]`, empty/duplicate blobs, failed streams, missing completion, and the full request-to-persisted-history path

## 0.1.1 - 2026-08-22
- restore Pi-native OpenAI prompt-cache behavior on the custom WebSocket transport
- send a stable, Unicode-aware, 64-code-point-clamped `prompt_cache_key` derived from Pi's session id
- preserve Pi's `short`, `long`, and `none` cache-retention semantics, including model-gated `prompt_cache_retention: "24h"` and GPT-5.6+ explicit cache-disable mode
- apply cache defaults before the caller's `onPayload` hook so callers can still inspect or override the final payload
- add an offline prompt-cache payload regression test covering key clamping, long-retention compatibility, cache disabling, and stale-field replacement
- port the extension from its earlier Pi 0.80.9 integration to Pi 0.84.2, including updated peer and development dependencies and Node `>=22.19.0`
- retain the Responses compaction v2 protocol, replacement-history normalization, Codex identity headers, WebSocket continuation, and HTTP fallback on the updated Pi API surface
- replace the legacy `/responses/compact` call with a normal Responses stream containing a trailing `compaction_trigger`, and persist the returned `compaction` item
- retain recent user messages with the same 20K-token budget shape used by Codex while continuing to read legacy version 1 session artifacts
- add reproducible native-vs-text and product-defaults compaction benchmarks, including corrected caveats around billed-token matching and the earlier same-budget interpretation
- correct package repository, homepage, and issue-tracker metadata for the CoderDoubleflower fork

During local development on 2026-04-09, the project used temporary internal version bumps while features, tests, docs, and packaging were being assembled. Those local-only bumps were collapsed before the first public push so the repository does not imply a longer tracked public release history than it actually has.

## 0.1.0 - 2026-04-09
- initial public release
- added hybrid Codex-style remote compaction for direct OpenAI Responses models
- added OpenAI `POST /v1/responses/compact` integration
- persisted opaque replacement history in Pi compaction details
- reconstructed remote compaction state across resume/reload/tree navigation
- added WS-backed continuation and conservative `previous_response_id` reuse
- tightened direct OpenAI continuation so unchanged request shapes send only incremental post-turn deltas instead of replaying full input alongside `previous_response_id`
- fixed reconstructed post-compaction remote replay to exclude turns completed by other models after later resume/tree reconstruction
- kept portable Pi text summaries as the readable fallback and non-OpenAI portability path
- hardened cross-model runtime state handling and remote output validation
- mirrored observed Responses `reasoning` and `text` tuning into remote compaction requests when available, with thinking-level fallback for reasoning
- fixed the direct OpenAI WS path to carry reasoning configuration and encrypted-reasoning inclusion like Pi's normal HTTP Responses path
- persisted remote compaction usage metadata when the backend returns it
- added a reduced-plaintext live replay regression with tiny Pi `keepRecentTokens`
- added a live Pi RPC regression harness in `tests/live/openai-compaction-rpc-live.ts`
- added a local smoke harness that bootstraps Pi peer-package links and runs small regression checks
- added `ARCHITECTURE.md`, testing docs, packaging polish, and MIT licensing
