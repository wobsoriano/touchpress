import { expect, test, vi } from 'vite-plus/test';
import { Experimental_EvaluationMockModelV4 } from 'ai/test';
import { withAi, type AiDevice } from '../src/ai/device.ts';
import { offeredMoves, quotedInputs, screenState } from '../src/ai/decide.ts';
import type { Device } from '../src/core/device.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { silentSink } from '../src/core/report.ts';
import { parseScreen, type RawSnapshot, type Screen } from '../src/core/screen.ts';
import type { DeviceSession, SessionDevice } from '../src/core/session.ts';
import { createRecordingSink } from './fake-driver.ts';
import { loadScreen } from './fixtures.ts';

type Evaluate = NonNullable<
  NonNullable<ConstructorParameters<typeof Experimental_EvaluationMockModelV4>[0]>['doEvaluate']
>;
type Call = Parameters<Evaluate>[0];
type Result = Awaited<ReturnType<Evaluate>>;

/** Picks a move by its description on each poll, so a script reads as what it taps rather than as ids. */
type Pick = (description: string) => boolean;

const USAGE = { inputTokens: 300, outputTokens: 12 };

function scripted(picks: readonly Pick[], calls: Call[] = []): Experimental_EvaluationMockModelV4 {
  return new Experimental_EvaluationMockModelV4({
    provider: 'typesafe-ai',
    doEvaluate: (call: Call): Promise<Result> => {
      const pick = picks[Math.min(calls.length, picks.length - 1)];
      calls.push(call);
      const question = call.questions['next'];
      if (question?.type !== 'choice' || pick === undefined) throw new Error('unexpected question');
      const criteria = question.criteria as Record<string, string>;
      const id = Object.keys(criteria).find((one) => pick(criteria[one] ?? ''));
      if (id === undefined) throw new Error(`no offered move matched ${pick.toString()}`);
      // The SDK insists on a complete distribution, so the pick gets all of it.
      const probabilities = Object.fromEntries(
        Object.keys(criteria).map((one) => [one, one === id ? 1 : 0]),
      );
      return Promise.resolve({
        answers: { next: { type: 'choice', choice: id, probabilities } },
        usage: USAGE,
        warnings: [],
      });
    },
  });
}

const taps =
  (label: string): Pick =>
  (d) =>
    d.startsWith('Tap ') && d.includes(`"${label}"`);
const fills =
  (label: string, text: string): Pick =>
  (d) =>
    d.startsWith('Fill ') && d.includes(`"${label}"`) && d.includes(`"${text}"`);
const verdict = (id: 'pass' | 'fail' | 'incomplete' | 'need_input' | 'wait' | 'back'): Pick => {
  const words: Record<string, string> = {
    pass: 'Finish as PASSED',
    fail: 'Finish as FAILED',
    incomplete: 'Finish as INCOMPLETE',
    need_input: 'needs text typed',
    wait: 'Wait briefly',
    back: 'Go back',
  };
  return (d) => d.includes(words[id] ?? id);
};

type Performed =
  | { kind: 'tap'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'scroll'; direction: string }
  | { kind: 'back' };

function fakeSession(screens: readonly Screen[], performed: Performed[] = []): DeviceSession {
  let captures = 0;
  const settled = Promise.resolve({ settled: true, waitedMs: 0 });
  const one = {
    capture: () => {
      const screen = screens[Math.min(captures, screens.length - 1)];
      captures += 1;
      if (screen === undefined) throw new Error('the fake session was given no screen');
      return Promise.resolve(screen);
    },
    tap: (ref: string) => {
      performed.push({ kind: 'tap', ref });
      return settled;
    },
    fill: (ref: string, text: string) => {
      performed.push({ kind: 'fill', ref, text });
      return settled;
    },
    scroll: (direction: string) => {
      performed.push({ kind: 'scroll', direction });
      return Promise.resolve();
    },
    back: () => {
      performed.push({ kind: 'back' });
      return settled;
    },
  } as unknown as SessionDevice;
  return {
    name: 'touchpress-ai-0',
    options: { platform: 'ios', actionTimeout: 5000 },
    run: <T>(body: (device: SessionDevice) => Promise<T>) => body(one),
  } as DeviceSession;
}

function aiDevice(
  model: Experimental_EvaluationMockModelV4 | undefined,
  screens: readonly Screen[],
  performed: Performed[] = [],
  sink = createRecordingSink(),
): Device & AiDevice {
  return withAi({} as Device, fakeSession(screens, performed), sink, undefined, model);
}

