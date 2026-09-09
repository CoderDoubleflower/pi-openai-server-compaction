/** Opt-in Codex Remote Context integration, using only Pi public extension hooks. */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isRecord, loadConfig } from "../config.ts";
import { callBackend, coversModel, requestHeaders, resolveProvider, withDeadline, type RemoteProvider } from "./backend.ts";
import { routeMessage, rewritePayload, routerSchema, validateArguments, THREAD_HINT_ENDPOINT, type Json } from "./protocol.ts";
import { WINDOW_TYPE, budgetReminder, hasCheckpoint, hasFreshUsage, latestWindow, marker, metadataFor,
  nextWindow, projectMessages, remaining, windowMessage, type WindowState } from "./window.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Active = { window: WindowState; provider: RemoteProvider; cfg: ReturnType<typeof loadConfig> };
type Pending = { window: WindowState; previous?: WindowState };

export function createContextManagementExtensionApi(
  pi: ExtensionAPI,
  clearLegacyState: (sessionId: string) => void = () => {},
): ExtensionAPI {
  const definitions: ToolDefinition[] = [];
  const owned = new Set<string>();
  const reminders = new Set<string>();
  const warned = new Set<string>();
  let pending: Pending | undefined;
  let rolling = false;
  let generation = 0;
  let previousSession: string | undefined;
  let lastRemote = false;
  let lastScope: string | undefined;

  function covered(ctx: ExtensionContext): boolean { return coversModel(ctx.model, loadConfig(ctx.cwd)); }
  function fail(ctx: ExtensionContext, error: unknown): never {
    const text = error instanceof Error ? error.message : "Remote Context failed";
    if (ctx.hasUI && !warned.has(text)) { warned.add(text); ctx.ui.notify(`Remote Context: ${text}`, "warning"); }
    ctx.abort();
    throw new Error(text);
  }
  function reset(): void { pending = undefined; rolling = false; generation++; lastScope = undefined; reminders.clear(); }

  /** Tool ownership is checked after Pi binds action methods, never during loading. */
  function syncTools(active: boolean): boolean {
    try {
      const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
      owned.clear();
      for (const expected of definitions) {
        const actual = all.get(expected.name);
        if (actual?.parameters === expected.parameters && actual.description === expected.description) owned.add(expected.name);
      }
      const valid = definitions.length === 4 && owned.size === 4;
      const current = pi.getActiveTools();
      const next = current.filter((name) => !owned.has(name));
      if (active && valid) next.push(...owned);
      if (next.length !== current.length || next.some((name, i) => name !== current[i])) pi.setActiveTools(next);
      return valid;
    } catch { return false; }
  }

  async function active(ctx: ExtensionContext): Promise<Active | undefined> {
    const cfg = loadConfig(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    if (previousSession !== sessionId) { reset(); previousSession = sessionId; }
    if (!coversModel(ctx.model, cfg)) {
      syncTools(false);
      if (lastRemote) { clearLegacyState(sessionId); reset(); }
      lastRemote = false;
      return undefined;
    }
    lastRemote = true;
    clearLegacyState(sessionId);
    if (!syncTools(true)) throw new Error("Context tools are unavailable or conflict with another extension");
    const epoch = generation;
    const model = ctx.model;
    const provider = await withDeadline(() => resolveProvider(ctx, cfg));
    if (epoch !== generation || sessionId !== ctx.sessionManager.getSessionId() || ctx.model !== model || !covered(ctx)) {
      throw new Error("Session, model or configuration changed during Remote Context authentication");
    }
    if (lastScope !== provider.scope) { pending = undefined; lastScope = provider.scope; }
    const entries = ctx.sessionManager.getBranch();
    let window = latestWindow(entries, sessionId, provider.scope);
    if (pending && pending.window.sessionId === sessionId && pending.window.scope === provider.scope) {
      if (window?.currentWindowId === pending.window.currentWindowId) pending = undefined;
      else if (!pending.previous) window = pending.window;
      // A steered rollover becomes active only after its marker is persisted.
      // Never tag the old, untrimmed input with the new window's identity.
    }
    if (!window) {
      window = nextWindow(entries, sessionId, provider.scope);
      pending = { window };
      try { pi.sendMessage(windowMessage(window), { triggerTurn: false }); }
      catch (error) { pending = undefined; throw error; }
    }
    return { window, provider, cfg };
  }

  async function requireActive(ctx: ExtensionContext): Promise<Active> {
    const result = await active(ctx);
    if (!result) throw new Error("Remote Context is not active for this model");
    return result;
  }

  function budget(ctx: ExtensionContext, window: WindowState) {
    const usage = ctx.getContextUsage();
    return remaining(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      hasFreshUsage(ctx.sessionManager.getBranch(), window) ? usage?.tokens : undefined);
  }

  function register(name: string, description: string, parameters: Json, execute: ToolDefinition["execute"], sequential = false): void {
    const definition: ToolDefinition = {
      name, label: name, description, parameters: parameters as ToolDefinition["parameters"], execute,
      ...(sequential ? { executionMode: "sequential" as const } : {}),
    };
    definitions.push(definition);
    // Some legacy smoke harnesses omit tool registration. Default-off keeps working.
    if (typeof pi.registerTool === "function") pi.registerTool(definition);
  }

  for (const namespace of ["history", "notes"] as const) {
    register(namespace,
      namespace === "history"
        ? "Search or read previous remote Codex context windows. Pass history IDs unchanged."
        : "Read and checkpoint cross-window Codex notes. Save the active request, decisions, progress and next steps before new_context. Never store credentials.",
      routerSchema(namespace), async (_id, params, signal, _update, ctx) => {
        const { window, cfg } = await requireActive(ctx);
        if (!isRecord(params)) throw new Error("Invalid Remote Context tool arguments");
        const endpoint = validateArguments(namespace, params.action, params);
        const { action: _action, ...args } = params;
        const result = await callBackend(ctx, cfg, endpoint, args, signal);
        if (result.provider.scope !== window.scope || ctx.sessionManager.getSessionId() !== window.sessionId) {
          throw new Error("Remote Context identity changed during the operation");
        }
        const { images, ...value } = result.value;
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string; detail?: "auto" | "high" | "original" }> = [
          { type: "text", text: typeof value.encrypted_output === "string" ? `${namespace} operation completed` : JSON.stringify(value) },
        ];
        if (Array.isArray(images)) for (const image of images) {
          if (isRecord(image) && typeof image.data === "string" && typeof image.mime_type === "string") {
            content.push({ type: "image", data: image.data, mimeType: image.mime_type,
              ...(["auto", "high", "original"].includes(String(image.detail)) ? { detail: image.detail as "auto" | "high" | "original" } : {}) });
          }
        }
        return { content, details: { codexHistoryNotes: value, remoteContextOrigin: {
          sessionId: window.sessionId, scope: window.scope, windowId: window.currentWindowId,
          checkpoint: namespace === "notes" && (params.action === "append_to_file" || params.action === "write_file"),
        } } };
      }, namespace === "notes");
  }

  register("get_context_remaining", "Get remaining usable tokens in the current remote Codex context window.",
    { type: "object", properties: {}, additionalProperties: false },
    async (_id, _params, _signal, _update, ctx) => {
      const { window } = await requireActive(ctx);
      const result = { ...budget(ctx, window), windowId: window.currentWindowId };
      return { content: [{ type: "text", text: result.remainingTokens === undefined
        ? "Remaining context tokens are unknown until this window receives fresh model usage."
        : `${result.remainingTokens} usable context tokens remain.` }], details: result };
    });

  register("new_context", "Start a new Codex context window without generating a conversation summary. First checkpoint active work with a successful notes append_to_file or write_file in this window.",
    { type: "object", properties: {}, additionalProperties: false },
    async (_id, _params, signal, _update, ctx) => {
      const { window, cfg } = await requireActive(ctx);
      if (rolling || pending?.previous) return { content: [{ type: "text", text: "A context-window rollover is already pending." }], details: { started: false } };
      if (!hasCheckpoint(ctx.sessionManager.getBranch(), window)) throw new Error("new_context requires a successful notes append/write checkpoint in this window; save the active request, decisions, progress and next steps, then retry");
      const epoch = generation;
      rolling = true;
      try {
        signal?.throwIfAborted();
        let hint: string | undefined;
        try {
          const result = await callBackend(ctx, cfg, THREAD_HINT_ENDPOINT, {}, signal);
          if (result.provider.scope !== window.scope) throw new Error("Remote Context identity changed");
          if (typeof result.value.text === "string" && Buffer.byteLength(result.value.text, "utf8") <= 4000) hint = result.value.text;
        } catch { signal?.throwIfAborted(); /* A saved checkpoint does not depend on optional hints. */ }
        signal?.throwIfAborted();
        const current = await requireActive(ctx);
        if (epoch !== generation || current.window.currentWindowId !== window.currentWindowId || current.window.scope !== window.scope ||
            current.window.sessionId !== window.sessionId) throw new Error("Session or context window changed during rollover");
        const next = nextWindow(ctx.sessionManager.getBranch(), window.sessionId, window.scope, window);
        pending = { window: next, previous: window };
        try { pi.sendMessage(windowMessage(next, hint), { deliverAs: "steer", triggerTurn: true }); }
        catch (error) { pending = undefined; throw error; }
        return { content: [{ type: "text", text: "A new context window is scheduled; no conversation summary carries over. Read the saved notes to resume." }], details: { started: true } };
      } finally { rolling = false; }
    }, true);

  const initialize = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    try { await active(ctx); } catch (error) { fail(ctx, error); }
  };
  pi.on("session_start", initialize);
  pi.on("before_agent_start", initialize);
  pi.on("session_tree", initialize);
  pi.on("model_select", async (event, ctx) => {
    const modelContext = new Proxy(ctx, { get(target, key, receiver) { return key === "model" ? event.model : Reflect.get(target, key, receiver); } });
    await initialize(event, modelContext);
  });
  pi.on("session_before_switch", () => reset());
  pi.on("session_before_fork", () => reset());
  pi.on("session_before_tree", () => reset());
  pi.on("session_shutdown", () => { reset(); syncTools(false); warned.clear(); });

  pi.on("context", async (event, ctx) => {
    try {
      const current = await active(ctx);
      if (!current) return { messages: projectMessages(event.messages) };
      const { window } = current;
      if (window.trimPreviousWindow && !event.messages.some((m) => marker(m, window.sessionId, window.scope)?.id === window.id)) {
        throw new Error("Current context-window boundary is missing from the model context; refusing an inconsistent replay");
      }
      const notice = budgetReminder(ctx.sessionManager.getBranch(), window, current.cfg.contextReminderThresholdPercent, budget(ctx, window));
      if (notice) {
        const key = `${notice.currentWindowId}:${notice.kind}`;
        if (!reminders.has(key)) {
          reminders.add(key);
          pi.sendMessage({ customType: WINDOW_TYPE, display: true, details: { remoteContext: notice }, content:
            notice.kind === "fallback" ? "Context budget exhausted. Make one notes checkpoint call, then call new_context before continuing."
              : "Context budget is low. Checkpoint the active request, state and next steps in notes, then call new_context." },
            notice.kind === "fallback" ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: false });
        }
      }
      return { messages: projectMessages(event.messages, window) };
    } catch (error) { return fail(ctx, error); }
  });

  pi.on("before_provider_headers", async (event, ctx) => {
    if (!covered(ctx)) return;
    try {
      const { window, provider } = await requireActive(ctx);
      if (provider.kind === "gateway") {
        const headers = requestHeaders(provider, window.sessionId);
        const replace = ["authorization", "originator", "version", "user-agent", "session-id", "x-client-request-id", "x-codex-affinity-scope", "x-codex-model"];
        for (const name of Object.keys(event.headers)) {
          if ([...replace, "cookie", "chatgpt-account-id", "x-api-key"].includes(name.toLowerCase())) delete event.headers[name];
        }
        for (const name of replace) { const value = headers.get(name); if (value) event.headers[name] = value; }
      }
      const metadata = metadataFor(window);
      for (const name of Object.keys(event.headers)) if (["x-codex-window-id", "x-codex-turn-metadata"].includes(name.toLowerCase())) delete event.headers[name];
      event.headers["x-codex-window-id"] = String(metadata.window_id);
      event.headers["x-codex-turn-metadata"] = JSON.stringify(metadata);
    } catch (error) { fail(ctx, error); }
  });

  // This proxy wraps the FINAL provider-agnostic hooks, not just index-core's
  // inner callbacks. No legacy replay, remote-v2 request, or local summary may
  // run for a covered model, including on authentication/tool-ownership errors.
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "on") return (name: string, original: Handler) => {
        const wrapped: Handler = async (event, ctx) => {
          if (!covered(ctx)) return original(event, ctx);
          if (name === "session_before_compact") return { cancel: true };
          if (name === "before_provider_request") {
            try { const { window } = await requireActive(ctx); return rewritePayload(event.payload, metadataFor(window)); }
            catch (error) { return fail(ctx, error); }
          }
          if (name === "message_end") {
            if (!syncTools(true)) return undefined;
            const message = routeMessage(event.message);
            return message === event.message ? undefined : { message };
          }
          return original(event, ctx);
        };
        return (pi.on as unknown as (name: string, handler: Handler) => unknown)(name, wrapped);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
