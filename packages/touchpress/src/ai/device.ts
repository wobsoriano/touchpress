import type { Device } from '../core/device.ts';
import { TouchpressError } from '../core/errors.ts';
import type { ActionSink } from '../core/report.ts';
import { renderScreen, type Platform, type Screen } from '../core/screen.ts';
import type { DeviceSession } from '../core/session.ts';
import { runAct, runExtract } from './act.ts';
import type { AiEvaluationModel, AiModel } from './options.ts';
import { createDeviceTools } from './tools.ts';

const DEFAULT_ACT_TIMEOUT_MS = 120_000;
const DEFAULT_ACT_STEPS = 25;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;

/** A loop can run for minutes, so its budget is its own rather than the action timeout a deterministic step takes. */
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

type JsonValue =
  | null
  | string
  | number
  | boolean
  | { readonly [key: string]: JsonValue | undefined }
  | readonly JsonValue[];

/** Prose, or any JSON an evaluation model should read. Spelled structurally, the way `ExtractSchema` is. */
export type JudgmentInput =
  | string
  | { readonly [key: string]: JsonValue | undefined }
  | readonly JsonValue[];

/**
 * A yes or no about the screen, with the chance it must reach. It is the AI
 * SDK's boolean question plus the two bounds, and `type` is optional because a
 * judgment without one can only be this. With neither bound it passes at 0.8.
 */
export type ChanceJudgment = {
  readonly type?: 'boolean';
  readonly instructions: JudgmentInput;
  /** What each answer looks like on this screen, for a statement the screen only implies. */
  readonly criteria?: {
    readonly true?: JudgmentInput | null;
    readonly false?: JudgmentInput | null;
  };
  /** The lowest chance that passes, 0 to 1. */
  readonly min?: number;
  /** The highest chance that passes, 0 to 1. This is how a judgment says the statement must be false. */
  readonly max?: number;
};

/** One of a fixed set, with the option the model must pick. It is the AI SDK's choice question plus `is`. */
export type ChoiceJudgment = {
  readonly type: 'choice';
  readonly instructions: JudgmentInput;
  /** Option names to descriptions. Null describes an option by its name alone. */
  readonly criteria: Readonly<Record<string, JudgmentInput | null>>;
  /** The option that passes. Checked against `criteria` before any model is asked. */
  readonly is: string;
  /** The lowest chance the picked option must carry, when the provider reports one. */
  readonly min?: number;
};

/** A bare string is a `ChanceJudgment` of that statement at the default bound. */
export type Judgment = string | ChanceJudgment | ChoiceJudgment;

/**
 * What `toBeJudged` takes. One statement, or named judgments the model answers
 * together from a single capture, so several cost the latency of one.
 */
export type Judgments = string | Readonly<Record<string, Judgment>>;

export type AiDevice = {
  /**
   * Drives the app with a model until the instruction is satisfied. Resolves
   * with the model's summary of what it did, and throws when the model reports
   * it could not proceed or runs out of steps.
   */
  act(instruction: string, options?: ActOptions): Promise<string>;
  /** Asks a model one question about the current screen and validates the answer against `schema`. */
  extract<T>(question: string, schema: ExtractSchema<T>, options?: ExtractOptions): Promise<T>;
};

/**
 * What `expect(device).toBeJudged` reaches for. The judged assertion is a
 * matcher and nothing on the device, so the evaluation model, the sink, and a
 * queue-safe capture travel on this handle instead of on the public type.
 */
export type AiInternals = {
  readonly model: AiEvaluationModel | undefined;
  readonly sink: ActionSink;
  readonly platform: Platform;
  /** One capture, taken on the session queue. */
  screen(): Promise<Screen>;
  /** Numbers each judged assertion's attachment, the way `device.screenshot` numbers its files. */
  nextJudged(): number;
};

/** A symbol rather than a key, so the handle stays off the public type and out of anything that enumerates a device. */
const aiInternals = Symbol('touchpress.ai');

/** The handle `withAi` attached, or undefined for a device that never went through it. */
export function internalsOf(device: Device): AiInternals | undefined {
  const held: unknown = Reflect.get(device, aiInternals);
  return held === undefined ? undefined : (held as AiInternals);
}

/**
 * Adds `act` and `extract` to a device without touching what is already there,
 * and attaches the handle `toBeJudged` reads.
 *
 * Both run inside `session.run`, so the whole loop holds the session queue.
 * A test body is sequential anyway, and the model's snapshot refs carry the same
 * rule every deterministic action does: they are valid for the next command
 * only, so nothing else may reach the device in between.
 */
export function withAi(
  device: Device,
  session: DeviceSession,
  sink: ActionSink,
  model: AiModel | undefined,
  evaluationModel: AiEvaluationModel | undefined,
): Device & AiDevice {
  let acts = 0;
  let judged = 0;
  let built: ReturnType<typeof createDeviceTools> | null = null;
  const tools = (): ReturnType<typeof createDeviceTools> =>
    (built ??= createDeviceTools(session.name, session.options.platform));

  // Typed with the handle here and returned without it, so the literal is checked and the public type stays clean.
  const withHandle: Device & AiDevice & { readonly [aiInternals]: AiInternals } = {
    ...device,
    [aiInternals]: {
      model: evaluationModel,
      sink,
      platform: session.options.platform,
      screen: () => session.run((one) => one.capture()),
      nextJudged: () => (judged += 1),
    },
    act: async (instruction, options) => {
      const configured = configuredModel(model);
      const deviceTools = await tools();
      return session.run((one) =>
        runAct({
          model: configured,
          tools: deviceTools,
          sink,
          instruction,
          platform: session.options.platform,
          maxSteps: options?.maxSteps ?? DEFAULT_ACT_STEPS,
          timeout: options?.timeout ?? DEFAULT_ACT_TIMEOUT_MS,
          screen: async () => renderScreen(await one.capture()),
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
  return withHandle;
}

/** Checked before the queue, so a project that forgot the key fails at once rather than holding the session. */
function configuredModel(model: AiModel | undefined): AiModel {
  if (model === undefined) throw new TouchpressError({ kind: 'ai-not-configured' });
  return model;
}
