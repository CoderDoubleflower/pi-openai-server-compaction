import type { Model } from "@earendil-works/pi-ai";
import { modelKey } from "./openai.ts";

export type CompactionModelLookup = (
  provider: string,
  modelId: string,
) => Model<any> | undefined;

export interface CompactionModelResolution {
  models: Model<any>[];
  warnings: string[];
}

export interface CompactionModelFailure {
  model: Model<any>;
  error: unknown;
  index: number;
}

export type CompactionModelFallbackResult<T> =
  | {
      success: true;
      model: Model<any>;
      value: T;
      failures: CompactionModelFailure[];
    }
  | {
      success: false;
      failures: CompactionModelFailure[];
    };

export function modelReference(model: {
  provider?: unknown;
  id?: unknown;
}): string {
  return `${String(model.provider)}/${String(model.id)}`;
}

function pushUniqueModel(models: Model<any>[], model: Model<any>): void {
  const key = modelKey(model);
  if (models.some((candidate) => modelKey(candidate) === key)) return;
  models.push(model);
}

/**
 * Resolve the configured compaction model without pre-screening provider or API
 * identity. The explicitly configured provider/model is attempted first; the
 * current session model is always retained as the fallback candidate.
 */
export function resolveCompactionModelCandidates(params: {
  configuredModel: string;
  currentModel: Model<any>;
  find: CompactionModelLookup;
}): CompactionModelResolution {
  const models: Model<any>[] = [];
  const warnings: string[] = [];
  const configured = params.configuredModel.trim();

  if (configured && configured.toLowerCase() !== "current") {
    const slashIndex = configured.indexOf("/");
    if (slashIndex <= 0 || slashIndex === configured.length - 1) {
      warnings.push(
        `Invalid compaction model "${configured}"; expected "provider/model-id". Using the current model.`,
      );
    } else {
      const provider = configured.slice(0, slashIndex);
      const modelId = configured.slice(slashIndex + 1);
      const selected = params.find(provider, modelId);
      if (selected) {
        pushUniqueModel(models, selected);
      } else {
        warnings.push(
          `Configured compaction model "${configured}" was not found. Using the current model.`,
        );
      }
    }
  }

  pushUniqueModel(models, params.currentModel);
  return { models, warnings };
}

/**
 * Try models in order and continue with the next candidate after an operational
 * failure. Callers decide whether cancellation or another condition should stop
 * the fallback chain.
 */
export async function tryCompactionModels<T>(params: {
  models: Model<any>[];
  attempt(model: Model<any>, index: number): Promise<T>;
  shouldContinue?(failure: CompactionModelFailure): boolean;
  onFailure?(
    failure: CompactionModelFailure,
    nextModel: Model<any> | undefined,
  ): void;
}): Promise<CompactionModelFallbackResult<T>> {
  const failures: CompactionModelFailure[] = [];

  for (let index = 0; index < params.models.length; index += 1) {
    const model = params.models[index];
    try {
      const value = await params.attempt(model, index);
      return { success: true, model, value, failures };
    } catch (error) {
      const failure = { model, error, index };
      failures.push(failure);
      const nextModel = params.models[index + 1];
      params.onFailure?.(failure, nextModel);
      if (!nextModel || params.shouldContinue?.(failure) === false) break;
    }
  }

  return { success: false, failures };
}