const login = loadScreen('ios-login');
const home = loadScreen('home');

test('a screen offers the verdicts, the navigation moves, a tap per control, and a fill per quoted text per field', () => {
  const { offered, dropped } = offeredMoves(login, { text1: 'rob@example.com', text2: 'hunter2' });

  expect(dropped).toBe(0);

  expect(offered.map((one) => one.id).slice(0, 10)).toEqual([
    'pass',
    'fail',
    'incomplete',
    'need_input',
    'wait',
    'back',
    'scroll_up',
    'scroll_down',
    'scroll_left',
    'scroll_right',
  ]);
  expect(offered.slice(10).map((one) => one.description)).toEqual([
    'Focus text-field "email" at @e6.',
    'Fill text-field "email" with "rob@example.com".',
    'Fill text-field "email" with "hunter2".',
    'Focus secure-text-field "password" at @e7.',
    'Fill secure-text-field "password" with "rob@example.com".',
    'Fill secure-text-field "password" with "hunter2".',
    'Tap button "Continue" at @e8.',
  ]);
});

test('the text a task supplies is what it put in straight or curly double quotes, once each', () => {
  expect(
    quotedInputs('Sign in with "rob@example.com" and “hunter2”, then "rob@example.com" again'),
  ).toEqual({
    text1: 'rob@example.com',
    text2: 'hunter2',
  });
  expect(quotedInputs('Open the settings')).toEqual({});
});

test('the model reads roles, names, test ids, hittability, and rects, and never a field value', () => {
  const state = screenState(login);

  expect(state.nodes[5]).toEqual({
    ref: '@e6',
    role: 'text-field',
    name: 'Email',
    testId: 'email',
    hittable: true,
    rect: expect.any(Object) as unknown,
  });
  const focusedEmail = parseScreen(
    {
      nodes: [
        { ref: 'e1', index: 0, type: 'TextField', label: 'Email', enabled: true, focused: true },
      ],
    },
    'ios',
  );
  expect(screenState(focusedEmail).nodes[0]).toMatchObject({ focused: true });
  expect(JSON.stringify(state)).not.toContain('"value"');
});

test('act drives the app move by move and resolves with the verdict when the model passes it', async () => {
  const performed: Performed[] = [];
  const calls: Call[] = [];
  const sink = createRecordingSink();
  const device = aiDevice(
    scripted(
      [
        fills('email', 'rob@example.com'),
        fills('password', 'hunter2'),
        taps('Continue'),
        verdict('pass'),
      ],
      calls,
    ),
    [login, login, login, home],
    performed,
    sink,
  );

  const summary = await device.act(
    'Sign in with "rob@example.com" and "hunter2". Verify the home screen is showing.',
  );

  expect(summary).toBe('mock-model-id judged the instruction satisfied (100% chance)');
  // Refs are pinned to the capture they came from, which is what the `~s<generation>` suffix says.
  expect(
    performed.map((one) => ({ ...one, ref: 'ref' in one ? one.ref.replace(/~s\d+$/, '') : '' })),
  ).toEqual([
    { kind: 'fill', ref: '@e6', text: 'rob@example.com' },
    { kind: 'fill', ref: '@e7', text: 'hunter2' },
    { kind: 'tap', ref: '@e8' },
  ]);
  expect(calls, 'one call per step, the verdict included').toHaveLength(4);
  const first = calls[0]?.state as { task: string; previousMove: null; previousScreen: null };
  expect(first.task).toContain('Sign in with');
  expect(first.previousMove).toBeNull();
  const second = calls[1]?.state as { previousMove: string };
  expect(second.previousMove).toBe('Fill text-field "email" with "rob@example.com".');
  expect(sink.steps.map((step) => step.title)).toEqual([
    'act "Sign in with "rob@example.com" and "hunter2". Verify the home screen is showing."',
    'fill email',
    'type "rob@example.com"',
    'fill password',
    'type 7 characters',
    'tap Continue',
    'mock-model-id: passed (100% chance)',
  ]);
  const file = sink.attachments[0];
  expect(file?.name).toBe('ai-act-1.json');
  const attached = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}') as {
    outcome: string;
    steps: unknown[];
    usage: unknown;
  };
  expect(attached.outcome).toBe('pass');
  expect(attached.steps).toHaveLength(4);
  expect(attached.usage).toEqual({ inputTokens: 1200, outputTokens: 48, totalTokens: 1248 });
});

