import type {
  Experimental_EvaluationModel,
  Experimental_EvaluationQuestion,
  Experimental_EvaluationResult,
} from 'ai';
import { TouchpressError } from '../core/errors.ts';
import { renderScreen, type Platform, type Screen, type ScreenNode } from '../core/screen.ts';
import { sleep } from '../core/session.ts';
import { timedOut } from './act.ts';
import type { ChanceJudgment, ChoiceJudgment, Judgment, Judgments } from './device.ts';
import type { AiEvaluationModel } from './options.ts';
import type { JudgedOutcome, JudgedUsage, Verdict } from './verdict.ts';
import { loadAi } from './tools.ts';

/** A poll is a capture plus a model call, so the wait between two is short rather than absent. */
const POLL_INTERVAL_MS = 500;

/** High enough that a model hedging between two readings of the screen fails rather than passes. */
const DEFAULT_MIN_CHANCE = 0.8;

/** The id a lone statement is asked under. A record names its own. */
const LONE = 'judged';

type SdkQuestions = Record<string, Experimental_EvaluationQuestion>;
type SdkResult = Experimental_EvaluationResult<SdkQuestions>;
type SdkAnswer = SdkResult['answers'][string];

type SdkEvaluate = (call: {
  model: Experimental_EvaluationModel;
  state: ScreenState;
  questions: SdkQuestions;
  abortSignal?: AbortSignal;
}) => Promise<SdkResult>;

/**
 * What one judgment expects of its answer. The two kinds are the two question
 * types a judgment can be, so reading a verdict is one switch rather than a
 * check of which optional keys the author happened to set.
 */
type Expectation =
  | { readonly kind: 'chance'; readonly min: number | null; readonly max: number | null }
  | { readonly kind: 'choice'; readonly is: string; readonly min: number | null };

/** One judgment after parsing. `question` is what the SDK is handed, with the touchpress keys gone. */
export type Asked = {
  readonly id: string;
  /** Null for a lone statement, whose report lines need no name in front. */
  readonly label: string | null;
  readonly instructions: string;
  readonly question: Experimental_EvaluationQuestion;
  readonly expectation: Expectation;
};

export type JudgedRun = {
  readonly model: AiEvaluationModel;
  readonly asked: readonly Asked[];
  readonly timeout: number;
  readonly platform: Platform;
  /** Called once per poll, so a statement the app makes true a second later still passes. */
  readonly screen: () => Promise<Screen>;
};

/**
 * The one place a judgment's shape is checked. A schema the SDK validates says
 * nothing about `min`, `max`, or `is`, and a typo in `is` would otherwise poll
 * out its whole budget before failing on an option that never existed.
 */
export function parseJudgments(judgments: Judgments): Asked[] {
  if (typeof judgments === 'string') return [parseOne(LONE, null, judgments)];
  const entries = Object.entries(judgments);
  if (entries.length === 0) throw invalid('it was given no judgments');
  return entries.map(([id, judgment]) => parseOne(id, id, judgment));
}

function parseOne(id: string, label: string | null, judgment: Judgment): Asked {
  const name = label ?? 'the judgment';
  if (typeof judgment === 'string') return parseChance(id, label, name, { instructions: judgment });
  // A caller without types, or a judgments file loaded as JSON, reaches here with anything.
  if (typeof judgment !== 'object' || judgment === null || Array.isArray(judgment)) {
    throw invalid(
      `${name} is ${JSON.stringify(judgment) ?? typeof judgment}, not a statement or a judgment`,
    );
  }
  const type: unknown = judgment.type;
  if (type === 'choice') return parseChoice(id, label, name, judgment as ChoiceJudgment);
  if (type === undefined || type === 'boolean') {
    return parseChance(id, label, name, judgment as ChanceJudgment);
  }
  // A score would otherwise be asked as a yes or no and pass on an answer to a different question.
  throw invalid(
    `${name} has type ${JSON.stringify(type)}, and a judgment is a boolean or a choice`,
  );
}

const CHANCE_KEYS = new Set(['type', 'instructions', 'criteria', 'min', 'max']);
const CHOICE_KEYS = new Set(['type', 'instructions', 'criteria', 'is', 'min']);

