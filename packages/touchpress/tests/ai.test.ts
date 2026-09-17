import { expect, test, vi } from 'vite-plus/test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { withAi } from '../src/ai/device.ts';
import { runAct, runExtract } from '../src/ai/act.ts';
import {
  compactResult,
  compactSnapshot,
  createDeviceTools,
  wrapDeviceTool,
} from '../src/ai/tools.ts';
import type { Device } from '../src/core/device.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { silentSink } from '../src/core/report.ts';
import type { DeviceSession } from '../src/core/session.ts';
import { createRecordingSink } from './fake-driver.ts';
import { loadRaw } from './fixtures.ts';

const USAGE = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

/** Derived from the mock's own constructor, so the provider spec is never restated here. */
type Script = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doGenerate']
>;
type Turn = Extract<Script, readonly unknown[]>[number];
type Part = Turn['content'][number];

function toolCall(id: string, name: string, input: unknown): Part {
  return { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) };
}

function done(outcome: 'completed' | 'blocked', summary: string): Part {
  return toolCall('done', 'done', { outcome, summary });
}

function turn(...content: Part[]): Turn {
  return {
    content,
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

/** The tools the model drives in these tests. Each records its call rather than reaching a device. */
function fakeTools(calls: string[]): ToolSet {
  const text = { type: 'string' } as const;
  return {
    snapshot: tool({
      description: 'snapshot the screen',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: () => {
        calls.push('snapshot');
        return Promise.resolve({ nodes: ['@a1 [button] "Sign in"'] });
      },
    }),
    press: tool({
      description: 'press a node',
      inputSchema: jsonSchema({ type: 'object', properties: { target: text } }),
      execute: (input: unknown) => {
        calls.push(`press ${String(Reflect.get(input as object, 'target'))}`);
        return Promise.resolve({ ok: true });
      },
    }),
    fill: tool({
      description: 'fill a field',
      inputSchema: jsonSchema({ type: 'object', properties: { target: text, text } }),
      execute: (input: unknown) => {
        calls.push(`fill ${String(Reflect.get(input as object, 'target'))}`);
        return Promise.resolve({ ok: true });
      },
    }),
  };
}

/**
 * The system text the model actually received. An instructions parameter the
 * installed AI SDK does not know is dropped silently rather than rejected, so
 * the prompt is the only place that proves it arrived.
 */
function systemText(model: MockLanguageModelV4): string {
  const prompt = model.doGenerateCalls[0]?.prompt ?? [];
  return prompt
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
}

function act(model: MockLanguageModelV4, sink = createRecordingSink(), maxSteps = 10) {
  const calls: string[] = [];
  const run = runAct({
    model,
    tools: fakeTools(calls),
    sink,
    instruction: 'Sign in with the email rob@example.com and the password hunter2',
    platform: 'ios',
    maxSteps,
    timeout: 30_000,
    screen: () => Promise.resolve('@a1 [button] "Sign in"'),
    attempt: 1,
  });
  return { run, calls, sink };
}

test('act reports the instruction, nests every model command under it, and returns the summary', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'snapshot', {})),
      turn(toolCall('2', 'press', { target: '@a1' })),
      turn({ type: 'text', text: 'landed on the profile' }, done('completed', 'Signed in as Rob')),
    ],
  });
  const { run, calls, sink } = act(model);

  expect(await run).toBe('Signed in as Rob');
  expect(calls).toEqual(['snapshot', 'press @a1']);
  expect(sink.steps).toEqual([
    {
      title: 'act "Sign in with the email rob@example.com and the password hunter2"',
      depth: 0,
      boxed: false,
    },
    { title: 'snapshot', depth: 1, boxed: false },
    { title: 'press @a1', depth: 1, boxed: false },
  ]);
});

test('two tool calls in one model turn reach the device one after the other', async () => {
  const order: string[] = [];
  const recording = (name: string, holdMs: number) =>
    tool({
      description: name,
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => {
        order.push(`${name} start`);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        order.push(`${name} end`);
        return { ok: true };
      },
    });
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'snapshot', {}), toolCall('2', 'press', {})),
      turn(done('completed', 'Pressed it')),
    ],
  });

  await runAct({
    model,
    tools: { snapshot: recording('snapshot', 30), press: recording('press', 0) },
    sink: silentSink,
    instruction: 'Press sign in',
    platform: 'ios',
    maxSteps: 10,
    timeout: 30_000,
    screen: () => Promise.resolve(''),
    attempt: 1,
  });

  expect(order).toEqual(['snapshot start', 'snapshot end', 'press start', 'press end']);
});

