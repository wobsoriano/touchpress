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
  // An array has entries too, and would be asked as judgments named "0" and "1".
  if (typeof judgments !== 'object' || judgments === null || Array.isArray(judgments)) {
    throw invalid(
      `it was given ${JSON.stringify(judgments) ?? typeof judgments}, not a statement or a record of judgments`,
    );
  }
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
    question: jsonOnly({
      type: 'boolean',
      instructions: judgment.instructions,
      ...(judgment.criteria === undefined ? {} : { criteria: judgment.criteria }),
    }),
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
    question: jsonOnly({
      type: 'choice',
      instructions: judgment.instructions,
      criteria: judgment.criteria,
    }),
    expectation: { kind: 'choice', is: judgment.is, min: judgment.min ?? null },
  };
}

/**
 * The question as JSON carries it. The public types allow an `undefined` inside
 * structured instructions and criteria, the way the SDK's own do, and the SDK
 * then rejects one at runtime. A round trip drops them, which is what the author
 * of `{ context: maybeMissing }` meant.
 */
function jsonOnly(question: object): Experimental_EvaluationQuestion {
  return JSON.parse(JSON.stringify(question)) as Experimental_EvaluationQuestion;
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
    // The capture sits inside the guard too. A screen mid-transition is what the loop exists to
    // absorb, and a snapshot that fails on the way there is part of that transition.
    let poll: Awaited<ReturnType<typeof capturedAndJudged>> | null = null;
    try {
      poll = await capturedAndJudged(run, deadline);
    } catch (error) {
      // The first poll has nothing to fall back on, so whatever stopped it is the failure.
      if (last === null) throw error;
      // A poll the budget cut short is how a failing assertion normally ends, not an interruption.
      if (!isOutOfBudget(error)) {
        interrupted =
          error instanceof Error ? (error.message.split('\n')[0] ?? null) : String(error);
      }
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
    // Poll again whenever the wait fits. How long the last poll took says little about the next
    // one, since a cold start or a slow capture does not repeat, and a poll the budget cuts short
    // falls back to these verdicts anyway.
    if (last !== null && deadline - Date.now() <= POLL_INTERVAL_MS) return last;
    await sleep(POLL_INTERVAL_MS);
  }
}

function isOutOfBudget(error: unknown): boolean {
  return error instanceof TouchpressError && error.info.kind === 'ai-timeout';
}

/**
 * One poll, held to the assertion's deadline from the capture on. The capture is
 * a device round trip with no budget of its own here, so without the race a slow
 * one lets the assertion pass after its timeout and a hung one never ends.
 */
async function capturedAndJudged(
  run: JudgedRun,
  deadline: number,
): Promise<{ readonly screen: Screen; readonly result: SdkResult }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(outOfBudget(run, 'No screen was captured in time.')),
      Math.max(0, deadline - Date.now()),
    );
  });
  const screen = await Promise.race([run.screen(), expired]).finally(() => clearTimeout(timer));
  if (Date.now() >= deadline) throw outOfBudget(run, renderScreen(screen));
  return { screen, result: await judgeOnce(run, screen, deadline) };
}

function outOfBudget(run: JudgedRun, screen: string): TouchpressError {
  const asked = run.asked.map((one) => one.label ?? one.instructions).join(', ');
  return new TouchpressError({
    kind: 'ai-timeout',
    command: 'toBeJudged',
    asked,
    instruction: asked,
    // The assertion's budget, not what was left of it, so the message never blames a millisecond.
    timeoutMs: run.timeout,
    screen,
  });
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
      received: `${percent(chance, digitsApart(chance, missed))} chance`,
      needed: bounds(expectation.min, expectation.max, digitsApart(chance, missed)),
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
      ? `${percent(chance, digitsApart(chance, missed))} chance`
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
        : `${expectation.is} at ${percent(expectation.min, digitsApart(chance ?? 0, missed))} or more`,
  };
}

function mismatch(asked: Asked, answer: SdkAnswer | undefined): Error {
  return new Error(
    `the evaluation model answered "${asked.id}" with ${JSON.stringify(answer) ?? 'nothing'}`,
  );
}

function bounds(min: number | null, max: number | null, digits: number): string {
  if (min !== null && max !== null) {
    return `between ${percent(min, digits)} and ${percent(max, digits)}`;
  }
  if (max !== null) return `at most ${percent(max, digits)}`;
  return `at least ${percent(min ?? DEFAULT_MIN_CHANCE, digits)}`;
}

function percent(value: number, digits: number): string {
  return `${String(Number((value * 100).toFixed(digits)))}%`;
}

/**
 * How many decimals it takes for a chance and the bound it missed to print as
 * different numbers. Both are printed at that precision, because rounding either
 * one alone turns 0.8 against a minimum of 0.804 into "80% chance, needed at
 * least 80%", which reads as a pass that failed. Zero when nothing was missed.
 */
function digitsApart(chance: number, missed: number | null): number {
  if (missed === null) return 0;
  for (let digits = 0; digits <= 12; digits += 1) {
    if (percent(chance, digits) !== percent(missed, digits)) return digits;
  }
  return 12;
}

/** A gateway id already reads as a name, and an instance carries its own. */
export function modelName(model: AiEvaluationModel): string {
  return typeof model === 'string' ? model : model.modelId;
}

async function judgeOnce(run: JudgedRun, screen: Screen, deadline: number): Promise<SdkResult> {
  const evaluate = await loadEvaluate();
  return evaluate({
    model: evaluationModel(run.model),
    state: screenState(screen, run.platform),
    questions: Object.fromEntries(run.asked.map((asked) => [asked.id, asked.question])),
    // What is left of the assertion's budget, so a model that hangs fails the poll rather than outliving it.
    abortSignal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  }).catch((error: unknown) => {
    if (!timedOut(error)) throw error;
    throw outOfBudget(run, renderScreen(screen));
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
