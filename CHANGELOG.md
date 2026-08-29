# Changelog

This changelog intentionally starts at **0.1.0**.

## Unreleased

## 0.1.5 - 2026-08-29
- require Pi `>=0.84.4 <0.85.0`; Pi now owns threshold checks between completed tool execution and the next assistant response in the same run
- remove the extension-managed `turn_end` trigger, private `AgentSession` adapter, host discovery, retry/backoff state, and next-context patching
- remove the `midRunCompaction` setting, its environment override, dedicated guide, obsolete smoke suite, and adapter-specific third-party notice
- keep remote compaction on Pi's public `session_before_compact` and `session_compact` lifecycle
- add a Pi 0.84.4 host-contract smoke test covering the native threshold call, refreshed context, public hook registration, and absence of an extension `turn_end` listener
- retain `compactThreshold` and `thresholdRatio`; these configure direct-OpenAI Responses `context_management`, not Pi's local trigger

## 0.1.4 - 2026-08-25
- support configured custom Responses-compatible compaction providers, provider headers, base URL overrides, fallback to the current model, and model-keyed replay
- add offline custom-provider transport, fallback, and replay coverage

## 0.1.3 - 2026-08-25
- introduced an opt-in private compatibility adapter for same-run compaction on Pi 0.84.3; this implementation is removed in 0.1.5 because Pi 0.84.4 provides the capability natively

## 0.1.2 - 2026-08-25
- consume Responses V2 compaction incrementally over SSE
- validate exactly one non-empty encrypted compaction item and harden stream error, cancellation, UTF-8, and completion handling

## 0.1.1 - 2026-08-22
- restore Pi-native prompt-cache behavior on the custom WebSocket transport
- port the extension to Pi 0.84.x and migrate remote compaction to a streamed Responses request containing `compaction_trigger`
- add reproducible native-vs-text and product-defaults benchmarks

## 0.1.0 - 2026-04-09
- initial public release
- add hybrid portable-summary and provider-native compaction continuity
- persist and reconstruct remote replacement history across resume, model changes, and tree operations
- add WebSocket continuation, conservative `previous_response_id` reuse, live RPC coverage, documentation, and MIT licensing
