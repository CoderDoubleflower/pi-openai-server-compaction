/**
 * Public Pi extension entrypoint.
 *
 * Pi 0.84.4+ owns automatic compaction timing, including threshold checks
 * between tool execution and the next assistant response in the same run. This
 * extension only customizes compaction through Pi's public lifecycle hooks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openaiServerCompactionExtension from "./index.ts";

export default function extension(pi: ExtensionAPI): void {
  openaiServerCompactionExtension(pi);
}
