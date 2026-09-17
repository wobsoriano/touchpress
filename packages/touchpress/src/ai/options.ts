/**
 * What `use.aiModel` accepts, spelled structurally so the main entry's
 * declarations never import from `ai`. A gateway model id such as
 * `'anthropic/claude-sonnet-5'` and a provider model instance both fit, and
 * every AI SDK language model, v2 through v4, carries these three fields.
 */
export type AiModel =
  | string
  | {
      readonly specificationVersion: string;
      readonly provider: string;
      readonly modelId: string;
    };

/**
 * What `use.evaluationModel` accepts, spelled structurally for the same reason
 * `AiModel` is. An evaluation model is its own provider spec rather than a
 * language model, so `aiModel` cannot stand in for it, and a gateway model id
 * such as `'typesafe-ai/jev-latest'` fits here the way one fits there.
 */
export type AiEvaluationModel =
  | string
  | {
      readonly specificationVersion: string;
      readonly provider: string;
      readonly modelId: string;
    };

/**
 * The keys `act`, `extract`, and `toBeJudged` add to Playwright's `use`. They are not part of
 * `core/config.ts`, because nothing under `core/` may name an AI SDK type.
 *
 * Unset is the default for both, and each fails at the first call that needs it
 * rather than at worker start, so a project that never calls one needs no model.
 */
export type AiOptions = {
  aiModel: AiModel | undefined;
  evaluationModel: AiEvaluationModel | undefined;
};
