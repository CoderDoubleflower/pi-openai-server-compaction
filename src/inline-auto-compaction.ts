/**
 * Private Pi 0.84.x adapter for transparent, same-run auto-compaction.
 *
 * Portions of the host-module discovery and session-capture approach are adapted
 * from k0valik/pi-blackhole's MIT-licensed inline compaction adapter.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REGISTRY_KEY = Symbol.for(
  "pi-openai-server-compaction:inline-auto-compaction-adapter:v1",
);
const ABORT_FORWARD_INTERVAL_MS = 25;

interface TurnContextLike {
  messages: unknown[];
  [key: string]: unknown;
}

interface TurnLike {
  context: TurnContextLike;
}

interface NextTurnSnapshotLike {
  context?: TurnContextLike;
  [key: string]: unknown;
}

type PrepareNextTurn = (
  turn: TurnLike,
  signal?: AbortSignal,
) => Promise<NextTurnSnapshotLike | undefined> | NextTurnSnapshotLike | undefined;

interface AgentLike {
  state: { messages: unknown[] };
  prepareNextTurnWithContext?: PrepareNextTurn;
}

interface BranchEntryLike {
  type?: unknown;
  id?: unknown;
}

interface SessionManagerLike {
  getBranch(): BranchEntryLike[];
  buildSessionContext(): { messages: unknown[] };
}

interface PatchableSession {
  agent: AgentLike;
  sessionManager: SessionManagerLike;
  _bindExtensionCore(runner: unknown): unknown;
  _runAutoCompaction(
    reason: "overflow" | "threshold",
    willRetry: boolean,
  ): Promise<boolean>;
  abortCompaction(): void;
  _compactionAbortController?: AbortController;
  _autoCompactionAbortController?: AbortController;
}

type PatchableSessionPrototype = Pick<
  PatchableSession,
  "_bindExtensionCore" | "_runAutoCompaction" | "abortCompaction"
>;

interface PatchableSessionClass {
  prototype: PatchableSessionPrototype;
}

interface InstalledAdapter {
  status: InlineAutoCompactionAdapterStatus;
  originalRunAutoCompaction?: PatchableSession["_runAutoCompaction"];
}

interface SessionRecord {
  session: PatchableSession;
  originalRunAutoCompaction: PatchableSession["_runAutoCompaction"];
}

interface AdapterRegistry {
  installs: WeakMap<object, InstalledAdapter>;
  sessions: WeakMap<object, SessionRecord>;
  refreshInstalled: WeakSet<object>;
  refreshPending: WeakSet<object>;
  compactionInFlight: WeakSet<object>;
  hostCandidateCount: number;
  installedClassCount: number;
  capturedSessionCount: number;
}

export interface InlineAutoCompactionAdapterStatus {
  supported: boolean;
  reason?: string;
}

export interface InlineAutoCompactionInstallOptions {
  sessionClass: PatchableSessionClass;
}

export interface HostInlineAutoCompactionInstallOptions {
  entrypoint?: string;
  stack?: string;
}

export interface InlineAutoCompactionResult {
  compactionEntryId: string;
}

export type InlineAutoCompaction = (
  sessionManager: object,
  signal?: AbortSignal,
) => Promise<InlineAutoCompactionResult>;

export class InlineAutoCompactionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InlineAutoCompactionUnavailableError";
  }
}

function getRegistry(): AdapterRegistry {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = host[REGISTRY_KEY] as AdapterRegistry | undefined;
  if (existing) return existing;

  const registry: AdapterRegistry = {
    installs: new WeakMap(),
    sessions: new WeakMap(),
    refreshInstalled: new WeakSet(),
    refreshPending: new WeakSet(),
    compactionInFlight: new WeakSet(),
    hostCandidateCount: 0,
    installedClassCount: 0,
    capturedSessionCount: 0,
  };
  host[REGISTRY_KEY] = registry;
  return registry;
}

function maskNonCodeText(source: string): string {
  const masked = source.split("");
  const blank = (position: number): void => {
    if (masked[position] !== "\n" && masked[position] !== "\r") {
      masked[position] = " ";
    }
  };

  const maskQuoted = (start: number, delimiter: string): number => {
    let index = start;
    blank(index++);
    while (index < source.length) {
      const value = source[index];
      blank(index++);
      if (value === "\\" && index < source.length) {
        blank(index++);
        continue;
      }
      if (value === delimiter) break;
    }
    return index;
  };

  const maskLineComment = (start: number): number => {
    let index = start;
    blank(index++);
    blank(index++);
    while (index < source.length && source[index] !== "\n") blank(index++);
    return index;
  };

  const maskBlockComment = (start: number): number => {
    let index = start;
    blank(index++);
    blank(index++);
    while (index < source.length) {
      const value = source[index];
      const next = source[index + 1];
      blank(index++);
      if (value === "*" && next === "/") {
        blank(index++);
        break;
      }
    }
    return index;
  };

  function maskTemplateExpression(start: number): number {
    let index = start;
    let braceDepth = 1;
    while (index < source.length && braceDepth > 0) {
      const current = source[index];
      const next = source[index + 1];
      if (current === '"' || current === "'") {
        index = maskQuoted(index, current);
        continue;
      }
      if (current === "`") {
        index = maskTemplate(index);
        continue;
      }
      if (current === "/" && next === "/") {
        index = maskLineComment(index);
        continue;
      }
      if (current === "/" && next === "*") {
        index = maskBlockComment(index);
        continue;
      }
      if (current === "{") braceDepth += 1;
      if (current === "}") braceDepth -= 1;
      blank(index++);
    }
    return index;
  }

  function maskTemplate(start: number): number {
    let index = start;
    blank(index++);
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];
      if (current === "\\") {
        blank(index++);
        if (index < source.length) blank(index++);
        continue;
      }
      if (current === "`") {
        blank(index++);
        break;
      }
      if (current === "$" && next === "{") {
        blank(index++);
        blank(index++);
        index = maskTemplateExpression(index);
        continue;
      }
      blank(index++);
    }
    return index;
  }

  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'") {
      index = maskQuoted(index, current);
      continue;
    }
    if (current === "`") {
      index = maskTemplate(index);
      continue;
    }
    if (current === "/" && next === "/") {
      index = maskLineComment(index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = maskBlockComment(index);
      continue;
    }
    index += 1;
  }

  return masked.join("");
}

function countMethodInvocations(source: string, method: string): number {
  const pattern = new RegExp(`this\\.${method}\\s*\\(`, "g");
  return source.match(pattern)?.length ?? 0;
}

function detectAutoCompactionShape(
  prototype: PatchableSessionPrototype,
): string | undefined {
  if (typeof prototype._bindExtensionCore !== "function") {
    return "AgentSession._bindExtensionCore() is missing";
  }
  if (typeof prototype._runAutoCompaction !== "function") {
    return "AgentSession._runAutoCompaction() is missing";
  }
  if (typeof prototype.abortCompaction !== "function") {
    return "AgentSession.abortCompaction() is missing";
  }
  if (prototype._runAutoCompaction.length < 2) {
    return "unsupported AgentSession._runAutoCompaction() signature";
  }

  const source = maskNonCodeText(
    Function.prototype.toString.call(prototype._runAutoCompaction),
  );
  const requiredMarkers = [
    "this._autoCompactionAbortController",
    "this._extensionRunner.emit",
    "this.sessionManager.appendCompaction",
    "this.sessionManager.buildSessionContext",
    "this.agent.state.messages",
  ];
  if (requiredMarkers.some((marker) => !source.includes(marker))) {
    return "unsupported AgentSession._runAutoCompaction() shape";
  }
  if (countMethodInvocations(source, "abort") !== 0) {
    return "AgentSession._runAutoCompaction() unexpectedly aborts the active run";
  }
  return undefined;
}

function installNextTurnRefresh(
  session: PatchableSession,
  registry: AdapterRegistry,
): void {
  const agent = session.agent;
  if (registry.refreshInstalled.has(agent)) return;

  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const previousSnapshot = await previous?.call(agent, turn, signal);
    if (!registry.refreshPending.has(session)) return previousSnapshot;

    registry.refreshPending.delete(session);
    const previousContext = previousSnapshot?.context ?? turn.context;
    return {
      ...previousSnapshot,
      context: {
        ...previousContext,
        messages: session.agent.state.messages.slice(),
      },
    };
  };
  registry.refreshInstalled.add(agent);
}

function registerSession(
  session: PatchableSession,
  installed: InstalledAdapter,
  registry: AdapterRegistry,
): void {
  if (!installed.originalRunAutoCompaction) return;
  if (!session.agent || !session.agent.state || !Array.isArray(session.agent.state.messages)) {
    return;
  }
  if (
    !session.sessionManager ||
    typeof session.sessionManager !== "object" ||
    typeof session.sessionManager.getBranch !== "function" ||
    typeof session.sessionManager.buildSessionContext !== "function"
  ) {
    return;
  }
  if (typeof session.abortCompaction !== "function") return;

  if (!registry.sessions.has(session.sessionManager)) {
    registry.capturedSessionCount += 1;
  }
  registry.sessions.set(session.sessionManager, {
    session,
    originalRunAutoCompaction: installed.originalRunAutoCompaction,
  });
  installNextTurnRefresh(session, registry);
}

export function installInlineAutoCompactionAdapter(
  options: InlineAutoCompactionInstallOptions,
): InlineAutoCompactionAdapterStatus {
  const prototype = options.sessionClass.prototype;
  const registry = getRegistry();
  const existing = registry.installs.get(prototype);
  if (existing) return existing.status;

  const unsupportedReason = detectAutoCompactionShape(prototype);
  if (unsupportedReason) {
    const status = { supported: false, reason: unsupportedReason };
    registry.installs.set(prototype, { status });
    return status;
  }

  const originalRunAutoCompaction = prototype._runAutoCompaction;
  const originalBindExtensionCore = prototype._bindExtensionCore;
  const installed: InstalledAdapter = {
    status: { supported: true },
    originalRunAutoCompaction,
  };

  prototype._bindExtensionCore = function patchedBindExtensionCore(
    this: PatchableSession,
    runner: unknown,
  ): unknown {
    registerSession(this, installed, registry);
    return originalBindExtensionCore.call(this, runner);
  };

  registry.installs.set(prototype, installed);
  registry.installedClassCount += 1;
  return installed.status;
}

function findPiPackageRoot(startPath: string): string | undefined {
  let current: string;
  try {
    current = dirname(realpathSync(startPath));
  } catch {
    return undefined;
  }

  const filesystemRoot = parse(current).root;
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: string;
        };
        if (manifest.name === "@earendil-works/pi-coding-agent") return current;
      } catch {
        // Keep walking through unrelated or malformed package manifests.
      }
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  return undefined;
}

export function parseHostFramePaths(stack: string): string[] {
  const paths: string[] = [];
  for (const line of stack.split("\n")) {
    const match =
      line.match(/\((.+):\d+:\d+\)\s*$/) ?? line.match(/\bat (.+):\d+:\d+\s*$/);
    if (!match?.[1]) continue;

    const rawPath = match[1].trim();
    const normalizedPath = rawPath.replaceAll("\\", "/");
    if (!normalizedPath.includes("@earendil-works/pi-coding-agent")) continue;
    if (
      !rawPath.startsWith("file://") &&
      !rawPath.startsWith("/") &&
      !rawPath.startsWith("\\\\") &&
      !/^[A-Za-z]:[\\/]/.test(rawPath)
    ) {
      continue;
    }

    try {
      paths.push(rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath);
    } catch {
      // Ignore malformed stack locations and continue with other candidates.
    }
  }
  return paths;
}

function statusReason(prefix: string, status: InlineAutoCompactionAdapterStatus): string {
  return `${prefix}: ${status.reason ?? "unsupported"}`;
}

export async function installHostInlineAutoCompactionAdapter(
  options: HostInlineAutoCompactionInstallOptions = {},
): Promise<InlineAutoCompactionAdapterStatus> {
  const registry = getRegistry();
  const statuses: InlineAutoCompactionAdapterStatus[] = [];
  const failureReasons: string[] = [];
  const seenClasses = new Set<object>();

  const installClass = (label: string, sessionClass: unknown): void => {
    if (
      !sessionClass ||
      (typeof sessionClass !== "function" && typeof sessionClass !== "object")
    ) {
      failureReasons.push(`${label}: AgentSession export missing`);
      return;
    }
    const candidate = sessionClass as PatchableSessionClass;
    if (!candidate.prototype || seenClasses.has(candidate.prototype)) return;
    seenClasses.add(candidate.prototype);
    const status = installInlineAutoCompactionAdapter({ sessionClass: candidate });
    statuses.push(status);
    if (!status.supported) failureReasons.push(statusReason(label, status));
  };

  try {
    const localModule = (await import("@earendil-works/pi-coding-agent")) as {
      AgentSession?: unknown;
    };
    installClass("resolved peer module", localModule.AgentSession);
  } catch (error) {
    failureReasons.push(
      `resolved peer module: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const packageRoots = new Set<string>();
  const stack = options.stack ?? new Error().stack ?? "";
  for (const framePath of parseHostFramePaths(stack)) {
    const root = findPiPackageRoot(framePath);
    if (root) packageRoots.add(root);
  }
  const entrypoint = options.entrypoint ?? process.argv[1];
  if (entrypoint) {
    const root = findPiPackageRoot(entrypoint);
    if (root) packageRoots.add(root);
  }
  registry.hostCandidateCount = packageRoots.size;

  for (const packageRoot of packageRoots) {
    try {
      const hostModule = (await import(
        pathToFileURL(join(packageRoot, "dist", "index.js")).href
      )) as { AgentSession?: unknown };
      installClass(packageRoot, hostModule.AgentSession);
    } catch (error) {
      failureReasons.push(
        `${packageRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (statuses.some((status) => status.supported)) return { supported: true };
  const details = failureReasons.length > 0 ? ` (${failureReasons.join("; ")})` : "";
  return {
    supported: false,
    reason:
      "Inline auto-compaction is unavailable: no supported host AgentSession identity was found" +
      details,
  };
}

function getToolCallId(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const value = block as { type?: unknown; id?: unknown };
  return value.type === "toolCall" && typeof value.id === "string"
    ? value.id
    : undefined;
}

function hasTrailingUnpairedToolCall(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;

    const value = message as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
    };
    if (value.role !== "assistant") continue;
    if (!Array.isArray(value.content)) return false;
    if (value.stopReason === "error" || value.stopReason === "aborted") continue;

    const pending = new Set<string>();
    for (const block of value.content) {
      const id = getToolCallId(block);
      if (id) pending.add(id);
    }
    if (pending.size === 0) return false;

    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex += 1) {
      const result = messages[resultIndex];
      if (!result || typeof result !== "object") continue;
      const resultValue = result as { role?: unknown; toolCallId?: unknown };
      if (
        resultValue.role === "toolResult" &&
        typeof resultValue.toolCallId === "string"
      ) {
        pending.delete(resultValue.toolCallId);
      }
    }
    return pending.size > 0;
  }
  return false;
}

function latestCompactionEntryId(entries: BranchEntryLike[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction" && typeof entry.id === "string") {
      return entry.id;
    }
  }
  return undefined;
}

/**
 * Invoke Pi's private non-aborting auto-compaction pipeline at an awaited
 * `turn_end` boundary, then refresh the next low-level agent-loop snapshot from
 * the compacted `agent.state.messages` array.
 */
