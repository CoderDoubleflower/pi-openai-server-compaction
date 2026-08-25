/**
 * Main extension entrypoint.
 *
 * The original OpenAI/Codex implementation lives in index-core.ts. This layer
 * wraps its compaction and request hooks so user-registered providers can be
 * attempted directly and can reuse persisted remote compaction history.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiServerCompactionCore from "./index-core.ts";
import { createProviderAgnosticExtensionApi } from "./provider-agnostic-hooks.ts";

export default function openaiServerCompactionExtension(
  pi: ExtensionAPI,
): void {
  openaiServerCompactionCore(createProviderAgnosticExtensionApi(pi));
}
