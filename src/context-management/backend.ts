/** Codex alpha history/notes transport. No credentials or response bodies in errors. */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, type ExtensionConfig } from "../config.ts";
import { OPERATIONS, THREAD_HINT_ENDPOINT, usesEncryptedArguments, type Json } from "./protocol.ts";

type Config = Pick<ExtensionConfig, "enabled" | "contextManagement" | "contextManagementGatewayModels" | "contextManagementGatewayBaseUrl">;
export type RemoteProvider = {
  kind: "native" | "gateway";
  baseUrl: string;
  scope: string;
  headers: Headers;
};
export const BACKEND_TIMEOUT_MS = 35_000;
const CODEX_CLIENT_VERSION = "0.153.0"; // Reference toolkit's pinned gateway contract.

export function coversModel(model: ExtensionContext["model"], cfg: Config): boolean {
  if (!cfg.enabled || cfg.contextManagement !== "remote" || !model) return false;
  if (model.provider === "openai-codex" && model.api === "openai-codex-responses") return true;
  return model.api === "openai-responses" && Boolean(cfg.contextManagementGatewayModels?.includes(`${model.provider}/${model.id}`));
}

function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Remote Context backend has no base URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Remote Context backend URL");
  }
  return url.toString().replace(/\/+$/, "");
}

export function nativeBaseUrl(raw: string): string {
  const url = new URL(cleanUrl(raw));
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/codex/responses")) url.pathname = path.slice(0, -"/responses".length);
  else if (path.endsWith("/codex")) url.pathname = path;
  else if (path.endsWith("/backend-api") || path.endsWith("/api")) url.pathname = `${path}/codex`;
  else if (!path) url.pathname = "/api/codex";
  else throw new Error("Unsupported native Codex backend URL");
  return url.toString().replace(/\/+$/, "");
}

function tokenAccount(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(claims)) return undefined;
    const auth = claims["https://api.openai.com/auth"];
    const id = claims.chatgpt_account_id ?? (isRecord(auth) ? auth.chatgpt_account_id : undefined);
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch { return undefined; }
}

function mergeHeaders(...sources: unknown[]): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") headers.set(key, value);
      else if (value === null) headers.delete(key);
    }
  }
  return headers;
}

