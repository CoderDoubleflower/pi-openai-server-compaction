/**
 * Public Pi extension entrypoint.
 *
 * Installs the private Pi 0.84.x same-run compaction adapter before the host
 * session binds extension internals, then delegates all existing OpenAI
 * compaction behavior to the original extension factory.
 */
import {
  AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import openaiServerCompactionExtension from "./index.ts";
import {
  installHostInlineAutoCompactionAdapter,
  installInlineAutoCompactionAdapter,
} from "./inline-auto-compaction.ts";
import { registerMidRunCompaction } from "./mid-run-compaction.ts";

export default async function extension(pi: ExtensionAPI): Promise<void> {
  // Pi aliases this static import to its own host module, including bundled and
  // virtual-module runtimes. Host discovery remains as a fallback for duplicate
  // independently loaded identities.
  const directStatus = installInlineAutoCompactionAdapter({
    sessionClass: AgentSession as never,
  });
  const discoveredStatus = await installHostInlineAutoCompactionAdapter();
  const adapterStatus = directStatus.supported ? directStatus : discoveredStatus;

  openaiServerCompactionExtension(pi);
  registerMidRunCompaction(pi, adapterStatus);
}
