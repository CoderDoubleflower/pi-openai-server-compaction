/**
 * Public remote-compaction surface.
 *
 * Core conversion/persistence helpers stay in remote-compaction-core.ts, while
 * Responses V2 transport is provided by remote-compaction-v2.ts so callers
 * always use incremental SSE parsing and validated encrypted blobs.
 */
export * from "./remote-compaction-core.ts";
export {
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  parseRemoteCompactionV2Events,
  readRemoteCompactionV2Stream,
  type RemoteCompactionV2Events,
} from "./remote-compaction-v2.ts";
