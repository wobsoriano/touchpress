import { expect, test, vi } from 'vite-plus/test';
import type { ExpectMatcherState } from '@playwright/test';
import { Experimental_EvaluationMockModelV4 } from 'ai/test';
import { withAi, type AiDevice, type Judgments } from '../src/ai/device.ts';
import { modelName, parseJudgments } from '../src/ai/judge.ts';
import type { Device } from '../src/core/device.ts';
import { TouchpressError } from '../src/core/errors.ts';
import type { Screen } from '../src/core/screen.ts';
import type { DeviceSession, SessionDevice } from '../src/core/session.ts';
import { assertJudged } from '../src/playwright/judged.ts';
import { createRecordingSink } from './fake-driver.ts';
import { loadScreen } from './fixtures.ts';

/** Derived from the mock's own constructor, so the provider spec is never restated here. */
type Evaluate = NonNullable<
  NonNullable<ConstructorParameters<typeof Experimental_EvaluationMockModelV4>[0]>['doEvaluate']
>;
type Call = Parameters<Evaluate>[0];
type Result = Awaited<ReturnType<Evaluate>>;
type Answer = Result['answers'][string];

const USAGE = { inputTokens: 40, outputTokens: 4 };

function model(doEvaluate: Evaluate): Experimental_EvaluationMockModelV4 {
  return new Experimental_EvaluationMockModelV4({ provider: 'typesafe-ai', doEvaluate });
}

/**
 * Answers each poll from the next entry in `polls` and repeats the last one. An entry maps a
 * question id to its answer, and a bare number answers every boolean question with that chance.
 */
function scripted(
  polls: readonly (number | Error | Record<string, Answer>)[],
  calls: Call[] = [],
): Experimental_EvaluationMockModelV4 {
  return model((call: Call): Promise<Result> => {
    const poll = polls[Math.min(calls.length, polls.length - 1)] ?? 0;
    calls.push(call);
    if (poll instanceof Error) return Promise.reject(poll);
    return Promise.resolve({
      answers: Object.fromEntries(
        Object.keys(call.questions).map((id) => [
          id,
          typeof poll === 'number'
            ? { type: 'boolean' as const, probability: poll }
            : (poll[id] as Answer),
        ]),
      ),
      usage: USAGE,
      providerMetadata: { 'typesafe-ai': { confidence: {} } },
      warnings: [],
    });
  });
}

/** Answers after `delayMs` unless the call is aborted first, the way a real provider request behaves. */
function slow(chance: number, delayMs: number): Experimental_EvaluationMockModelV4 {
  return model(
    (call: Call): Promise<Result> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            answers: Object.fromEntries(
              Object.keys(call.questions).map((id) => [
                id,
                { type: 'boolean' as const, probability: chance },
              ]),
            ),
            warnings: [],
          });
        }, delayMs);
        call.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(call.abortSignal?.reason as Error);
        });
      }),
  );
}

function fakeSession(screens: readonly (Screen | Error)[]): DeviceSession {
  let captures = 0;
  const one: SessionDevice = {
    capture: () => {
      const screen = screens[Math.min(captures, screens.length - 1)];
      captures += 1;
      if (screen === undefined) throw new Error('the fake session was given no screen');
      if (screen instanceof Error) return Promise.reject(screen);
      return Promise.resolve(screen);
    },
  } as SessionDevice;
  return {
    name: 'touchpress-ai-0',
    options: { platform: 'ios' },
    run: <T>(body: (device: SessionDevice) => Promise<T>) => body(one),
  } as DeviceSession;
}

function aiDevice(
  evaluationModel: Experimental_EvaluationMockModelV4 | undefined,
  sink = createRecordingSink(),
  screens: readonly (Screen | Error)[] = [loadScreen('ios-login')],
): Device & AiDevice {
  return withAi({} as Device, fakeSession(screens), sink, undefined, evaluationModel);
}

function state(timeout: number, isNot = false): ExpectMatcherState {
  return { isNot, timeout } as ExpectMatcherState;
}

function judged(device: Device, judgments: Judgments, timeout = 1000) {
  return assertJudged(state(timeout), device, judgments, undefined);
}

