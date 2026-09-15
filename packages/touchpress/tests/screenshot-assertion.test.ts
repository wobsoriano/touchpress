import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, test } from 'vite-plus/test';
import { parseDeviceOptions } from '../src/core/config.ts';
import { createDevice, type Device, type Locator } from '../src/core/device.ts';
import { silentSink } from '../src/core/report.ts';
import { sizeOf, type PixelBox } from '../src/core/screenshot.ts';
import { assertScreenshot, type BaselinePolicy } from '../src/core/screenshot-assertion.ts';
import { openSession } from '../src/core/session.ts';
import { createFakeDriver, createRecordingSink, type FakeDriver } from './fake-driver.ts';

type Colour = readonly [number, number, number];
const WHITE: Colour = [255, 255, 255];
const RED: Colour = [255, 0, 0];

/** The home fixture's window is 440 wide, so an image this wide crops at scale 1. */
const WIDTH = 440;
const HEIGHT = 956;

function solid(colour: Colour): Buffer {
  return withPatch({ x: 0, y: 0, width: WIDTH, height: HEIGHT }, colour, PNG.sync.write(blank()));
}

function withPatch(box: PixelBox, [red, green, blue]: Colour, source = solid(WHITE)): Buffer {
  const image = PNG.sync.read(source);
  for (let row = box.y; row < box.y + box.height; row += 1) {
    for (let column = box.x; column < box.x + box.width; column += 1) {
      const at = (image.width * row + column) << 2;
      image.data[at] = red;
      image.data[at + 1] = green;
      image.data[at + 2] = blue;
      image.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

function blank(): PNG {
  const image = new PNG({ width: WIDTH, height: HEIGHT });
  image.data.fill(255);
  return image;
}

const record: BaselinePolicy = { onMissing: 'write-and-pass', onMismatch: 'overwrite-and-pass' };
const review: BaselinePolicy = { onMissing: 'write-and-fail', onMismatch: 'fail' };
const readOnly: BaselinePolicy = { onMissing: 'fail', onMismatch: 'fail' };

type Harness = {
  readonly driver: FakeDriver;
  readonly device: Device;
  readonly sink: ReturnType<typeof createRecordingSink>;
  readonly baseline: string;
};

async function harness(png: Buffer): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'touchpress-screenshot-'));
  const driver = createFakeDriver();
  driver.png = png;
  const session = await openSession({
    options: parseDeviceOptions({
      platform: 'ios',
      app: 'com.example.app',
      readyWhen: { text: 'GET STARTED' },
    }),
    slot: 0,
    scope: 'ios',
    sink: silentSink,
    createDriver: () => driver,
  });
  const recording = createRecordingSink();
  const sink = { ...recording, outputPath: (name: string) => join(dir, name) };
  return {
    driver,
    device: createDevice(session, sink),
    sink,
    baseline: join(dir, 'baselines', 'home.png'),
  };
}

function assert(
  run: Harness,
  policy: BaselinePolicy,
  overrides?: { negate?: boolean; target?: Locator; timeoutMs?: number },
) {
  return assertScreenshot({
    target: overrides?.target ?? run.device,
    baseline: run.baseline,
    options: {},
    negate: overrides?.negate ?? false,
    timeoutMs: overrides?.timeoutMs ?? 300,
    policy,
    sink: run.sink,
  });
}

function attached(run: Harness): string[] {
  return run.sink.attachments.map((file) => file.name);
}

test('a missing baseline under write-and-pass is written and passes', async () => {
  const run = await harness(solid(WHITE));
  const result = await assert(run, record);
  expect(result).toEqual({
    pass: true,
    expected: 'at most 1% of pixels to differ',
    actual: null,
    message: '',
  });
  expect(readFileSync(run.baseline).equals(solid(WHITE))).toBe(true);
});

