import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createVitestSink, renderTrail } from '../src/vitest/sink.ts';

type Annotation = { message: string; type: string; attachment?: unknown };

function harness() {
  const annotations: Annotation[] = [];
  const outputDir = mkdtempSync(join(tmpdir(), 'touchpress-sink-'));
  const sink = createVitestSink({
    context: {
      annotate: (message, type, attachment) => {
        annotations.push({ message, type, attachment });
        return Promise.resolve();
      },
    },
    test: {
      filepath: '/repo/e2e/login.spec.ts',
      projectName: 'ios',
      titlePath: ['signs in'],
      retry: 0,
    },
    outputDir,
  });
  return { sink, annotations, outputDir };
}

test('steps are buffered into an indented trail and never annotated', async () => {
  const { sink, annotations } = harness();
  expect(sink.trail()).toBe(null);
  const value = await sink.step('tap Sign in', async () => {
    await sink.step('relaunch app', () => Promise.resolve());
    return 42;
  });
  await sink.step('fill Email', () => Promise.reject(new Error('gone'))).catch(() => undefined);
  expect(value).toBe(42);
  expect(annotations).toEqual([]);
  expect(sink.trail()).toMatch(
    /^tap Sign in {2}\d+ms\n {2}relaunch app {2}\d+ms\nfill Email \(threw\) {2}\d+ms$/,
  );
});

test('a step propagates its rejection unchanged', async () => {
  const { sink } = harness();
  const error = new Error('gone');
  await expect(sink.step('tap', () => Promise.reject(error))).rejects.toBe(error);
});

test('attachments and notes become annotations, and notes settle later', async () => {
  const { sink, annotations } = harness();
  await sink.attach({ name: 'screen.txt', body: 'listing', contentType: 'text/plain' });
  await sink.attach({ name: 'screen.png', path: '/tmp/screen.png', contentType: 'image/png' });
  sink.note('device', 'iPhone (ios)');
  await sink.settle();
  expect(annotations).toEqual([
    {
      message: 'screen.txt',
      type: 'attachment',
      attachment: { body: 'listing', contentType: 'text/plain' },
    },
    {
      message: 'screen.png',
      type: 'attachment',
      attachment: { path: '/tmp/screen.png', contentType: 'image/png' },
    },
    { message: 'iPhone (ios)', type: 'device', attachment: undefined },
  ]);
});

test('the output path lives in one directory per test, created on first use', () => {
  const { sink, outputDir } = harness();
  const dir = join(outputDir, 'login-signs-in-ios');
  expect(existsSync(dir)).toBe(false);
  expect(sink.outputPath('screen.png')).toBe(join(dir, 'screen.png'));
  expect(existsSync(dir)).toBe(true);
});

test('renderTrail is one line per step', () => {
  expect(
    renderTrail([
      { depth: 0, title: 'clear state', outcome: 'ok', durationMs: 12 },
      { depth: 1, title: 'relaunch', outcome: 'ok', durationMs: 10 },
    ]),
  ).toBe('clear state  12ms\n  relaunch  10ms');
});