test('act tells the model how to drive the app rather than dropping its instructions', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [turn(done('completed', 'Already signed in'))],
  });
  const { run } = act(model);
  await run;

  expect(systemText(model)).toContain('snapshot');
  expect(systemText(model)).toContain('{ "kind": "ref", "ref": "@e4" }');
});

test('a fill the model ran reports the text it typed as a nested boxed step', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'fill', { target: '@email', text: 'rob@example.com' })),
      turn(done('completed', 'Filled the email field')),
    ],
  });
  const { run, sink } = act(model);
  await run;

  expect(sink.steps.slice(1)).toEqual([
    { title: 'fill @email', depth: 1, boxed: false },
    { title: 'type "rob@example.com"', depth: 2, boxed: true },
  ]);
});

test('a loop that outlives its budget fails with the instruction and the screen', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      }),
  });
  const calls: string[] = [];
  const run = runAct({
    model,
    tools: fakeTools(calls),
    sink: silentSink,
    instruction: 'Open the list',
    platform: 'ios',
    maxSteps: 10,
    timeout: 20,
    screen: () => Promise.resolve('@a1 [button] "List"'),
    attempt: 1,
  });

  const error = await run.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  expect((error as TouchpressError).info).toMatchObject({
    kind: 'ai-timeout',
    command: 'act',
    asked: 'Open the list',
    timeoutMs: 20,
  });
  expect((error as TouchpressError).message).toContain('act ran out of its 20ms budget');
  expect((error as TouchpressError).message).toContain('@a1 [button] "List"');
});

test('act attaches one transcript carrying the calls, the results, and the usage', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'snapshot', {})),
      turn(done('completed', 'Nothing to do, already signed in')),
    ],
  });
  const { run, sink } = act(model);
  await run;

  expect(sink.attachments).toHaveLength(1);
  const file = sink.attachments[0];
  expect(file?.name).toBe('ai-act-1.json');
  expect(file?.contentType).toBe('application/json');
  const transcript: unknown = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}');
  expect(transcript).toMatchObject({
    instruction: 'Sign in with the email rob@example.com and the password hunter2',
    usage: { inputTokens: 16, outputTokens: 8, totalTokens: 24 },
    steps: [
      {
        toolCalls: [{ name: 'snapshot', input: {} }],
        toolResults: [{ name: 'snapshot', output: '{"nodes":["@a1 [button] \\"Sign in\\""]}' }],
      },
      { toolCalls: [{ name: 'done', input: { outcome: 'completed' } }] },
    ],
  });
});

test('the transcript records the calls that errored, so a failing loop is readable', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'press', { target: 'e4' })),
      turn(done('completed', 'Pressed it on the second try')),
    ],
  });
  const sink = createRecordingSink();
  const run = runAct({
    model,
    tools: {
      press: tool({
        description: 'press a node',
        inputSchema: jsonSchema({ type: 'object', properties: { target: { type: 'string' } } }),
        execute: (): Promise<{ ok: true }> =>
          Promise.reject(new Error('ref "e4" is not a snapshot ref')),
      }),
    },
    sink,
    instruction: 'Press sign in',
    platform: 'ios',
    maxSteps: 10,
    timeout: 30_000,
    screen: () => Promise.resolve('@a1 [button] "Sign in"'),
    attempt: 1,
  });
  await run;

  const file = sink.attachments[0];
  const transcript: unknown = JSON.parse(file !== undefined && 'body' in file ? file.body : '{}');
  expect(transcript).toMatchObject({
    steps: [
      {
        toolCalls: [{ name: 'press', input: { target: 'e4' } }],
        toolResults: [],
        toolErrors: [
          { name: 'press', input: { target: 'e4' }, error: 'ref "e4" is not a snapshot ref' },
        ],
      },
      { toolCalls: [{ name: 'done' }] },
    ],
  });
});

test('a model that reports it is blocked fails the test rather than resolving with prose', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      turn(toolCall('1', 'snapshot', {})),
      turn(done('blocked', 'No sign-in button on this screen')),
    ],
  });
  const { run } = act(model);

  const error = await run.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  expect((error as TouchpressError).info).toMatchObject({
    kind: 'ai-blocked',
    summary: 'No sign-in button on this screen',
    screen: '@a1 [button] "Sign in"',
  });
  expect((error as TouchpressError).message).toContain('No sign-in button on this screen');
});

