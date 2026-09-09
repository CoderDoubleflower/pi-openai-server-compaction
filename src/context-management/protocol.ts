/** Codex Remote Context wire contract, adapted from pi-openai-toolkit (MIT).
 * See docs/CONTEXT-MANAGEMENT-NOTICE.md for the pinned reference and license.
 * Keep namespace schemas compatible with Codex's reserved schema serializer.
 */
import { isRecord } from "../config.ts";

export type Namespace = "history" | "notes";
export type Json = Record<string, unknown>;
export const ENCRYPTED_OUTPUT_MARKER = "\u0000pi-openai-server-compaction:encrypted-output:";
export const THREAD_HINT_ENDPOINT = "alpha/notes/v2/thread_hint";
export const TOOL_NAMES = ["new_context", "get_context_remaining", "history", "notes"] as const;

const str = (description?: string, encrypted = false): Json => ({
  type: "string", ...(description ? { description } : {}), ...(encrypted ? { encrypted: true } : {}),
});
const nullable = (type: string): Json => ({ anyOf: [{ type }, { type: "null" }] });
const integer = (): Json => ({ type: "integer" });
const bool = (): Json => ({ type: "boolean" });
const enumeration = (values: string[]): Json => ({ type: "string", enum: values });
const role = (): Json => ({ anyOf: [enumeration(["user", "assistant", "tool", "system", "developer"]), { type: "null" }] });

type Operation = { description: string; properties: Record<string, Json>; required?: string[] };
export const OPERATIONS: Record<Namespace, Record<string, Operation>> = {
  history: {
    list_windows: { description: "List context windows", properties: {
      agent_name: nullable("string"), limit: integer(), recent_first: bool(),
    } },
    list_items: { description: "List history items", properties: {
      agent_name: nullable("string"), limit: integer(), max_chars_per_item: integer(),
      recent_first: bool(), role: role(), tool_name: nullable("string"),
      tool_namespace: nullable("string"), window_id: nullable("string"),
    } },
    read_item: { description: "Read history item range", properties: {
      agent_name: nullable("string"), item_id: str("Suffix from the item's [id: …] marker."),
      limit_chars: integer(), offset_chars: integer(), window_id: str(),
    }, required: ["item_id", "window_id"] },
    search_contents: { description: "Search history", properties: {
      agent_name: nullable("string"), limit: integer(), query: str("Case-sensitive", true),
      recent_first: bool(), role: role(), tool_name: nullable("string"),
      tool_namespace: nullable("string"), window_id: nullable("string"),
    }, required: ["query"] },
  },
  notes: {
    list_files_by_prefix: { description: "List note files", properties: {
      file_order: enumeration(["ascending", "descending"]),
      file_order_by: enumeration(["name", "created_at", "updated_at"]),
      max_results: integer(), prefix: nullable("string"),
    } },
    read_file: { description: "Read note file; line bounds inclusive, 1-based, negative from end", properties: {
      path: str(), start_line: nullable("integer"), stop_line: nullable("integer"),
    }, required: ["path"] },
    search_contents: { description: "Search note lines by literal substring", properties: {
      max_files: integer(), max_matches_per_file: integer(), path_prefix: nullable("string"),
      query: str("Case-sensitive", true), recent_file_first: bool(),
    }, required: ["query"] },
    append_to_file: { description: "Append text exactly", properties: {
      path: str(), text: str(undefined, true),
    }, required: ["text", "path"] },
    write_file: { description: "Create or replace a note file", properties: {
      path: str(), text: str(undefined, true),
    }, required: ["text", "path"] },
  },
};

export function namespaceSchema(name: Namespace): Json {
  return {
    type: "namespace", name,
    description: name === "history" ? "Prior-window detail. Pass IDs unchanged. Search, never browse." : "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].",
    tools: Object.entries(OPERATIONS[name]).map(([action, op]) => ({
      type: "function", name: action, description: op.description, strict: false,
      // Intentionally no additionalProperties or numeric bounds: reserved Codex contract.
      parameters: { type: "object", properties: structuredClone(op.properties),
        ...(op.required ? { required: [...op.required] } : {}) },
    })),
  };
}

/** Pi sees a local router; the provider receives the reserved namespace instead. */
export function routerSchema(name: Namespace): Json {
  const properties: Record<string, Json> = { action: enumeration(Object.keys(OPERATIONS[name])) };
  for (const op of Object.values(OPERATIONS[name])) {
    for (const [key, value] of Object.entries(op.properties)) {
      properties[key] = { ...value };
      delete properties[key].encrypted;
    }
  }
  return { type: "object", properties, required: ["action"], additionalProperties: false };
}

export function validNamespace(value: unknown): value is Namespace {
  return value === "history" || value === "notes";
}

export function operationFor(namespace: Namespace, action: unknown): Operation | undefined {
  return typeof action === "string" && Object.hasOwn(OPERATIONS[namespace], action)
    ? OPERATIONS[namespace][action] : undefined;
}

export function validateArguments(namespace: Namespace, action: unknown, params: Json): string {
  const op = operationFor(namespace, action);
  if (!op || typeof action !== "string") throw new Error(`Unsupported ${namespace} action`);
  for (const key of Object.keys(params)) {
    if (key !== "action" && !Object.hasOwn(op.properties, key)) throw new Error(`Unexpected ${namespace} argument: ${key}`);
  }
  for (const key of op.required ?? []) {
    if (typeof params[key] !== "string" || (key !== "text" && !params[key])) throw new Error(`${namespace}.${action} requires ${key}`);
  }
  return `alpha/${namespace}/v2/${action}`;
}