test('a fail verdict is an ai-blocked error carrying the chance and the screen', async () => {
  const device = aiDevice(scripted([verdict('fail')]), [login]);

  const error = await device
    .act('Verify the home screen is showing')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  expect((error as TouchpressError).info).toMatchObject({
    kind: 'ai-blocked',
    summary: 'the model judged the task failed (100% chance)',
  });
  expect((error as TouchpressError).message).toContain('@e8 [button] "Continue" #continue');
});

test('need_input tells the author to quote the text the task needs', async () => {
  const device = aiDevice(scripted([verdict('need_input')]), [login]);

  await expect(device.act('Sign in with my email')).rejects.toMatchObject({
    info: { kind: 'ai-blocked', summary: expect.stringContaining('double quotes') as unknown },
  });
});

test('running out of steps is ai-incomplete', async () => {
  const device = aiDevice(scripted([verdict('wait')]), [login]);

  await expect(device.act('Wait forever', { maxSteps: 2 })).rejects.toMatchObject({
    info: { kind: 'ai-incomplete', steps: 2 },
  });
});

test('the same move on the same screen three times ends the run rather than looping', async () => {
  const performed: Performed[] = [];
  const device = aiDevice(scripted([taps('Continue')]), [login], performed);

  await expect(device.act('Press Continue until it works')).rejects.toMatchObject({
    info: {
      kind: 'ai-blocked',
      summary:
        'the model chose the same move on the same screen 3 times: Tap button "Continue" at @e8.',
    },
  });
  expect(performed, 'the third pick was not performed').toHaveLength(2);
});

test('a screen with more controls than a choice holds keeps the first 245 and tells the model how many it dropped', async () => {
  const raw: RawSnapshot = {
    nodes: Array.from({ length: 260 }, (_, i) => ({
      ref: `e${String(i + 1)}`,
      index: i,
      type: 'Button',
      label: `Button ${String(i)}`,
      enabled: true,
    })),
  };
  const crowded = parseScreen(raw, 'ios');
  const calls: Call[] = [];

  const { offered, dropped } = offeredMoves(crowded, {});
  await aiDevice(scripted([verdict('pass')], calls), [crowded]).act('Look');

  expect(offered).toHaveLength(255);
  expect(dropped, 'no field, so need_input is not offered and one more control fits').toBe(14);
  const first = calls[0]?.state as { screen: { controlsWithoutMoves: number } } | undefined;
  expect(first?.screen.controlsWithoutMoves).toBe(14);
});

test('a control the capture marks not hittable is still offered, and a tab bar never is', () => {
  const { offered } = offeredMoves(home, {});
  const descriptions = offered.map((one) => one.description);

  expect(descriptions).toContain('Tap button "Home" at @e29.');
  expect(descriptions).toContain('Tap button "Explore" at @e30.');
  expect(descriptions.some((one) => one.includes('tab-bar'))).toBe(false);
});

test('waiting is exempt from the repeat guard, so a loading screen can be waited out', async () => {
  const device = aiDevice(
    scripted([verdict('wait'), verdict('wait'), verdict('wait'), verdict('wait'), verdict('pass')]),
    [login],
  );

  await expect(device.act('Wait for the screen to load', { maxSteps: 10 })).resolves.toContain(
    'satisfied',
  );
});

test('a pass the model is unsure of is looked at again, and a run that ends on one fails saying so', async () => {
  const hedging = new Experimental_EvaluationMockModelV4({
    provider: 'typesafe-ai',
    doEvaluate: (call: Call): Promise<Result> => {
      const criteria = (call.questions['next'] as { criteria: Record<string, string> }).criteria;
      const spread = Object.fromEntries(Object.keys(criteria).map((one) => [one, 0]));
      spread['pass'] = 0.5;
      spread['fail'] = 0.5;
      return Promise.resolve({
        answers: { next: { type: 'choice', choice: 'pass', probabilities: spread } },
        usage: USAGE,
        warnings: [],
      });
    },
  });
  const performed: Performed[] = [];

  const error = await aiDevice(hedging, [login], performed)
    .act('Verify the list is showing', { maxSteps: 3 })
    .catch((thrown: unknown) => thrown);

  expect((error as TouchpressError).info).toMatchObject({
    kind: 'ai-blocked',
    summary: 'the model judged the task passed at only 50%, below the 80% a pass needs',
  });
  expect(performed, 'a hedged pass performs nothing').toEqual([]);
});

