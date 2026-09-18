import { expect, test, vi } from 'vite-plus/test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { withAi } from '../src/ai/device.ts';
import { runExtract } from '../src/ai/extract.ts';
import type { Device } from '../src/core/device.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { silentSink } from '../src/core/report.ts';
import type { DeviceSession } from '../src/core/session.ts';
import { createRecordingSink } from './fake-driver.ts';

const USAGE = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

/** Derived from the mock's own constructor, so the provider spec is never restated here. */
type Script = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doGenerate']
>;
type Turn = Extract<Script, readonly unknown[]>[number];

function answering(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (): Promise<Turn> =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
  });
}

function systemText(model: MockLanguageModelV4): string {
  const call = model.doGenerateCalls[0];
  const system = call?.prompt.find((message) => message.role === 'system');
  return system === undefined ? '' : String(system.content);
}

test('extract validates the answer against the schema and reports the question', async () => {
  const sink = createRecordingSink();

  const answer = await runExtract({
    model: answering('{"signedIn":true,"reason":"the greeting names Rob"}'),
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
  const model = answering('{"signedIn":true}');

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

test('act and extract name the model keys when no model is configured', async () => {
  const session = { name: 'touchpress-ai-0', options: { platform: 'ios' } } as DeviceSession;
  const device = withAi({} as Device, session, silentSink, undefined, undefined);

  await expect(device.act('sign in')).rejects.toThrow(/use\.aiModel/);
  await expect(device.extract('signed in?', z.object({ ok: z.boolean() }))).rejects.toThrow(
    /use\.aiModel/,
  );
});

test("a missing 'ai' package names the install command rather than failing to resolve a module", async () => {
  vi.doMock('ai', () => {
    throw new Error("Cannot find package 'ai'");
  });
  vi.resetModules();
  const { loadAi } = await import('../src/ai/sdk.ts');

  // `resetModules` gives this call its own copy of errors.ts, so the class identity is a
  // different one and the name is what identifies the error.
  const error = await loadAi().catch((thrown: unknown) => thrown);
  expect((error as TouchpressError).name).toBe('TouchpressError');
  expect((error as TouchpressError).info).toEqual({ kind: 'ai-missing-peer' });
  expect((error as TouchpressError).message).toContain('pnpm add -D ai');

  vi.doUnmock('ai');
  vi.resetModules();
});