/** Fresh auth is resolved for each operation; persisted scopes contain only a digest. */
export async function resolveProvider(ctx: ExtensionContext, cfg: Config): Promise<RemoteProvider> {
  const model = ctx.model;
  if (!coversModel(model, cfg) || !model) throw new Error("Remote Context is not enabled for this model");
  let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
  try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
  catch { throw new Error("Remote Context authentication could not be resolved"); }
  if (!auth.ok) throw new Error("Remote Context authentication could not be resolved");
  const headers = mergeHeaders(model.headers, auth.headers);
  const token = (auth.apiKey || headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Remote Context authentication is missing a key/token");
  const rawBaseUrl = cleanUrl(auth.baseUrl || model.baseUrl);
  const native = model.provider === "openai-codex" && model.api === "openai-codex-responses";
  let baseUrl: string;
  let identity: string;
  if (native) {
    const accountId = headers.get("chatgpt-account-id") || tokenAccount(token);
    if (!accountId) throw new Error("Remote Context authentication is missing a Codex account ID");
    baseUrl = nativeBaseUrl(rawBaseUrl);
    identity = accountId;
    headers.set("chatgpt-account-id", accountId);
  } else {
    // Never forward a Codex OAuth credential to an API-key gateway.
    if (tokenAccount(token)) throw new Error("Remote Context gateways require a data-plane API key, not a Codex OAuth token");
    baseUrl = cleanUrl(cfg.contextManagementGatewayBaseUrl || rawBaseUrl.replace(/\/responses$/, ""));
    if (new URL(baseUrl).origin !== new URL(rawBaseUrl).origin) throw new Error("Remote Context gateway root must have the same origin as the model");
    identity = `${model.id}:${token}`;
    headers.delete("chatgpt-account-id");
    headers.delete("x-api-key");
    headers.set("x-codex-affinity-scope", "codex-session-v1");
    headers.set("x-codex-model", model.id);
  }
  headers.delete("cookie");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("originator", "codex_cli_rs");
  const version = native ? "0.0.0" : CODEX_CLIENT_VERSION;
  headers.set("version", version);
  headers.set("user-agent", `codex_cli_rs/${version} (${process.platform}; ${process.arch})`);
  headers.set("content-type", "application/json");
  return {
    kind: native ? "native" : "gateway", baseUrl, headers,
    scope: createHash("sha256").update(JSON.stringify([model.provider, model.api, baseUrl, identity])).digest("hex"),
  };
}

export function requestHeaders(provider: RemoteProvider, sessionId: string): Headers {
  const headers = new Headers(provider.headers);
  const short = Array.from(sessionId).slice(0, 64).join("");
  headers.set("session-id", short);
  headers.set("x-client-request-id", short);
  return headers;
}

/** Deadline covers authentication as well as HTTP; rejection never exposes auth errors. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = BACKEND_TIMEOUT_MS): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (error: unknown, value?: T) => {
      if (finished) return;
      finished = true;
      combined.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(new Error(signal?.aborted ? "Remote Context request aborted" : "Remote Context backend timed out"));
    if (combined.aborted) { onAbort(); return; }
    combined.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => operation(combined)).then((value) => finish(undefined, value), (error) => finish(error));
  });
}

const RESPONSE_KEYS: Record<string, string[]> = {
  "history/list_windows": ["windows", "items", "results", "data", "output", "encrypted_output"],
  "history/list_items": ["items", "results", "data", "output", "encrypted_output"],
  "history/read_item": ["item", "content", "text", "data", "output", "encrypted_output"],
  "history/search_contents": ["matches", "items", "results", "data", "output", "encrypted_output"],
  "notes/list_files_by_prefix": ["files", "items", "results", "data", "output", "encrypted_output"],
  "notes/read_file": ["file", "content", "text", "data", "output", "encrypted_output"],
  "notes/search_contents": ["matches", "items", "results", "data", "output", "encrypted_output"],
  "notes/append_to_file": ["ok", "success", "file", "content", "data", "output", "encrypted_output"],
  "notes/write_file": ["ok", "success", "file", "content", "data", "output", "encrypted_output"],
  "notes/thread_hint": ["text", "data", "output"],
};

export function validateResponse(value: unknown, endpoint: string): Json {
  const key = endpoint.replace(/^alpha\//, "").replace("/v2/", "/");
  const expected = RESPONSE_KEYS[key];
  if (!expected || !isRecord(value) || !expected.some((k) => Object.hasOwn(value, k))) throw new Error("Invalid Remote Context backend response");
  if (value.error != null || value.ok === false || value.success === false) throw new Error("Remote Context operation was not successful");
  for (const flag of ["ok", "success"]) if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw new Error("Invalid Remote Context success flag");
  if (value.encrypted_output !== undefined && (typeof value.encrypted_output !== "string" || !value.encrypted_output)) throw new Error("Invalid encrypted Remote Context output");
  if (value.text !== undefined && typeof value.text !== "string") throw new Error("Invalid Remote Context text");
  for (const key of ["windows", "items", "results", "matches", "files"]) if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error("Invalid Remote Context list");
  if (value.images !== undefined && (!Array.isArray(value.images) || !value.images.every((image) =>
    isRecord(image) && typeof image.data === "string" && typeof image.mime_type === "string" &&
    (image.detail == null || ["auto", "high", "original"].includes(String(image.detail)))))) throw new Error("Invalid Remote Context images");
  return value;
}

export async function callBackend(
  ctx: ExtensionContext, cfg: Config, endpoint: string, args: Json,
  signal?: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<{ value: Json; provider: RemoteProvider }> {
  const allowed = endpoint === THREAD_HINT_ENDPOINT || Object.entries(OPERATIONS).some(([ns, ops]) =>
    Object.keys(ops).some((action) => endpoint === `alpha/${ns}/v2/${action}`));
  if (!allowed) throw new Error("Unsupported Remote Context endpoint");
  const sessionId = ctx.sessionManager.getSessionId();
  const model = ctx.model;
  return withDeadline(async (deadline) => {
    const provider = await resolveProvider(ctx, cfg);
    deadline.throwIfAborted();
    if (sessionId !== ctx.sessionManager.getSessionId() || model !== ctx.model) throw new Error("Remote Context session/model changed before the request");
    const headers = requestHeaders(provider, sessionId);
    headers.set("x-openai-tool-output-truncation-policy", JSON.stringify(endpoint === THREAD_HINT_ENDPOINT
      ? { mode: "bytes", limit: 4000 } : { mode: "tokens", limit: 10000 }));
    if (usesEncryptedArguments(endpoint)) headers.set("x-openai-encrypted-tool-arguments", "true");
    let response: Response;
    try {
      response = await fetcher(`${provider.baseUrl}/${endpoint}`, {
        method: "POST", redirect: "error", headers, signal: deadline,
        body: JSON.stringify({ ...args, context: { session_id: sessionId, current_agent_name: "/root" } }),
      });
    } catch { throw new Error("Remote Context backend request failed"); }
    if (!response.ok) throw new Error(`Remote Context backend returned HTTP ${response.status}`);
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch { throw new Error("Remote Context backend returned invalid JSON"); }
    return { value: validateResponse(parsed, endpoint), provider };
  }, signal);
}