test('the transcript is attached on a failing exit too', async () => {
  const sink = createRecordingSink();
  await aiDevice(scripted([taps('Continue'), verdict('fail')]), [login], [], sink)
    .act('Continue')
    .catch(() => undefined);

  const file = sink.attachments[0];
  const attached = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}') as {
    outcome: string;
    steps: { description: string }[];
    usage: { totalTokens: number };
  };
  expect(attached.outcome).toBe('fail');
  expect(attached.steps.map((one) => one.description)).toEqual([
    'Tap button "Continue" at @e8.',
    expect.stringContaining('Finish as FAILED') as unknown,
  ]);
  expect(attached.usage.totalTokens).toBe(624);
});

test('a secure fill hides its text in the transcript as well as in the step', async () => {
  const sink = createRecordingSink();
  await aiDevice(scripted([fills('password', 'hunter2'), verdict('pass')]), [login], [], sink).act(
    'Type "hunter2"',
  );

  const file = sink.attachments[0];
  const attached = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}') as {
    steps: { description: string }[];
  };
  // The instruction itself still carries the text, the way the act step title does.
  expect(attached.steps[0]?.description).toBe(
    'Fill secure-text-field "password" with 7 hidden characters.',
  );
  expect(sink.steps.map((one) => one.title)).toContain('type 7 characters');
});

test('back is the system button on Android and the in-app control on iOS', async () => {
  const android = loadScreen('android-home');
  const backs: string[] = [];
  const session = {
    name: 's',
    options: { platform: 'android', actionTimeout: 5000 },
    run: <T>(body: (device: SessionDevice) => Promise<T>) =>
      body({
        capture: () => Promise.resolve(android),
        back: (mode: string) => {
          backs.push(mode);
          return Promise.resolve({ settled: true, waitedMs: 0 });
        },
      } as unknown as SessionDevice),
  } as unknown as DeviceSession;

  await withAi(
    {} as Device,
    session,
    createRecordingSink(),
    undefined,
    scripted([verdict('back'), verdict('pass')]),
  ).act('Go back');

  expect(backs).toEqual(['system']);
});

test('a tap whose ref went stale is skipped and the loop captures again', async () => {
  const performed: Performed[] = [];
  const session = fakeSession([login], performed);
  const one = await session.run((device) => Promise.resolve(device));
  let attempts = 0;
  one.tap = () => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(
        new TouchpressError({
          kind: 'driver',
          command: 'press',
          failure: { kind: 'stale-ref', detail: 'gone' },
        }),
      );
    }
    return Promise.resolve({ settled: true, waitedMs: 0 });
  };
  const device = withAi(
    {} as Device,
    session,
    createRecordingSink(),
    undefined,
    scripted([taps('Continue'), taps('Continue'), verdict('pass')]),
  );

  await expect(device.act('Continue twice')).resolves.toContain('satisfied');
  expect(attempts).toBe(2);
});

test('quoted text may be empty or span lines, and curly quotes count', () => {
  expect(quotedInputs('Clear the field with "" then type "line one\nline two" and “done”')).toEqual(
    {
      text1: '',
      text2: 'line one\nline two',
      text3: 'done',
    },
  );
});

test('a model that never answers is an ai-timeout naming act and the instruction', async () => {
  const hanging = new Experimental_EvaluationMockModelV4({
    provider: 'typesafe-ai',
    doEvaluate: (call: Call) =>
      new Promise<Result>((_resolve, reject) => {
        call.abortSignal?.addEventListener('abort', () =>
          reject(call.abortSignal?.reason as Error),
        );
      }),
  });
  const device = aiDevice(hanging, [login]);

  await expect(device.act('Sign in', { timeout: 30 })).rejects.toMatchObject({
    info: {
      kind: 'ai-timeout',
      command: 'act',
      asked: 'Sign in',
      instruction: 'Sign in',
      timeoutMs: 30,
    },
  });
});

test('act without any model names both keys', async () => {
  const device = aiDevice(undefined, [login]);

  await expect(device.act('Sign in')).rejects.toMatchObject({
    message: expect.stringContaining('use.evaluationModel') as unknown,
  });
});

