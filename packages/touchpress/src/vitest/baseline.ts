import type { BaselinePolicy } from '../core/screenshot-assertion.ts';

/** `this.snapshotState.snapshotUpdateState` on a matcher, a public getter. */
export type SnapshotUpdateState = 'all' | 'new' | 'none';

/**
 * Vitest's snapshot update state on the two axes core reads. The mirror of
 * `playwright/baseline.ts`.
 *
 * | state    | how you get it | onMissing        | onMismatch           |
 * | -------- | -------------- | ---------------- | -------------------- |
 * | `'all'`  | `vitest -u`    | `write-and-pass` | `overwrite-and-pass` |
 * | `'new'`  | default        | `write-and-pass` | `fail`               |
 * | `'none'` | `CI=true`      | `fail`           | `fail`               |
 *
 * `'new'` lands where Playwright's `'missing'` does, so a first run behaves the
 * same under either runner. `'none'` is the one deliberate divergence. Vitest
 * refuses to create a snapshot in CI for its own `toMatchSnapshot`, and a PNG
 * appearing in a CI checkout is a surprise nobody asked for, so nothing is
 * written and the capture is attached instead. That case is the whole reason
 * `MissingBaselineRule` has a third value.
 */
const RULES: Record<SnapshotUpdateState, BaselinePolicy> = {
  all: { onMissing: 'write-and-pass', onMismatch: 'overwrite-and-pass' },
  new: { onMissing: 'write-and-pass', onMismatch: 'fail' },
  none: { onMissing: 'fail', onMismatch: 'fail' },
};

export function vitestBaseline(update: SnapshotUpdateState): BaselinePolicy {
  return RULES[update];
}