test('a lone statement is one boolean question that passes at the default 80% chance', async () => {
  const calls: Call[] = [];
  const result = await judged(aiDevice(scripted([0.81], calls)), 'A user is signed in');

  expect(result.pass).toBe(true);
  expect(result.actual).toBe('81% chance');
  expect(result.expected).toBe('at least 80%');
  expect(calls[0]?.questions).toEqual({
    judged: { type: 'boolean', instructions: 'A user is signed in' },
  });
});

test('the model judges the screen as a nested tree, without refs or field values', async () => {
  const calls: Call[] = [];
  await judged(aiDevice(scripted([1], calls)), 'A user is signed in');

  expect(calls[0]?.state).toEqual({
    platform: 'ios',
    screen: [
      {
        role: 'application',
        name: 'awesome-todo',
        children: [
          {
            role: 'window',
            children: [
              {
                role: 'other',
                children: [
                  {
                    role: 'other',
                    testId: 'login',
                    children: [
                      { role: 'text', name: 'Sign in' },
                      { role: 'text-field', name: 'Email', testId: 'email' },
                      { role: 'secure-text-field', name: 'Password', testId: 'password' },
                      { role: 'button', name: 'Continue', testId: 'continue' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

test('a record asks every judgment in one call and strips min, max, and is before the model sees them', async () => {
  const calls: Call[] = [];
  const result = await judged(
    aiDevice(
      scripted(
        [
          {
            signedIn: { type: 'boolean', probability: 0.97 },
            showingError: { type: 'boolean', probability: 0.02 },
            screen: { type: 'choice', choice: 'home', probabilities: { home: 0.93, login: 0.07 } },
          },
        ],
        calls,
      ),
    ),
    {
      signedIn: 'A user is signed in',
      showingError: {
        instructions: 'An error message is visible',
        criteria: { true: 'A red banner is showing' },
        max: 0.1,
      },
      screen: {
        type: 'choice',
        instructions: 'Which screen is this?',
        criteria: { home: 'Shows the Welcome title', login: null },
        is: 'home',
        min: 0.9,
      },
    },
  );

  expect(result.pass).toBe(true);
  expect(calls, 'three judgments cost one call').toHaveLength(1);
  expect(calls[0]?.questions).toEqual({
    signedIn: { type: 'boolean', instructions: 'A user is signed in' },
    showingError: {
      type: 'boolean',
      instructions: 'An error message is visible',
      criteria: { true: 'A red banner is showing' },
    },
    screen: {
      type: 'choice',
      instructions: 'Which screen is this?',
      criteria: { home: 'Shows the Welcome title', login: null },
    },
  });
  expect(result.actual).toBe(
    'signedIn 97% chance, showingError 2% chance, screen home (93% chance)',
  );
  expect(result.expected).toBe(
    'signedIn at least 80%, showingError at most 10%, screen home at 90% or more',
  );
});

test('it polls until every judgment passes, in one step with a line per judgment', async () => {
  const sink = createRecordingSink();
  const calls: Call[] = [];
  const result = await judged(
    aiDevice(
      scripted(
        [
          {
            signedIn: { type: 'boolean', probability: 0.3 },
            error: { type: 'boolean', probability: 0.02 },
          },
          {
            signedIn: { type: 'boolean', probability: 0.96 },
            error: { type: 'boolean', probability: 0.5 },
          },
          {
            signedIn: { type: 'boolean', probability: 0.96 },
            error: { type: 'boolean', probability: 0.04 },
          },
        ],
        calls,
      ),
      sink,
    ),
    { signedIn: 'A user is signed in', error: { instructions: 'An error is visible', max: 0.1 } },
    5000,
  );

  expect(result.pass, 'the second poll passed one judgment and failed the other').toBe(true);
  expect(calls).toHaveLength(3);
  expect(sink.steps).toEqual([
    { title: 'toBeJudged signedIn, error', depth: 0, boxed: false },
    { title: 'mock-model-id: signedIn 96% chance, needed at least 80%', depth: 1, boxed: true },
    { title: 'mock-model-id: error 4% chance, needed at most 10%', depth: 1, boxed: true },
  ]);
});

test('a lone statement reports under its own words and needs no name on its answer line', async () => {
  const sink = createRecordingSink();
  await judged(aiDevice(scripted([0.95]), sink), 'A user is signed in');

  expect(sink.steps).toEqual([
    { title: 'toBeJudged "A user is signed in"', depth: 0, boxed: false },
    { title: 'mock-model-id: 95% chance, needed at least 80%', depth: 1, boxed: true },
  ]);
});

test('each assertion attaches the judgments as written, the answers, the verdicts, and the metadata', async () => {
  const sink = createRecordingSink();
  await judged(aiDevice(scripted([0.91]), sink), { signedIn: 'A user is signed in' });

  const file = sink.attachments[0];
  expect(file?.name).toBe('ai-judged-1.json');
  expect(JSON.parse(file !== undefined && 'body' in file ? file.body : '{}')).toEqual({
    judgments: { signedIn: 'A user is signed in' },
    answers: { signedIn: { type: 'boolean', probability: 0.91 } },
    verdicts: [
      { judgment: 'signedIn', passed: true, received: '91% chance', needed: 'at least 80%' },
    ],
    polls: 1,
    usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
    providerMetadata: { 'typesafe-ai': { confidence: {} } },
  });
});

test('a chance between the bounds fails the statement and fails its max form too', async () => {
  const unsure = () => aiDevice(scripted([0.5]));

  const positive = await judged(unsure(), 'A user is signed in', 20);
  const negative = await judged(
    unsure(),
    { signedIn: { instructions: 'A user is signed in', max: 0.2 } },
    20,
  );

  expect(positive.pass, '50% never reached 80%').toBe(false);
  expect(negative.pass, '50% never fell to 20%').toBe(false);
});

test('a failure names the model, marks each judgment, and prints what the failed one asked', async () => {
  const result = await judged(
    aiDevice(
      scripted([
        {
          signedIn: { type: 'boolean', probability: 0.41 },
          error: { type: 'boolean', probability: 0.03 },
        },
      ]),
    ),
    { signedIn: 'A user is signed in', error: { instructions: 'An error is visible', max: 0.1 } },
    30,
  );

  expect(result.pass).toBe(false);
  const message = result.message();
  expect(message).toContain('Expected toBeJudged but mock-model-id never agreed.');
  expect(message).toContain('FAIL  signedIn 41% chance, needed at least 80%');
  expect(message).toContain('asked: A user is signed in');
  expect(message).toContain('pass  error 3% chance, needed at most 10%');
  expect(message, 'a judgment that passed does not repeat its instructions').not.toContain(
    'asked: An error is visible',
  );
  expect(message).toContain('Timeout: 30ms (1 poll)');
  expect(message).toContain('@e8 [button] "Continue" #continue');
});

test('a choice fails on the wrong option and on the right option held too loosely', async () => {
  const screen = {
    type: 'choice',
    instructions: 'Which screen is this?',
    criteria: { home: null, login: null },
    is: 'home',
    min: 0.9,
  } as const;
  const wrong = await judged(
    aiDevice(
      scripted([
        { screen: { type: 'choice', choice: 'login', probabilities: { home: 0.2, login: 0.8 } } },
      ]),
    ),
    { screen },
    20,
  );
  const loose = await judged(
    aiDevice(
      scripted([
        { screen: { type: 'choice', choice: 'home', probabilities: { home: 0.6, login: 0.4 } } },
      ]),
    ),
    { screen },
    20,
  );

  expect(wrong.pass).toBe(false);
  expect(wrong.actual).toBe('screen login (80% chance)');
  expect(loose.pass).toBe(false);
  expect(loose.message()).toContain('FAIL  screen home (60% chance), needed home at 90% or more');
});

test('a judgment no model could be asked is refused before one is', async () => {
  const calls: Call[] = [];
  const device = aiDevice(scripted([1], calls));
  const refusal = async (judgments: Judgments): Promise<string> => {
    const error = await judged(device, judgments).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TouchpressError);
    expect((error as TouchpressError).info.kind).toBe('ai-judgment-invalid');
    return (error as TouchpressError).message;
  };

  expect(await refusal({})).toContain('it was given no judgments');
  expect(await refusal({ a: { instructions: 'x', min: 1.2 } })).toContain('a has min 1.2');
  expect(await refusal({ a: { instructions: 'x', min: 0.9, max: 0.1 } })).toContain(
    'min 0.9 above max 0.1',
  );
  expect(
    await refusal({
      screen: { type: 'choice', instructions: 'x', criteria: { home: null }, is: 'hme' },
    }),
  ).toContain('expects "hme", which is not one of its criteria: home');
  expect(calls, 'nothing reached the model').toHaveLength(0);
});

test('not.toBeJudged is refused and points at max', async () => {
  const error = await assertJudged(
    state(1000, true),
    aiDevice(scripted([0])),
    'x',
    undefined,
  ).catch((thrown: unknown) => thrown);

  expect((error as TouchpressError).info.kind).toBe('ai-judgment-invalid');
  expect((error as TouchpressError).message).toContain('max: 0.1');
});

test('toBeJudged names the evaluationModel key when no evaluation model is configured', async () => {
  const error = await judged(aiDevice(undefined), 'A user is signed in').catch(
    (thrown: unknown) => thrown,
  );

  expect((error as TouchpressError).info).toEqual({ kind: 'ai-judge-not-configured' });
  expect((error as TouchpressError).message).toContain('use.evaluationModel');
});

test('a budget that runs out during a later poll fails with the last verdicts, not a timeout', async () => {
  const result = await judged(aiDevice(slow(0.4, 400)), 'A user is signed in', 1200);

  expect(result.pass).toBe(false);
  expect(result.message()).toContain('FAIL  40% chance, needed at least 80%');
  expect(result.message(), 'the second poll was cut short, so only the first counts').toContain(
    '(1 poll)',
  );
});

test('a model that never answers the first poll is a timeout, since there is no verdict to report', async () => {
  await expect(judged(aiDevice(slow(0.4, 5_000)), 'A user is signed in', 30)).rejects.toMatchObject(
    {
      info: {
        kind: 'ai-timeout',
        command: 'toBeJudged',
        asked: 'A user is signed in',
        timeoutMs: 30,
      },
    },
  );
});

test("an 'ai' without experimental_evaluate names the version toBeJudged needs", async () => {
  const installed = await import('ai');
  vi.doMock('ai', () => ({ ...installed, experimental_evaluate: undefined }));
  vi.resetModules();
  const judge = await import('../src/ai/judge.ts');

  // `resetModules` gives this call its own copy of errors.ts, so the class identity is a
  // different one and the name is what identifies the error.
  const error = await judge
    .pollJudgments({
      model: scripted([1]),
      asked: parseJudgments('A user is signed in'),
      timeout: 10_000,
      platform: 'ios',
      screen: () => Promise.resolve(loadScreen('ios-login')),
    })
    .catch((thrown: unknown) => thrown);

  expect((error as TouchpressError).name).toBe('TouchpressError');
  expect((error as TouchpressError).info).toEqual({ kind: 'ai-judge-unsupported' });
  expect((error as TouchpressError).message).toContain('7.0.103');

  vi.doUnmock('ai');
  vi.resetModules();
});

test('a chance that misses its bound by a rounding never prints as the bound', async () => {
  const low = await judged(aiDevice(scripted([0.7963])), 'A user is signed in', 20);
  const high = await judged(
    aiDevice(scripted([0.104])),
    { error: { instructions: 'An error is visible', max: 0.1 } },
    20,
  );

  expect(low.pass).toBe(false);
  expect(low.message()).toContain('FAIL  79.6% chance, needed at least 80%');
  expect(high.message()).toContain('FAIL  error 10.4% chance, needed at most 10%');
});

test('a choice held to a min says so when the provider reports no chance', async () => {
  const result = await judged(
    aiDevice(scripted([{ screen: { type: 'choice', choice: 'home' } }])),
    {
      screen: {
        type: 'choice',
        instructions: 'Which screen is this?',
        criteria: { home: null, login: null },
        is: 'home',
        min: 0.9,
      },
    },
    20,
  );

  expect(result.pass).toBe(false);
  expect(result.message()).toContain(
    'FAIL  screen home (no chance reported), needed home at 90% or more',
  );
});

test('a provider error on a later poll is absorbed while the budget lasts', async () => {
  const calls: Call[] = [];
  const result = await judged(
    aiDevice(scripted([0.3, new Error('503 upstream'), 0.95], calls)),
    'A user is signed in',
    5000,
  );

  expect(result.pass, 'the poll after the error passed').toBe(true);
  expect(calls).toHaveLength(3);
});

test('a capture that fails on a later poll is absorbed the same way', async () => {
  const screen = loadScreen('ios-login');
  const result = await judged(
    aiDevice(scripted([0.3, 0.95]), createRecordingSink(), [
      screen,
      new Error('snapshot failed'),
      screen,
    ]),
    'A user is signed in',
    5000,
  );

  expect(result.pass).toBe(true);
});

test('an error that outlasts the budget fails on the last verdicts and still says what happened', async () => {
  const result = await judged(
    aiDevice(scripted([0.3, new Error('503 upstream')])),
    'A user is signed in',
    900,
  );

  expect(result.pass).toBe(false);
  expect(result.message()).toContain('FAIL  30% chance, needed at least 80%');
  expect(result.message()).toContain('A later poll failed: 503 upstream');
});

test('an error on the first poll is the failure, since there is no verdict to fall back on', async () => {
  await expect(
    judged(aiDevice(scripted([new Error('401 unauthorized')])), 'A user is signed in'),
  ).rejects.toThrow('401 unauthorized');
});

test('the attached usage is summed over every poll', async () => {
  const sink = createRecordingSink();
  await judged(aiDevice(scripted([0.2, 0.3, 0.95]), sink), 'A user is signed in', 5000);

  const file = sink.attachments[0];
  const attached = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}') as {
    polls: number;
    usage: unknown;
  };
  expect(attached.polls).toBe(3);
  expect(attached.usage).toEqual({ inputTokens: 120, outputTokens: 12, totalTokens: 132 });
});

test('a malformed judgment from an untyped caller is refused by name before any model is asked', async () => {
  const calls: Call[] = [];
  const device = aiDevice(scripted([1], calls));
  const refusal = async (judgments: unknown): Promise<string> => {
    const error = await judged(device, judgments as Judgments).catch((thrown: unknown) => thrown);
    expect((error as TouchpressError).info?.kind, JSON.stringify(judgments)).toBe(
      'ai-judgment-invalid',
    );
    return (error as TouchpressError).message;
  };

  expect(await refusal({ a: null })).toContain('a is null, not a statement or a judgment');
  expect(await refusal({ a: { min: 0.9 } })).toContain('a has no instructions');
  expect(await refusal('   ')).toContain('the judgment has no instructions');
  expect(await refusal({ a: { type: 'score', instructions: 'How polished?' } })).toContain(
    'a has type "score", and a judgment is a boolean or a choice',
  );
  expect(await refusal({ a: { type: 'choice', instructions: 'x', is: 'home' } })).toContain(
    'a is a choice with no criteria',
  );
  expect(await refusal({ a: { instructions: 'x', is: 'home' } })).toContain(
    'a has is, which a yes or no judgment does not take',
  );
  expect(
    await refusal({
      a: { type: 'choice', instructions: 'x', criteria: { home: null }, is: 'home', max: 0.1 },
    }),
  ).toContain('a has max, which a choice judgment does not take');
  expect(await refusal({ a: { instructions: 'x', max: 1.5 } })).toContain('a has max 1.5');
  expect(calls, 'nothing reached the model').toHaveLength(0);
});

test('the timeout option overrides expect.timeout', async () => {
  const result = await assertJudged(state(60_000), aiDevice(scripted([0.1])), 'x is showing', {
    timeout: 25,
  });

  expect(result.message()).toContain('Timeout: 25ms');
});

test('a gateway model id names itself in the report', () => {
  expect(modelName('typesafe-ai/jev-latest')).toBe('typesafe-ai/jev-latest');
});
