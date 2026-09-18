import type { Device } from '../core/device.ts';
import { TouchpressError } from '../core/errors.ts';
import type { ActionSink } from '../core/report.ts';
import { renderScreen } from '../core/screen.ts';
import type { DeviceSession } from '../core/session.ts';
import { runDecideAct } from './decide.ts';
import { runExtract } from './extract.ts';
import type { AiEvaluationModel, AiModel } from './options.ts';

const DEFAULT_ACT_TIMEOUT_MS = 120_000;
const DEFAULT_ACT_STEPS = 25;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;

/**
 * A loop can run for minutes, so its budget is its own rather than the action
 * timeout a deterministic step takes. `maxSteps` counts model turns on the
 * language-model loop and moves on the evaluation-model loop.
 */
export type ActOptions = { timeout?: number; maxSteps?: number };
export type ExtractOptions = { timeout?: number };

/**
 * What `extract` accepts, spelled structurally so the main entry's declarations
 * never import from `ai`. The first branch is a Standard Schema, which Zod
 * 3.25+, Zod 4, and Valibot implement, with `T` read off its output type. The
 * second is the AI SDK's own `Schema`, which `jsonSchema()` returns.
 */
export type ExtractSchema<T> =
  | {
      readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: { readonly output: T };
      };
    }
  | { readonly jsonSchema: unknown; readonly _type?: T };

/**
 * Which model answers the choice question, and through which SDK call. An
 * evaluation model answers with a calibrated distribution and never writes
 * text. A language model answers with structured output and may also write the
 * text a fill types, which is the one move only it is offered.
 */
export type Driver =
  | { readonly kind: 'evaluation'; readonly model: AiEvaluationModel }
  | { readonly kind: 'language'; readonly model: AiModel };

export type AiDevice = {
  /**
   * Drives the app with a model until the instruction is satisfied. Resolves
   * with the model's summary of what it did, and throws when the model reports
   * it could not proceed or runs out of steps.
   *
   * Either model drives the same loop. Each step offers every move the screen
   * has and the model picks one, ending the run with a verdict, so a task that
   * says "verify" is judged as well as carried out. An evaluation model in
   * `use.evaluationModel` types only what the instruction puts in double quotes.
   * A language model in `use.aiModel` may also write the text it types.
   */
  act(instruction: string, options?: ActOptions): Promise<string>;
  /** Asks a model one question about the current screen and validates the answer against `schema`. */
  extract<T>(question: string, schema: ExtractSchema<T>, options?: ExtractOptions): Promise<T>;
};

/**
 * Adds `act` and `extract` to a device without touching what is already there.
 *
 * Both run inside `session.run`, so the whole loop holds the session queue. A
 * test body is sequential anyway, and the model's snapshot refs carry the same
 * rule every deterministic action does: they are valid for the next command
 * only, so nothing else may reach the device in between.
 */
export function withAi(
  device: Device,
  session: DeviceSession,
  sink: ActionSink,
  model: AiModel | undefined,
  evaluationModel: AiEvaluationModel | null | undefined,
): Device & AiDevice {
  let acts = 0;

  return {
    ...device,
    act: async (instruction, options) => {
      const driver = driverFor(model, evaluationModel);
      return session.run((one) =>
        runDecideAct({
          driver,
          device: one,
          sink,
          instruction,
          platform: session.options.platform,
          maxSteps: options?.maxSteps ?? DEFAULT_ACT_STEPS,
          timeout: options?.timeout ?? DEFAULT_ACT_TIMEOUT_MS,
          actionTimeout: session.options.actionTimeout,
          attempt: (acts += 1),
        }),
      );
    },
    extract: async (question, schema, options) => {
      const configured = configuredModel(model);
      return session.run(async (one) =>
        runExtract({
          model: configured,
          screen: renderScreen(await one.capture()),
          question,
          schema,
          sink,
          timeout: options?.timeout ?? DEFAULT_EXTRACT_TIMEOUT_MS,
        }),
      );
    },
  };
}

/** The evaluation model drives when both are set. It is the faster and cheaper of the two, and `extract` still has the language model. */
function driverFor(
  model: AiModel | undefined,
  evaluationModel: AiEvaluationModel | null | undefined,
): Driver {
  if (evaluationModel !== undefined && evaluationModel !== null) {
    return { kind: 'evaluation', model: evaluationModel };
  }
  return { kind: 'language', model: configuredModel(model) };
}

/** Checked before the queue, so a project that forgot the key fails at once rather than holding the session. */
function configuredModel(model: AiModel | undefined): AiModel {
  if (model === undefined) throw new TouchpressError({ kind: 'ai-not-configured' });
  return model;
}
