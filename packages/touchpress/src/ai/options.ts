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
 * `AiModel` is. An evaluation model answers typed questions rather than writing
 * text, so it is its own provider spec and `aiModel` cannot stand in for it. A
 * provider instance such as `typeSafeAi.evaluationModel('jev-latest')` fits, and
 * so does a gateway model id such as `'typesafe-ai/jev-latest'`.
 */
export type AiEvaluationModel =
  | string
  | {
      readonly specificationVersion: string;
      readonly provider: string;
      readonly modelId: string;
    };

/**
 * The keys `act` and `extract` add to Playwright's `use`. They are not part of
 * `core/config.ts`, because nothing under `core/` may name an AI SDK type.
 *
 * `aiModel` is a language model. It drives `act` and answers `extract`.
 * `evaluationModel` is a decision model. When set, it drives `act` instead,
 * picking each move from the ones the screen offers. Both are unset by default,
 * and each fails at the first call that needs it rather than at worker start,
 * so a project that never calls one needs no model.
 */
export type AiOptions = {
  aiModel: AiModel | undefined;
  /** `null` turns the config's evaluation model off for one file or test, which `undefined` in `test.use` cannot do. */
  evaluationModel: AiEvaluationModel | null | undefined;
};