test('a loop that runs out of steps without calling done fails with what it managed', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: () => Promise.resolve(turn(toolCall('1', 'snapshot', {}))),
  });
  const { run } = act(model, createRecordingSink(), 3);

  const error = await run.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  expect((error as TouchpressError).info).toMatchObject({ kind: 'ai-incomplete', steps: 3 });
  expect((error as TouchpressError).message).toContain('Raise maxSteps');
});

test('extract validates the answer against the schema and reports the question', async () => {
  const sink = createRecordingSink();
  const model = new MockLanguageModelV4({
    doGenerate: (): Promise<Turn> =>
      Promise.resolve({
        content: [{ type: 'text', text: '{"signedIn":true,"reason":"the greeting names Rob"}' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
  });

  const answer = await runExtract({
    model,
    screen: '@a1 [text] "Hi, Rob"',
    question: 'Is a user signed in?',
    schema: z.object({ signedIn: z.boolean(), reason: z.string() }),
    sink,
    timeout: 10_000,
  });

  expect(answer).toEqual({ signedIn: true, reason: 'the greeting names Rob' });
  expect(sink.steps).toEqual([{ title: 'extract "Is a user signed in?"', depth: 0, boxed: false }]);
});

test('extract tells the model it is reading a tree rather than dropping its instructions', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: (): Promise<Turn> =>
      Promise.resolve({
        content: [{ type: 'text', text: '{"signedIn":true}' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
  });

  await runExtract({
    model,
    screen: '@a1 [text] "Hi, Rob"',
    question: 'Is a user signed in?',
    schema: z.object({ signedIn: z.boolean() }),
    sink: silentSink,
    timeout: 10_000,
  });

  expect(systemText(model)).toContain('accessibility tree');
});

test('act and extract name the aiModel key when no model is configured', async () => {
  const session = { name: 'touchpress-ai-0', options: { platform: 'ios' } } as DeviceSession;
  const device = withAi({} as Device, session, silentSink, undefined, undefined);

  await expect(device.act('sign in')).rejects.toThrow(/use\.aiModel/);
  await expect(device.extract('signed in?', z.object({ ok: z.boolean() }))).rejects.toThrow(
    /use\.aiModel/,
  );
});

test('the device tools are the ten that perceive and act, with no way to reach another device', async () => {
  const tools = await createDeviceTools('touchpress-ai-0', 'ios');

  expect(Object.keys(tools).sort()).toEqual([
    'alert',
    'back',
    'fill',
    'get',
    'is',
    'press',
    'scroll',
    'snapshot',
    'type',
    'wait',
  ]);

  const forbidden = ['open', 'close', 'find', 'swipe', 'click', 'screenshot'];
  for (const name of forbidden) expect(tools[name]).toBeUndefined();

  const daemonKeys = [
    'udid',
    'serial',
    'device',
    'deviceTarget',
    'daemonBaseUrl',
    'daemonAuthToken',
    'tenant',
    'runId',
    'leaseId',
    'cwd',
    'debug',
    'iosSimulatorDeviceSet',
    'iosXctestrunFile',
    'iosXctestDerivedDataPath',
    'iosXctestEnvDir',
    'androidDeviceAllowlist',
    'noRecord',
    'record',
    'saveScript',
    'stateDir',
  ];
  for (const [name, built] of Object.entries(tools)) {
    const schema = (
      built.inputSchema as { jsonSchema: { properties?: object; required?: string[] } }
    ).jsonSchema;
    const properties = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    for (const key of daemonKeys) {
      expect(properties, `${name}.${key}`).not.toContain(key);
      expect(required, `${name}.${key} required`).not.toContain(key);
    }
    // The one addressing key that survives, because a snapshot ref is how the model names a node.
    if (name === 'press' || name === 'fill') expect(required).toContain('target');
  }
});

test('the device-form target alias is cut while the UI target on press, fill, and get survives', async () => {
  const tools = await createDeviceTools('touchpress-ai-0', 'ios');

  const withUiTarget = ['press', 'fill', 'get'];
  for (const [name, built] of Object.entries(tools)) {
    const schema = (built.inputSchema as { jsonSchema: { properties?: Record<string, unknown> } })
      .jsonSchema;
    const properties = schema.properties ?? {};
    expect(Object.keys(properties), `${name}.recordAs`).not.toContain('recordAs');
    if (withUiTarget.includes(name)) {
      expect(properties['target'], name).toMatchObject({ oneOf: expect.any(Array) });
    } else {
      expect(properties, name).not.toHaveProperty('target');
    }
  }
});

test('the snapshot the model reads is the compact listing, not the raw node JSON', () => {
  const raw = {
    nodes: [
      { ref: 'e1', index: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        ref: 'e2',
        index: 1,
        parentIndex: 0,
        depth: 1,
        type: 'Button',
        label: 'Sign in',
        identifier: 'signIn',
        rect: { x: 20, y: 400, width: 350, height: 48 },
      },
    ],
  };

  expect(compactSnapshot(raw, 'ios')).toBe(
    ['@e1 [window]', '  @e2 [button] "Sign in" #signIn'].join('\n'),
  );
  expect(compactSnapshot({ ...raw, truncated: true }, 'ios')).toContain(
    'the tree is truncated, so some nodes are missing',
  );
});

test('a verbatim driver snapshot renders with the @ refs the action schemas demand', () => {
  const listing = compactSnapshot(loadRaw('ios-login'), 'ios');

  for (const line of listing.split('\n')) expect(line.trimStart()).toMatch(/^@e\d+ \[/);
  expect(listing).toContain('@e8 [button] "Continue" #continue');
  expect(JSON.stringify(loadRaw('ios-login')).length).toBeGreaterThan(listing.length * 3);
});

test('an action result keeps whether it landed and settled, and drops the settle diff', () => {
  const output = compactResult('press', {
    targetKind: 'ref',
    message: 'Pressed @e4',
    x: 195,
    y: 424,
    evidence: { screenshot: '/tmp/press.png' },
    resolution: { candidates: 7 },
    cost: { totalMs: 812 },
    settle: { settled: true, waitedMs: 240, captures: 3, diff: { added: ['@e9 [text] "Hi"'] } },
  });

  expect(output).toEqual({
    targetKind: 'ref',
    message: 'Pressed @e4',
    settle: { settled: true, waitedMs: 240 },
  });
});

test('a read command answers with what upstream returned, untrimmed', () => {
  const answer = { value: 'Hi, Rob' };
  expect(compactResult('get', answer)).toBe(answer);
});

test('a press naming a bare ref reaches the device with the @ the driver demands', async () => {
  const sent: unknown[] = [];
  const press = wrapDeviceTool(
    'press',
    'ios',
    (input) => {
      sent.push(input);
      return Promise.resolve({ targetKind: 'ref', message: 'ok' });
    },
    new Set(['target']),
  );

  await press({ target: { kind: 'ref', ref: 'e4' } }, {});
  await press({ target: { kind: 'ref', ref: '@e7' } }, {});
  await press({ target: { kind: 'point', x: 10, y: 20 } }, {});

  expect(sent).toEqual([
    { target: { kind: 'ref', ref: '@e4' } },
    { target: { kind: 'ref', ref: '@e7' } },
    { target: { kind: 'point', x: 10, y: 20 } },
  ]);
});

test('a key the pruned schema does not declare never reaches the device', async () => {
  const sent: unknown[] = [];
  const press = wrapDeviceTool(
    'press',
    'ios',
    (input) => {
      sent.push(input);
      return Promise.resolve({ targetKind: 'ref', message: 'ok' });
    },
    new Set(['target']),
  );

  await press({ target: { kind: 'ref', ref: '@e4' }, daemonBaseUrl: 'http://x', cwd: '/' }, {});

  expect(sent).toEqual([{ target: { kind: 'ref', ref: '@e4' } }]);
});

test('the snapshot the model asks for is the full tree, rendered', async () => {
  const sent: unknown[] = [];
  const snapshot = wrapDeviceTool(
    'snapshot',
    'ios',
    (input) => {
      sent.push(input);
      return Promise.resolve({ nodes: [{ ref: 'e1', index: 0, type: 'Button', label: 'List' }] });
    },
    new Set(['depth']),
  );

  expect(await snapshot({ depth: 3 }, {})).toBe('@e1 [button] "List"');
  expect(sent).toEqual([{ depth: 3, forceFull: true }]);
});

test("a missing 'ai' package names the install command rather than failing to resolve a module", async () => {
  vi.doMock('ai', () => {
    throw new Error("Cannot find package 'ai'");
  });
  vi.resetModules();
  const { loadAi } = await import('../src/ai/tools.ts');

  // `resetModules` gives this call its own copy of errors.ts, so the class identity is a
  // different one and the name is what identifies the error.
  const error = await loadAi().catch((thrown: unknown) => thrown);
  expect((error as TouchpressError).name).toBe('TouchpressError');
  expect((error as TouchpressError).info).toEqual({ kind: 'ai-missing-peer' });
  expect((error as TouchpressError).message).toContain('pnpm add -D ai');

  vi.doUnmock('ai');
  vi.resetModules();
});
