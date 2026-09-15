import { resolve } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { vitestBaseline } from '../src/vitest/baseline.ts';
import { endedUnexpectedly } from '../src/vitest/fixtures.ts';
import { workerSlot } from '../src/vitest/options.ts';
import {
  baselinePath,
  defaultName,
  testOutputDir,
  type TestIdentity,
} from '../src/vitest/paths.ts';

const identity: TestIdentity = {
  filepath: '/repo/e2e/screenshot.spec.mts',
  projectName: 'ios',
  titlePath: ['outer', 'shot'],
  retry: 0,
};

test("Vitest's three update states land on the two axes core reads", () => {
  expect(vitestBaseline('all')).toEqual({
    onMissing: 'write-and-pass',
    onMismatch: 'overwrite-and-pass',
  });
  expect(vitestBaseline('new')).toEqual({ onMissing: 'write-and-pass', onMismatch: 'fail' });
  expect(vitestBaseline('none')).toEqual({ onMissing: 'fail', onMismatch: 'fail' });
});

test("a baseline sits next to the spec under Playwright's default template", () => {
  expect(baselinePath('home.png', identity)).toBe(
    `/repo/e2e/screenshot.spec.mts-snapshots/home-ios-${process.platform}.png`,
  );
  expect(baselinePath('home', identity)).toBe(
    `/repo/e2e/screenshot.spec.mts-snapshots/home-ios-${process.platform}.png`,
  );
  expect(baselinePath('home.png', { ...identity, projectName: '' })).toBe(
    `/repo/e2e/screenshot.spec.mts-snapshots/home-${process.platform}.png`,
  );
});

test('an unnamed baseline carries its describe path and an ordinal', () => {
  expect(defaultName(identity, 1)).toBe('outer-shot-1.png');
  expect(defaultName({ ...identity, titlePath: ['inner', 'shot'] }, 2)).toBe('inner-shot-2.png');
});

test('the output directory is one per test attempt, keyed on the retry', () => {
  expect(testOutputDir('touchpress-results', identity)).toBe(
    resolve('touchpress-results', 'screenshot-outer-shot-ios'),
  );
  expect(testOutputDir('/out', { ...identity, retry: 1 })).toBe(
    '/out/screenshot-outer-shot-ios-retry1',
  );
  expect(testOutputDir('/out', { ...identity, projectName: '', titlePath: ['Sign in!'] })).toBe(
    '/out/screenshot-sign-in',
  );
});

test('the worker slot is the 1-based pool id made 0-based, and 0 when unset', () => {
  expect(workerSlot({ VITEST_POOL_ID: '1' })).toBe(0);
  expect(workerSlot({ VITEST_POOL_ID: '3' })).toBe(2);
  expect(workerSlot({})).toBe(0);
  expect(workerSlot({ VITEST_POOL_ID: 'x' })).toBe(0);
});

test('a test ended unexpectedly when its failure disagrees with test.fails', () => {
  expect(endedUnexpectedly({ result: { state: 'fail' } })).toBe(true);
  expect(endedUnexpectedly({ result: { state: 'pass' } })).toBe(false);
  expect(endedUnexpectedly({ result: { state: 'fail' }, fails: true })).toBe(false);
  expect(endedUnexpectedly({ result: { state: 'pass' }, fails: true })).toBe(true);
  expect(endedUnexpectedly({})).toBe(false);
});
