/**
 * Public Pi extension entrypoint.
 *
 * Installs the private Pi 0.84.x same-run compaction adapter before the host
 * session binds extension internals, then delegates all existing OpenAI
 * compaction behavior to the original extension factory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiServerCompactionExtension from "./index.ts";
import { installHostInlineAutoCompactionAdapter } from "./inline-auto-compaction.ts";
import { registerMidRunCompaction } from "./mid-run-compaction.ts";

export default async function extension(pi: ExtensionAPI): Promise<void> {
  const adapterStatus = await installHostInlineAutoCompactionAdapter();
  openaiServerCompactionExtension(pi);
  registerMidRunCompaction(pi, adapterStatus);
}
