/**
 * Convert Pi 0.84+'s nullable ProviderHeaders into the concrete string headers
 * accepted by Pi's compaction helper and the raw fetch-based compaction path.
 *
 * A null value means "do not send this caller-provided header". Raw fetch and
 * the legacy compaction helper cannot represent nullable values, so they are
 * omitted rather than stringified or forwarded as invalid header values.
 */
import type { ProviderHeaders } from "@earendil-works/pi-ai";

export function normalizeProviderHeaders(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const entries = Object.entries(headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
