/**
 * Configuration loading for the extension.
 *
 * Reads global/project JSON config files plus environment overrides and exposes
 * a normalized, fully-populated runtime config object.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export type CompactionReasoningEffort =
  | "inherit"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ExtensionConfig = {
  enabled?: boolean;
  includeAzure?: boolean;
  compactThreshold?: number;
  thresholdRatio?: number;
  notify?: boolean;
  usePreviousResponseId?: boolean;
  /** `current` or a Pi model reference in `provider/model-id` form. */
  model?: string;
  /** Remote compaction reasoning effort. `inherit` mirrors the active request. */
  reasoningEffort?: CompactionReasoningEffort;
  /** Experimental Codex window lifecycle; NOT Responses context_management. */
  contextManagement?: "off" | "remote";
  /** Percentage of usable context remaining that triggers a checkpoint reminder. */
  contextReminderThresholdPercent?: number;
  /** Exact provider/model references whose gateway implements Codex alpha APIs. */
  contextManagementGatewayModels?: string[];
  /** Optional same-origin backend root; defaults to the gateway's resolved baseUrl. */
  contextManagementGatewayBaseUrl?: string;
};

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toCompactionReasoningEffort(value: unknown): CompactionReasoningEffort | undefined {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (
    normalized === "inherit" ||
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
}

function contextMode(value: unknown): "off" | "remote" | undefined {
  return value === "off" || value === "remote" ? value : undefined;
}

function percentage(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

function modelReferences(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    try { value = value.trim().startsWith("[") ? JSON.parse(value) : value.split(","); }
    catch { return undefined; }
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return [...new Set(value.map((v: string) => v.trim()).filter((v) => /^[^/\s]+\/.+/.test(v)))];
}

export function loadConfig(cwd: string): Required<ExtensionConfig> {
  const globalPath = join(homedir(), ".pi", "agent", "openai-server-compaction.json");
  const projectPath = join(cwd, ".pi", "openai-server-compaction.json");
  const globalCfg = readJsonFile(globalPath) ?? {};
  const projectCfg = readJsonFile(projectPath) ?? {};
  const merged = { ...globalCfg, ...projectCfg };

  return {
    enabled:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED) ??
      toBoolean(merged.enabled) ??
      true,
    includeAzure:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_AZURE) ??
      toBoolean(merged.includeAzure) ??
      false,
    compactThreshold:
      toPositiveNumber(process.env.PI_OPENAI_SERVER_COMPACTION_THRESHOLD) ??
      toPositiveNumber(merged.compactThreshold) ??
      0,
    thresholdRatio:
      toPositiveNumber(process.env.PI_OPENAI_SERVER_COMPACTION_RATIO) ??
      toPositiveNumber(merged.thresholdRatio) ??
      0.7,
    notify:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_NOTIFY) ??
      toBoolean(merged.notify) ??
      false,
    usePreviousResponseId:
      toBoolean(process.env.PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID) ??
      toBoolean(merged.usePreviousResponseId) ??
      true,
    model:
      toNonEmptyString(process.env.PI_OPENAI_SERVER_COMPACTION_MODEL) ??
      toNonEmptyString(merged.model) ??
      "current",
    reasoningEffort:
      toCompactionReasoningEffort(process.env.PI_OPENAI_SERVER_COMPACTION_REASONING_EFFORT) ??
      toCompactionReasoningEffort(merged.reasoningEffort) ??
      "inherit",
    contextManagement:
      contextMode(process.env.PI_OPENAI_SERVER_COMPACTION_CONTEXT_MANAGEMENT) ??
      contextMode(merged.contextManagement) ?? "off",
    contextReminderThresholdPercent:
      percentage(process.env.PI_OPENAI_SERVER_COMPACTION_CONTEXT_REMINDER_PERCENT) ??
      percentage(merged.contextReminderThresholdPercent) ?? 10,
    contextManagementGatewayModels:
      modelReferences(process.env.PI_OPENAI_SERVER_COMPACTION_CONTEXT_GATEWAY_MODELS) ??
      modelReferences(merged.contextManagementGatewayModels) ?? [],
    contextManagementGatewayBaseUrl:
      toNonEmptyString(process.env.PI_OPENAI_SERVER_COMPACTION_CONTEXT_GATEWAY_BASE_URL) ??
      toNonEmptyString(merged.contextManagementGatewayBaseUrl) ?? "",
  };
}

export function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toPositiveNumber(value);
  return numeric ? Math.floor(numeric) : undefined;
}
