import type { ExpectMatcherState } from '@playwright/test';
import { internalsOf, type Judgments } from '../ai/device.ts';
import { invalid, modelName, parseJudgments, pollJudgments } from '../ai/judge.ts';
import type { JudgedOutcome, Verdict } from '../ai/verdict.ts';
import type { Device } from '../core/device.ts';
import { TouchpressError } from '../core/errors.ts';

export type JudgedOptions = { timeout?: number };

type MatcherResult = {
  pass: boolean;
  message: () => string;
  name: string;
  expected: string;
  actual: string;
};

/**
 * One step for the whole assertion, however many times it polls and however
 * many judgments it carries. Every judgment is asked in the same call, so the
 * poll count is the assertion's and not any one judgment's.
 */
export async function assertJudged(
  state: ExpectMatcherState,
  device: Device,
  judgments: Judgments,
  options: JudgedOptions | undefined,
): Promise<MatcherResult> {
  // A negated record has two readings, all of it false or any of it false, and a negated chance
  // would pass on a model that is merely unsure. `max` and `is` say which one is meant.
  if (state.isNot) {
    throw invalid(
      'it cannot be negated. Say what must be false with `max`, as in { instructions, max: 0.1 }',
    );
  }
  const internals = internalsOf(device);
  if (internals?.model === undefined) {
    throw new TouchpressError({ kind: 'ai-judge-not-configured' });
  }
  const model = internals.model;
  const asked = parseJudgments(judgments);
  const timeout = options?.timeout ?? state.timeout;
  const judge = modelName(model);

  const title =
    typeof judgments === 'string'
      ? `toBeJudged "${judgments}"`
      : `toBeJudged ${asked.map((one) => one.id).join(', ')}`;
  const outcome = await internals.sink.step(title, async () => {
    const polled = await pollJudgments({
      model,
      asked,
      timeout,
      platform: internals.platform,
      screen: () => internals.screen(),
    });
    // One line per judgment under the step, so a report says which model judged and how sure it
    // ended up without anyone opening the attachment.
    for (const verdict of polled.verdicts) {
      await internals.sink.step(`${judge}: ${verdictLine(verdict)}`, () => Promise.resolve(), {
        box: true,
      });
    }
    await internals.sink.attach({
      name: `ai-judged-${String(internals.nextJudged())}.json`,
      contentType: 'application/json',
      body: JSON.stringify(
        {
          judgments,
          answers: polled.answers,
          verdicts: polled.verdicts.map(({ label, passed, received, needed }) => ({
            ...(label === null ? {} : { judgment: label }),
            passed,
            received,
            needed,
          })),
          polls: polled.polls,
          usage: polled.usage,
          // Where a provider puts what it knows beyond the answer, such as TypeSafe's per-question confidence.
          providerMetadata: polled.providerMetadata,
        },
        null,
        2,
      ),
    });
    return polled;
  });

  const summary = (pick: keyof Pick<Verdict, 'received' | 'needed'>): string =>
    outcome.verdicts
      .map((verdict) =>
        verdict.label === null ? verdict[pick] : `${verdict.label} ${verdict[pick]}`,
      )
      .join(', ');
  return {
    pass: outcome.pass,
    name: 'toBeJudged',
    expected: summary('needed'),
    actual: summary('received'),
    message: () => failure(judge, outcome, timeout),
  };
}

function verdictLine(verdict: Verdict): string {
  const said = `${verdict.received}, needed ${verdict.needed}`;
  return verdict.label === null ? said : `${verdict.label} ${said}`;
}

function failure(judge: string, outcome: JudgedOutcome, timeout: number): string {
  const lines = outcome.verdicts.flatMap((verdict) => [
    `${verdict.passed ? 'pass' : 'FAIL'}  ${verdictLine(verdict)}`,
    ...(verdict.passed ? [] : [`      asked: ${verdict.instructions}`]),
  ]);
  return [
    `Expected toBeJudged but ${judge} never agreed.`,
    ``,
    ...lines,
    ``,
    `Timeout: ${String(timeout)}ms (${String(outcome.polls)} poll${outcome.polls === 1 ? '' : 's'})`,
    ...(outcome.interrupted === null ? [] : [`A later poll failed: ${outcome.interrupted}`]),
    ``,
    `Screen:`,
    outcome.screen,
  ].join('\n');
}