test('a missing baseline under write-and-fail is written and fails at once', async () => {
  const run = await harness(solid(WHITE));
  const result = await assert(run, review);
  expect(result.pass).toBe(false);
  expect(result.message).toContain(`A snapshot doesn't exist at ${run.baseline}, writing actual.`);
  expect(existsSync(run.baseline)).toBe(true);
  expect(attached(run)).toEqual([]);
});

test('a missing baseline under fail leaves the tree alone and attaches the capture', async () => {
  const run = await harness(solid(WHITE));
  const result = await assert(run, readOnly);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('may not write one');
  expect(existsSync(run.baseline)).toBe(false);
  expect(attached(run)).toEqual(['actual.png']);
});

test('not.toHaveScreenshot with no baseline fails whatever the policy, and writes nothing', async () => {
  const run = await harness(solid(WHITE));
  const result = await assert(run, record, { negate: true });
  expect(result.pass).toBe(true);
  expect(result.message).toContain('there is no baseline to differ from');
  expect(existsSync(run.baseline)).toBe(false);
});

test('a capture matching its baseline passes on the first capture', async () => {
  const run = await harness(solid(WHITE));
  await assert(run, record);
  const result = await assert(run, review);
  expect(result).toEqual({
    pass: true,
    expected: 'at most 1% of pixels to differ',
    actual: '0% of pixels differ',
    message: '',
  });
});

test('a mismatch under fail keeps capturing until the deadline, then attaches all three images', async () => {
  const run = await harness(solid(WHITE));
  await assert(run, record);
  run.driver.png = withPatch({ x: 20, y: 20, width: 200, height: 200 }, RED);
  const result = await assert(run, review);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('Expected toHaveScreenshot but it never matched.');
  expect(result.message).toContain(`Baseline: ${run.baseline}`);
  expect(result.message).toMatch(/Timeout: 300ms \([2-9] captures\)/);
  expect(attached(run)).toEqual(['expected.png', 'actual.png', 'diff.png']);
});

test('a mismatch under overwrite-and-pass accepts the new pixels as the baseline', async () => {
  const run = await harness(solid(WHITE));
  await assert(run, record);
  const changed = withPatch({ x: 20, y: 20, width: 200, height: 200 }, RED);
  run.driver.png = changed;
  const result = await assert(run, record);
  expect(result.pass).toBe(true);
  expect(readFileSync(run.baseline).equals(changed)).toBe(true);
});

test('not.toHaveScreenshot passes at once on a mismatch and never overwrites', async () => {
  const run = await harness(solid(WHITE));
  await assert(run, record);
  run.driver.png = withPatch({ x: 20, y: 20, width: 200, height: 200 }, RED);
  const result = await assert(run, record, { negate: true });
  expect(result.pass).toBe(false);
  expect(result.message).toBe('');
  expect(readFileSync(run.baseline).equals(solid(WHITE))).toBe(true);
  expect(attached(run)).toEqual([]);
});

test('not.toHaveScreenshot on a matching capture waits out the deadline and says it never differed', async () => {
  const run = await harness(solid(WHITE));
  await assert(run, record);
  const result = await assert(run, review, { negate: true });
  expect(result.pass).toBe(true);
  expect(result.message).toContain('Expected not.toHaveScreenshot but it never differed.');
});

test('a locator target is cropped out of the same capture the tree came from', async () => {
  const run = await harness(withPatch({ x: 216, y: 877, width: 94, height: 54 }, RED));
  const target = run.device.getByRole('button', { name: 'Explore' });
  const result = await assert(run, record, { target });
  expect(result.pass).toBe(true);
  expect(sizeOf(readFileSync(run.baseline))).toEqual({ width: 94, height: 54 });
});

test('a locator that never resolves fails after the deadline and names why', async () => {
  const run = await harness(solid(WHITE));
  const result = await assert(run, record, { target: run.device.getByText('Sign out') });
  expect(result.pass).toBe(false);
  expect(result.actual).toBe(null);
  expect(result.message).toContain('the locator never resolved');
  expect(result.message).toContain('Received: no node matched');
  expect(existsSync(run.baseline)).toBe(false);
});