function parseChance(
  id: string,
  label: string | null,
  name: string,
  judgment: ChanceJudgment,
): Asked {
  checkKeys(name, judgment, CHANCE_KEYS, 'a yes or no judgment');
  const instructions = checkInstructions(name, judgment.instructions);
  const { min, max } = judgment;
  checkChance(name, 'min', min);
  checkChance(name, 'max', max);
  if (min !== undefined && max !== undefined && min > max) {
    throw invalid(`${name} has min ${String(min)} above max ${String(max)}`);
  }
  return {
    id,
    label,
    instructions,
    // Built key by key rather than spread, so `min` and `max` never reach the provider.
    question: {
      type: 'boolean',
      instructions: judgment.instructions,
      ...(judgment.criteria === undefined ? {} : { criteria: judgment.criteria }),
    } as Experimental_EvaluationQuestion,
    expectation: {
      kind: 'chance',
      min: min ?? (max === undefined ? DEFAULT_MIN_CHANCE : null),
      max: max ?? null,
    },
  };
}

function parseChoice(
  id: string,
  label: string | null,
  name: string,
  judgment: ChoiceJudgment,
): Asked {
  checkKeys(name, judgment, CHOICE_KEYS, 'a choice judgment');
  const instructions = checkInstructions(name, judgment.instructions);
  const criteria: unknown = judgment.criteria;
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
    throw invalid(`${name} is a choice with no criteria to choose from`);
  }
  const options = Object.keys(criteria);
  if (options.length === 0) throw invalid(`${name} is a choice with no criteria to choose from`);
  if (!options.includes(judgment.is)) {
    throw invalid(
      `${name} expects ${JSON.stringify(judgment.is)}, which is not one of its criteria: ${options.join(', ')}`,
    );
  }
  checkChance(name, 'min', judgment.min);
  return {
    id,
    label,
    instructions,
    question: {
      type: 'choice',
      instructions: judgment.instructions,
      criteria: judgment.criteria,
    } as Experimental_EvaluationQuestion,
    expectation: { kind: 'choice', is: judgment.is, min: judgment.min ?? null },
  };
}

/** A key that belongs to the other kind is a bound the author believes is being checked. */
function checkKeys(
  name: string,
  judgment: object,
  allowed: ReadonlySet<string>,
  kind: string,
): void {
  const stray = Object.keys(judgment).filter((key) => !allowed.has(key));
  if (stray.length > 0)
    throw invalid(`${name} has ${stray.join(', ')}, which ${kind} does not take`);
}

function checkInstructions(name: string, instructions: unknown): string {
  const empty =
    instructions === undefined ||
    instructions === null ||
    (typeof instructions === 'string' && instructions.trim() === '');
  if (empty || (typeof instructions !== 'string' && typeof instructions !== 'object')) {
    throw invalid(`${name} has no instructions to put to the model`);
  }
  return typeof instructions === 'string' ? instructions : JSON.stringify(instructions);
}

function checkChance(name: string, key: 'min' | 'max', value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(`${name} has ${key} ${String(value)}, and a chance runs from 0 to 1`);
  }
}

export function invalid(reason: string): TouchpressError {
  return new TouchpressError({ kind: 'ai-judgment-invalid', reason });
}

/**
 * Every judgment, asked together on a fresh capture until all of them pass or
 * the budget runs out. One call per poll however many judgments there are,
 * because an evaluation model answers them in parallel.
 */
