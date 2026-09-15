import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';
import { defineContract } from '../adapter-contract.ts';
import { driver, expect, opens, outputDir, screenshots, sessionOpens, test } from './harness.ts';

const here = fileURLToPath(import.meta.url);

// Vitest orders spec files as it likes, so what this file asserts is the delta it caused. A
// file that runs first pays the session open and a later one pays a relaunch, one `open` either way.
let opensBefore = 0;
beforeAll(() => {
  opensBefore = opens();
});

test('the first test costs one open, on the one session this worker holds', async ({
  device,
  task,
}) => {
  expect(sessionOpens()).toBe(1);
  expect(opens()).toBe(opensBefore + 1);
  expect(task.file.projectName).toBe('vitest-adapter');
  const started = Date.now();
  await expect(device.getByText('Sign out'))
    .toBeVisible()
    .catch(() => undefined);
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(400);
  expect(waited).toBeLessThan(1500);
});

test('the second test relaunches on the way in, on the same session', () => {
  expect(sessionOpens()).toBe(1);
  expect(opens()).toBe(opensBefore + 2);
});

defineContract({ test, expect });

test('the typed expect keeps Vitest statics and plain values intact', async () => {
  expect(typeof expect.soft).toBe('function');
  expect(typeof expect.poll).toBe('function');
  expect(typeof expect.extend).toBe('function');
  expect({ a: 1 }).toEqual({ a: 1 });
  await expect(Promise.reject(new Error('nope'))).rejects.toThrow('nope');
});

test('a matcher on something that is not a locator names the mistake', async () => {
  await expect(expect({} as never).toBeVisible()).rejects.toThrow(
    /toBeVisible expects a touchpress locator, received an object/,
  );
});

const failingDir = (title: string) =>
  join(outputDir, `contract-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-vitest-adapter`);

test('a matcher that never holds attaches the trail and the screen before it rejects', async ({
  device,
  task,
}) => {
  const error = await expect(device.getByText('Sign out'))
    .toBeVisible({ timeout: 100 })
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('Expected toBeVisible but it never held.');
  expect(task.annotations.map((note) => [note.message, note.type])).toEqual([
    ['steps.txt', 'attachment'],
    ['screen.png', 'attachment'],
    ['screen.txt', 'attachment'],
  ]);
  const dir = failingDir(task.name);
  expect(screenshots()).toContain(join(dir, 'screen.png'));
  expect(task.annotations[0]?.attachment?.body).toMatch(/^relaunch com\.example\.app {2}\d+ms$/);
  expect(task.annotations[2]?.attachment?.body).toContain('@e14 [text] "GET STARTED"');
  const before = screenshots().length;
  await expect(device.getByText('Sign out'))
    .toBeVisible({ timeout: 50 })
    .catch(() => undefined);
  expect(screenshots().length).toBe(before);
});

test('an action that never finds its target attaches evidence before it throws', async ({
  device,
  task,
}) => {
  const error = await device
    .getByText('Sign out')
    .tap({ timeout: 100 })
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(Error);
  expect(task.annotations.map((note) => note.message)).toEqual([
    'steps.txt',
    'screen.png',
    'screen.txt',
  ]);
  expect(task.annotations[0]?.attachment?.body).toContain("tap getByText('Sign out') (threw)");
});

let attemptsBefore = 0;

test('a failure touchpress never saw leaves its evidence on disk, and a retry reuses the session', async ({
  task,
}) => {
  const retry = task.result?.retryCount ?? 0;
  if (retry === 0) {
    attemptsBefore = opens();
    throw new Error('a plain failure');
  }
  expect(retry).toBe(1);
  expect(opens()).toBe(attemptsBefore + 1);
  expect(sessionOpens()).toBe(1);
  const first = failingDir(task.name);
  expect(screenshots()).toContain(join(first, 'screen.png'));
  expect(existsSync(join(first, 'screen.png'))).toBe(true);
  expect(readFileSync(join(first, 'screen.txt'), 'utf8')).toContain('@e14 [text] "GET STARTED"');
  expect(readFileSync(join(first, 'steps.txt'), 'utf8')).toMatch(/^relaunch com\.example\.app/);
  expect(task.annotations).toEqual([]);
});

let screenshotsBeforeExpectedFailure = 0;

test.fails('an expected failure ends as expected', async ({ device }) => {
  screenshotsBeforeExpectedFailure = screenshots().length;
  await expect(device.getByText('Sign out')).toBeVisible({ timeout: 100 });
});

test('an expected failure attaches nothing', () => {
  expect(screenshots().length).toBe(screenshotsBeforeExpectedFailure);
});

test('an unnamed screenshot writes its baseline next to the spec on the first run and matches on the second', async ({
  device,
}) => {
  const snapshots = join(dirname(here), 'contract.test.ts-snapshots');
  rmSync(snapshots, { recursive: true, force: true });
  try {
    await expect(device).toHaveScreenshot();
    const written = join(
      snapshots,
      `an-unnamed-screenshot-writes-its-baseline-next-to-the-spec-on-the-first-run-and-matches-on-the-second-1-vitest-adapter-${process.platform}.png`,
    );
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written).equals(driver.png ?? Buffer.alloc(0))).toBe(true);
    await expect(device)
      .not.toHaveScreenshot({ timeout: 100 })
      .catch((thrown: unknown) => {
        expect(thrown).toBeInstanceOf(Error);
        expect(String(thrown)).toContain('there is no baseline to differ from');
      });
    await expect(device.getByRole('button', { name: 'Explore' })).toHaveScreenshot('explore.png');
    expect(existsSync(join(snapshots, `explore-vitest-adapter-${process.platform}.png`))).toBe(
      true,
    );
  } finally {
    rmSync(snapshots, { recursive: true, force: true });
  }
});
