/**
 * Main extension entrypoint.
 *
 * The opt-in Remote Context layer wraps the final provider-agnostic hooks so
 * window management cannot fall through to legacy compaction/history replay.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiServerCompactionCore from "./index-core.ts";
import { createProviderAgnosticExtensionApi } from "./provider-agnostic-hooks.ts";
import { createContextManagementExtensionApi } from "./context-management/runtime.ts";
import { clearContinuationState, clearRemoteCompactionState, clearResponsesRequestShapeState } from "./state.ts";
import { releaseWsSession } from "./openai-ws-stream.ts";

export default function openaiServerCompactionExtension(pi: ExtensionAPI): void {
  const remoteApi = createContextManagementExtensionApi(pi, (sessionId) => {
    clearContinuationState(sessionId);
    clearRemoteCompactionState(sessionId);
    clearResponsesRequestShapeState(sessionId);
    releaseWsSession(sessionId);
  });
  openaiServerCompactionCore(createProviderAgnosticExtensionApi(remoteApi));
}
