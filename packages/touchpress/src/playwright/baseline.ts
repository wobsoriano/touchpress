import type { TestInfo } from '@playwright/test';
import type { BaselinePolicy } from '../core/screenshot-assertion.ts';

type UpdateSnapshots = TestInfo['config']['updateSnapshots'];

/**
 * Playwright's `updateSnapshots` setting on the two axes core reads. Reading
 * down a column is how you check the behaviour survived the move into core.
 *
 * | updateSnapshots | onMissing        | onMismatch           |
 * | --------------- | ---------------- | -------------------- |
 * | `'all'`         | `write-and-pass` | `overwrite-and-pass` |
 * | `'changed'`     | `write-and-fail` | `overwrite-and-pass` |
 * | `'missing'`     | `write-and-pass` | `fail`               |
 * | `'none'`        | `write-and-fail` | `fail`               |
 *
 * Never `fail` on a missing baseline: Playwright writes the actual whatever the
 * mode, so the author has a file to review.
 */
const RULES: Record<UpdateSnapshots, BaselinePolicy> = {
  all: { onMissing: 'write-and-pass', onMismatch: 'overwrite-and-pass' },
  changed: { onMissing: 'write-and-fail', onMismatch: 'overwrite-and-pass' },
  missing: { onMissing: 'write-and-pass', onMismatch: 'fail' },
  none: { onMissing: 'write-and-fail', onMismatch: 'fail' },
};

export function playwrightBaseline(update: UpdateSnapshots): BaselinePolicy {
  return RULES[update];
}

/**
 * The path comes from `testInfo.snapshotPath`, so `snapshotPathTemplate`, the
 * per-project suffix and the platform suffix behave the way they do for
 * Playwright's own screenshot assertion.
 */
export function baselinePath(info: TestInfo, name: string | null): string {
  return info.snapshotPath(name ?? defaultName(info), { kind: 'screenshot' });
}

/**
 * Numbers an unnamed screenshot per test, so two assertions in one test do not
 * write over each other's baseline. A retried test gets a fresh `TestInfo`, so
 * the numbering starts again and the same run reproduces the same paths.
 */
const ordinals = new WeakMap<TestInfo, number>();

/**
 * The describe path is part of the name, the way Playwright's own screenshot
 * assertion names its baselines, so two blocks each holding a test called
 * "shot" do not write over one baseline. The first element is the file, which
 * `snapshotPath` already places the baseline under.
 */
export function defaultName(info: TestInfo): string {
  const next = (ordinals.get(info) ?? 0) + 1;
  ordinals.set(info, next);
  const slug = info.titlePath
    .slice(1)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}-${String(next)}.png`;
}