export async function pollJudgments(run: JudgedRun): Promise<JudgedOutcome> {
  const deadline = Date.now() + run.timeout;
  let polls = 0;
  let last = null as JudgedOutcome | null;
  let usage: JudgedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let interrupted: string | null = null;
  for (;;) {
    const started = Date.now();
    // The capture sits inside the guard too. A screen mid-transition is what the loop exists to
    // absorb, and a snapshot that fails on the way there is part of that transition.
    let poll: Awaited<ReturnType<typeof capturedAndJudged>> | null = null;
    try {
      poll = await capturedAndJudged(run, deadline);
    } catch (error) {
      // The first poll has nothing to fall back on, so whatever stopped it is the failure.
      if (last === null) throw error;
      interrupted = error instanceof Error ? (error.message.split('\n')[0] ?? null) : String(error);
    }
    if (poll !== null) {
      usage = sum(usage, poll.result.usage);
      const verdicts = run.asked.map((asked) => verdictOf(asked, poll.result.answers[asked.id]));
      last = {
        pass: verdicts.every((verdict) => verdict.passed),
        verdicts,
        screen: renderScreen(poll.screen),
        polls: (polls += 1),
        answers: poll.result.answers,
        usage,
        providerMetadata: poll.result.providerMetadata,
        interrupted: null,
      };
      interrupted = null;
      if (last.pass) return last;
    } else if (last !== null) {
      last = { ...last, usage, interrupted };
    }
    // Another poll is worth starting only when the wait and a poll as long as this one both fit.
    // One that cannot finish costs a capture and a model call whose answer is thrown away.
    const fits = deadline - Date.now() > POLL_INTERVAL_MS + (Date.now() - started);
    if (!fits && last !== null) return last;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function capturedAndJudged(
  run: JudgedRun,
  deadline: number,
): Promise<{ readonly screen: Screen; readonly result: SdkResult }> {
  const screen = await run.screen();
  return { screen, result: await judgeOnce(run, screen, deadline) };
}

function sum(total: JudgedUsage, poll: SdkResult['usage']): JudgedUsage {
  const inputTokens = total.inputTokens + (poll.inputTokens ?? 0);
  const outputTokens = total.outputTokens + (poll.outputTokens ?? 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function verdictOf(asked: Asked, answer: SdkAnswer | undefined): Verdict {
  const { label, instructions, expectation } = asked;
  if (expectation.kind === 'chance') {
    if (answer?.type !== 'boolean') throw mismatch(asked, answer);
    const chance = answer.probability;
    const below = expectation.min !== null && chance < expectation.min;
    const above = expectation.max !== null && chance > expectation.max;
    const missed = below ? expectation.min : above ? expectation.max : null;
    return {
      label,
      instructions,
      passed: missed === null,
      received: `${apartFrom(chance, missed)} chance`,
      needed: bounds(expectation.min, expectation.max),
    };
  }
  if (answer?.type !== 'choice') throw mismatch(asked, answer);
  const chance = answer.probabilities?.[answer.choice];
  const sure = expectation.min === null || (chance !== undefined && chance >= expectation.min);
  const missed = chance !== undefined && !sure ? expectation.min : null;
  // A provider may report no distribution, and a `min` it cannot be held to must say so rather
  // than fail on an answer that reads as exactly the one asked for.
  const held =
    chance !== undefined
      ? `${apartFrom(chance, missed)} chance`
      : expectation.min === null
        ? null
        : 'no chance reported';
  return {
    label,
    instructions,
    passed: answer.choice === expectation.is && sure,
    received: held === null ? answer.choice : `${answer.choice} (${held})`,
    needed:
      expectation.min === null
        ? expectation.is
        : `${expectation.is} at ${percent(expectation.min)} or more`,
  };
}

function mismatch(asked: Asked, answer: SdkAnswer | undefined): Error {
  return new Error(
    `the evaluation model answered "${asked.id}" with ${JSON.stringify(answer) ?? 'nothing'}`,
  );
}

function bounds(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `between ${percent(min)} and ${percent(max)}`;
  if (max !== null) return `at most ${percent(max)}`;
  return `at least ${percent(min ?? DEFAULT_MIN_CHANCE)}`;
}

function percent(value: number, digits = 0): string {
  return `${String(Number((value * 100).toFixed(digits)))}%`;
}

/**
 * The chance, printed with as many decimals as it takes to read differently from
 * the bound it missed. Rounded alike, 0.7963 against 0.8 prints as "80% chance,
 * needed at least 80%", which reads as a pass that failed.
 */
function apartFrom(chance: number, missed: number | null): string {
  if (missed === null) return percent(chance);
  for (const digits of [0, 1, 2, 3]) {
    if (percent(chance, digits) !== percent(missed, digits)) return percent(chance, digits);
  }
  return percent(chance, 4);
}

/** A gateway id already reads as a name, and an instance carries its own. */
export function modelName(model: AiEvaluationModel): string {
  return typeof model === 'string' ? model : model.modelId;
}

async function judgeOnce(run: JudgedRun, screen: Screen, deadline: number): Promise<SdkResult> {
  const evaluate = await loadEvaluate();
  // What is left of the assertion's budget, so a model that hangs fails the poll rather than outliving it.
  const timeout = Math.max(1, deadline - Date.now());
  return evaluate({
    model: evaluationModel(run.model),
    state: screenState(screen, run.platform),
    questions: Object.fromEntries(run.asked.map((asked) => [asked.id, asked.question])),
    abortSignal: AbortSignal.timeout(timeout),
  }).catch((error: unknown) => {
    if (!timedOut(error)) throw error;
    throw new TouchpressError({
      kind: 'ai-timeout',
      command: 'toBeJudged',
      asked: run.asked.map((asked) => asked.label ?? asked.instructions).join(', '),
      // The assertion's budget, not what was left of it. A capture that ate the budget leaves the
      // model a millisecond, and "ran out of its 1ms budget" blames the wrong thing.
      timeoutMs: run.timeout,
      screen: renderScreen(screen),
    });
  });
}

type StateNode = {
  readonly role: string;
  readonly name?: string;
  readonly testId?: string;
  readonly selected?: true;
  readonly focused?: true;
  readonly disabled?: true;
  readonly children?: StateNode[];
};

type ScreenState = {
  readonly platform: Platform;
  readonly screen: StateNode[];
  readonly truncated?: true;
};

/**
 * The screen as the model judges it. A nested tree rather than the listing a
 * failure message prints, because an evaluation model reads structure better
 * than indentation. Across 28 labeled statements on 8 captured screens Jev
 * answered 27 inside the default bounds from this shape against 26 from the
 * listing, and sat more than 0.1 from the truth once against five times. Like
 * the listing, it never carries a field's value.
 */
function screenState(screen: Screen, platform: Platform): ScreenState {
  const roots: StateNode[] = [];
  const open: { readonly depth: number; readonly children: StateNode[] }[] = [];
  for (const node of screen.nodes) {
    while (open.length > 0 && (open.at(-1)?.depth ?? -1) >= node.depth) open.pop();
    const children: StateNode[] = [];
    (open.at(-1)?.children ?? roots).push(stateNode(node, children));
    open.push({ depth: node.depth, children });
  }
  return {
    platform,
    screen: roots.map(withoutEmptyChildren),
    ...(screen.truncated ? { truncated: true as const } : {}),
  };
}

function stateNode(node: ScreenNode, children: StateNode[]): StateNode {
  return {
    role: node.role,
    ...(node.name === null ? {} : { name: node.name }),
    ...(node.testId === null ? {} : { testId: node.testId }),
    ...(node.selected ? { selected: true as const } : {}),
    ...(node.focused ? { focused: true as const } : {}),
    ...(node.enabled ? {} : { disabled: true as const }),
    children,
  };
}

function withoutEmptyChildren(node: StateNode): StateNode {
  const { children, ...rest } = node;
  return children === undefined || children.length === 0
    ? rest
    : { ...rest, children: children.map(withoutEmptyChildren) };
}

/**
 * `experimental_evaluate` arrived in ai 7.0.103 and the peer range still allows
 * 6, so it is read off the loaded module rather than imported by name. A missing
 * export is a version to raise, which is a different answer from a package that
 * never resolved.
 */
async function loadEvaluate(): Promise<SdkEvaluate> {
  const sdk = await loadAi();
  const held: unknown = Reflect.get(sdk, 'experimental_evaluate');
  if (typeof held !== 'function') throw new TouchpressError({ kind: 'ai-judge-unsupported' });
  return held as SdkEvaluate;
}

/**
 * The public types are structural so the main entry's declarations never import
 * from `ai`, and this cast and the two in the parsers are where they meet the
 * SDK's own. Each structural type spells the shape the SDK spells.
 */
function evaluationModel(model: AiEvaluationModel): Experimental_EvaluationModel {
  return model as Experimental_EvaluationModel;
}