test("an 'ai' without experimental_evaluate names the version the evaluation model needs", async () => {
  const installed = await import('ai');
  vi.doMock('ai', () => ({ ...installed, experimental_evaluate: undefined }));
  vi.resetModules();
  const decide = await import('../src/ai/decide.ts');

  const error = await decide
    .runDecideAct({
      model: scripted([verdict('pass')]),
      device: {
        capture: () => Promise.resolve(login),
      } as unknown as SessionDevice,
      sink: silentSink,
      instruction: 'Sign in',
      platform: 'ios',
      maxSteps: 5,
      timeout: 10_000,
      actionTimeout: 1000,
      attempt: 1,
    })
    .catch((thrown: unknown) => thrown);

  // `resetModules` gives this call its own copy of errors.ts, so the class identity is a
  // different one and the name is what identifies the error.
  expect((error as TouchpressError).name).toBe('TouchpressError');
  expect((error as TouchpressError).info).toEqual({ kind: 'ai-evaluate-unsupported' });
  expect((error as TouchpressError).message).toContain('7.0.103');

  vi.doUnmock('ai');
  vi.resetModules();
});

test('null in test.use turns the evaluation model off for that file and act runs on aiModel again', async () => {
  const device = withAi({} as Device, fakeSession([login]), createRecordingSink(), undefined, null);

  await expect(device.act('Sign in')).rejects.toMatchObject({
    info: { kind: 'ai-not-configured' },
  });
});

test('a fill whose ref went stale is skipped the way a stale tap is', async () => {
  const performed: Performed[] = [];
  const session = fakeSession([login], performed);
  const one = await session.run((device) => Promise.resolve(device));
  let attempts = 0;
  one.fill = () => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(
        new TouchpressError({
          kind: 'driver',
          command: 'fill',
          failure: { kind: 'stale-ref', detail: 'gone' },
        }),
      );
    }
    return Promise.resolve({ settled: true, waitedMs: 0 });
  };
  const device = withAi(
    {} as Device,
    session,
    createRecordingSink(),
    undefined,
    scripted([
      fills('email', 'rob@example.com'),
      fills('email', 'rob@example.com'),
      verdict('pass'),
    ]),
  );

  await expect(device.act('Type "rob@example.com" twice')).resolves.toContain('satisfied');
  expect(attempts).toBe(2);
});

test('a covered field still fails the fill, since the field is the target rather than a label for one', async () => {
  const session = fakeSession([login]);
  const one = await session.run((device) => Promise.resolve(device));
  one.fill = () =>
    Promise.reject(
      new TouchpressError({
        kind: 'driver',
        command: 'fill',
        failure: { kind: 'covered', detail: 'by a sheet' },
      }),
    );
  const device = withAi(
    {} as Device,
    session,
    createRecordingSink(),
    undefined,
    scripted([fills('email', 'rob@example.com')]),
  );

  await expect(device.act('Type "rob@example.com"')).rejects.toMatchObject({
    info: { kind: 'driver', failure: { kind: 'covered' } },
  });
});

test('need_input is offered only on a screen with a field to type into', () => {
  const withField = offeredMoves(login, {}).offered.map((one) => one.id);
  const withoutField = offeredMoves(home, {}).offered.map((one) => one.id);

  expect(withField).toContain('need_input');
  expect(withoutField, 'the home screen has buttons and no field').not.toContain('need_input');
  expect(withoutField.slice(0, 9)).toEqual([
    'pass',
    'fail',
    'incomplete',
    'wait',
    'back',
    'scroll_up',
    'scroll_down',
    'scroll_left',
    'scroll_right',
  ]);
});

test('a hittable, named text is offered as a tap, since a sign-in sheet shows its field as one before it exists', () => {
  const sheet = parseScreen(
    {
      nodes: [
        {
          ref: 'e1',
          index: 0,
          type: 'StaticText',
          label: 'Enter your email',
          identifier: 'clerk.auth.start.identifier',
          enabled: true,
          hittable: true,
        },
        {
          ref: 'e2',
          index: 1,
          type: 'StaticText',
          label: 'Welcome! Sign in to continue',
          enabled: true,
          hittable: false,
        },
        { ref: 'e3', index: 2, type: 'StaticText', label: 'or', enabled: true },
      ],
    },
    'ios',
  );

  const descriptions = offeredMoves(sheet, {}).offered.map((one) => one.description);

  expect(descriptions).toContain('Tap text "Enter your email" at @e1.');
  expect(descriptions.some((one) => one.includes('Welcome!'))).toBe(false);
  expect(descriptions.some((one) => one.includes('"or"'))).toBe(false);
});