export function usesEncryptedArguments(endpoint: string): boolean {
  return endpoint.endsWith("/search_contents") || endpoint.endsWith("/append_to_file") || endpoint.endsWith("/write_file");
}

export function encodeEncryptedOutput(encrypted: string): string {
  if (!encrypted) throw new Error("Empty encrypted history/notes output");
  return ENCRYPTED_OUTPUT_MARKER + JSON.stringify(encrypted);
}

function encryptedPart(text: string): Json | undefined {
  if (!text.startsWith(ENCRYPTED_OUTPUT_MARKER)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(ENCRYPTED_OUTPUT_MARKER.length)); }
  catch { throw new Error("Malformed encrypted history/notes output"); }
  if (typeof parsed !== "string" || !parsed) throw new Error("Malformed encrypted history/notes output");
  return { type: "encrypted_content", encrypted_content: parsed };
}

/** Reverse local routing on replay and convert opaque output markers to native content. */
export function rewriteInput(input: unknown[]): unknown[] {
  return input.map((item) => {
    if (!isRecord(item)) return item;
    if (item.type === "function_call" && validNamespace(item.namespace) && item.name === item.namespace) {
      if (typeof item.arguments !== "string") throw new Error("Malformed remote context tool arguments");
      const args: unknown = JSON.parse(item.arguments);
      if (!isRecord(args) || !operationFor(item.namespace, args.action)) throw new Error("Invalid remote context action on replay");
      const { action, ...rest } = args;
      return { ...item, name: action, arguments: JSON.stringify(rest) };
    }
    if (item.type !== "function_call_output") return item;
    if (typeof item.output === "string") {
      const part = encryptedPart(item.output);
      return part ? { ...item, output: [part] } : item;
    }
    if (!Array.isArray(item.output)) return item;
    return { ...item, output: item.output.map((part) =>
      isRecord(part) && part.type === "input_text" && typeof part.text === "string"
        ? encryptedPart(part.text) ?? part : part) };
  });
}

/** Pure conversion. message_end returns this before Pi resolves tools by name. */
export function routeMessage<T>(message: T): T {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
  const content = message.content.map((call) => {
    if (!isRecord(call) || call.type !== "toolCall" || !validNamespace(call.namespace) || !operationFor(call.namespace, call.name)) return call;
    if (!isRecord(call.arguments)) throw new Error("Invalid remote context tool arguments");
    // Wire action wins, never an injected action inside model arguments.
    return { ...call, name: call.namespace, arguments: { ...call.arguments, action: call.name } };
  });
  return { ...message, content } as T;
}

/** Opaque data stays in tool-result details locally, not in the terminal output. */
export function projectToolResult<T>(message: T, remote: boolean): T {
  if (!remote || !isRecord(message) || message.role !== "toolResult" || message.isError === true) return message;
  const details = message.details;
  if (!isRecord(details) || !isRecord(details.codexHistoryNotes)) return message;
  const encrypted = details.codexHistoryNotes.encrypted_output;
  if (encrypted === undefined) return message;
  if (typeof encrypted !== "string" || !encrypted) throw new Error("Malformed stored encrypted tool output");
  const images = Array.isArray(message.content) ? message.content.filter((p) => isRecord(p) && p.type === "image") : [];
  return { ...message, content: [{ type: "text", text: encodeEncryptedOutput(encrypted) }, ...images] } as T;
}

export function rewritePayload(payload: unknown, metadata: Json): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input) || typeof payload.model !== "string") throw new Error("Remote Context requires a Responses payload");
  if (payload.client_metadata !== undefined && !isRecord(payload.client_metadata)) throw new Error("Invalid client_metadata");
  const client = (payload.client_metadata ?? {}) as Json;
  let existing: unknown = {};
  if (client["x-codex-turn-metadata"] !== undefined) {
    if (typeof client["x-codex-turn-metadata"] !== "string") throw new Error("Invalid turn metadata");
    existing = JSON.parse(client["x-codex-turn-metadata"] as string);
    if (!isRecord(existing)) throw new Error("Invalid turn metadata");
  }
  const rewriteTools = (tools: unknown[]) => tools.map((tool) =>
    isRecord(tool) && (tool.type === "function" || tool.type === "namespace") && validNamespace(tool.name)
      ? namespaceSchema(tool.name) : tool);
  const rewritten: Json = {
    ...payload,
    client_metadata: { ...client, "x-codex-window-id": metadata.window_id,
      "x-codex-turn-metadata": JSON.stringify({ ...(existing as Json), ...metadata }) },
    input: rewriteInput(payload.input).map((item) =>
      isRecord(item) && Array.isArray(item.tools) ? { ...item, tools: rewriteTools(item.tools) } : item),
    ...(Array.isArray(payload.tools) ? { tools: rewriteTools(payload.tools) } : {}),
  };
  // Window management owns continuity; don't combine it with stored-response or compaction chains.
  delete rewritten.previous_response_id;
  delete rewritten.context_management;
  return rewritten;
}