export async function compactInlineAtTurnBoundary(
  sessionManager: object,
  signal?: AbortSignal,
): Promise<InlineAutoCompactionResult> {
  const registry = getRegistry();
  const record = registry.sessions.get(sessionManager);
  if (!record) {
    throw new InlineAutoCompactionUnavailableError(
      "Inline auto-compaction is unavailable: the owning AgentSession was not captured" +
        ` (host candidates: ${registry.hostCandidateCount}; installed classes: ${registry.installedClassCount}; captured sessions: ${registry.capturedSessionCount})`,
    );
  }

  const { session, originalRunAutoCompaction } = record;
  if (
    registry.compactionInFlight.has(session) ||
    session._compactionAbortController ||
    session._autoCompactionAbortController
  ) {
    throw new Error("Compaction already in progress");
  }
  if (signal?.aborted) throw new Error("Compaction cancelled");

  const activeMessages = session.sessionManager.buildSessionContext().messages;
  if (hasTrailingUnpairedToolCall(activeMessages)) {
    throw new Error("Cannot compact inline while a tool call is still in flight");
  }

  const compactionIdBefore = latestCompactionEntryId(session.sessionManager.getBranch());
  const messagesBefore = session.agent.state.messages;
  let abortForwardTimer: ReturnType<typeof setInterval> | undefined;

  const forwardAbort = (): void => {
    session.abortCompaction();
    if (abortForwardTimer === undefined) {
      abortForwardTimer = setInterval(
        () => session.abortCompaction(),
        ABORT_FORWARD_INTERVAL_MS,
      );
      abortForwardTimer.unref?.();
    }
  };

  registry.compactionInFlight.add(session);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    await originalRunAutoCompaction.call(session, "threshold", false);

    if (session.agent.state.messages !== messagesBefore) {
      registry.refreshPending.add(session);
    }
    if (signal?.aborted) throw new Error("Compaction cancelled");

    const compactionIdAfter = latestCompactionEntryId(session.sessionManager.getBranch());
    if (!compactionIdAfter || compactionIdAfter === compactionIdBefore) {
      throw new Error(
        "Pi auto-compaction completed without appending a compaction entry",
      );
    }

    registry.refreshPending.add(session);
    return { compactionEntryId: compactionIdAfter };
  } finally {
    registry.compactionInFlight.delete(session);
    signal?.removeEventListener("abort", forwardAbort);
    if (abortForwardTimer !== undefined) clearInterval(abortForwardTimer);
  }
}
