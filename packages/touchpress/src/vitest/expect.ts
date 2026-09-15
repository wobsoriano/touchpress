import { expect as vitestExpect, type ExpectStatic, type MatcherState } from 'vitest';
import type { Check, CheckName } from '../core/checks.ts';
import { DEFAULT_EXPECT_TIMEOUT_MS } from '../core/config.ts';
import type { Device, Locator } from '../core/device.ts';
import type { ProbeResult } from '../core/probe.ts';
import { textMatch } from '../core/query.ts';
import { assertScreenshot, type ScreenshotOptions } from '../core/screenshot-assertion.ts';
import { vitestBaseline } from './baseline.ts';
import { baselinePath, defaultName } from './paths.ts';
import { runningFor, runningOf, type RunningTest } from './running.ts';

export type MatcherOptions = { timeout?: number };
export type TextMatcherOptions = MatcherOptions & { exact?: boolean };

type MatcherResult = {
  pass: boolean;
  message: () => string;
  actual: string | null;
  expected: string;
};

/**
 * The one mapping in this adapter. Core renders every message and this only
 * reshapes it. A result that fails the assertion, which is `pass === negate`
 * the way `probe` reports one, attaches its evidence here, before the
 * rejection, because Vitest refuses an annotation once the body has ended.
 */
async function toMatcherResult(
  result: ProbeResult,
  negate: boolean,
  current: RunningTest | undefined,
): Promise<MatcherResult> {
  if (result.pass === negate) await current?.failed();
  return {
    pass: result.pass,
    expected: result.expected,
    actual: result.actual,
    message: () => result.message,
  };
}

function isLocator(value: unknown): value is Locator {
  return typeof value === 'object' && value !== null && 'query' in value && 'device' in value;
}

function isDevice(value: unknown): value is Device {
  return (
    typeof value === 'object' && value !== null && 'getByTestId' in value && 'options' in value
  );
}

/** `expect.extend` registers globally, so a wrong receiver is a real possibility and names itself. */
function locatorOf(received: unknown, name: string): Locator {
  if (isLocator(received)) return received;
  throw new TypeError(`${name} expects a touchpress locator, received ${describe(received)}.`);
}

function targetOf(received: unknown, name: string): Device | Locator {
  if (isLocator(received) || isDevice(received)) return received;
  throw new TypeError(
    `${name} expects the device or a touchpress locator, received ${describe(received)}.`,
  );
}

function describe(value: unknown): string {
  return value === null ? 'null' : typeof value === 'object' ? 'an object' : typeof value;
}

/**
 * A Vitest matcher's `this` carries no timeout, so the budget comes off the
 * running test that built the target. `this.isNot` selects the predicate the
 * poll waits for, which is what makes `.not.toBeVisible()` wait for a control
 * to leave. It is chai's `negate` flag, which is `undefined` rather than
 * `false` on a plain assertion, so it is read as a strict boolean here and
 * nowhere else.
 */
function negated(state: MatcherState): boolean {
  return state.isNot === true;
}

async function runCheck(
  state: MatcherState,
  received: unknown,
  check: Check,
  timeout: number | undefined,
): Promise<MatcherResult> {
  const locator = locatorOf(received, check.name);
  const negate = negated(state);
  const current = runningOf(locator);
  const result = await locator.expect(check, {
    negate,
    timeoutMs: timeout ?? current?.expectTimeout ?? DEFAULT_EXPECT_TIMEOUT_MS,
  });
  return toMatcherResult(result, negate, current);
}

function retrying(
  name: Extract<CheckName, 'toBeVisible' | 'toBeEnabled' | 'toBeSelected' | 'toBeFocused'>,
) {
  return function (
    this: MatcherState,
    received: unknown,
    options?: MatcherOptions,
  ): Promise<MatcherResult> {
    return runCheck(this, received, { name }, options?.timeout);
  };
}

/**
 * Registered on Vitest's global `expect`, because `expect.extend` mutates in
 * place and cannot do otherwise. That is what gives a matcher `this.isNot` and
 * `this.snapshotState`. The typed `expect` below is what keeps the eight names
 * off unrelated values.
 */
vitestExpect.extend({
  toBeVisible: retrying('toBeVisible'),
  toBeEnabled: retrying('toBeEnabled'),
  toBeSelected: retrying('toBeSelected'),
  toBeFocused: retrying('toBeFocused'),

  toHaveText(
    this: MatcherState,
    received: unknown,
    expected: string | RegExp,
    options?: TextMatcherOptions,
  ) {
    return runCheck(
      this,
      received,
      { name: 'toHaveText', expected: textMatch(expected, options?.exact) },
      options?.timeout,
    );
  },

  // Whole-string, like Playwright's own `toHaveValue`. A field's value is not prose to search.
  toHaveValue(
    this: MatcherState,
    received: unknown,
    expected: string | RegExp,
    options?: MatcherOptions,
  ) {
    return runCheck(
      this,
      received,
      { name: 'toHaveValue', expected: textMatch(expected, true) },
      options?.timeout,
    );
  },

  toHaveCount(this: MatcherState, received: unknown, expected: number, options?: MatcherOptions) {
    return runCheck(this, received, { name: 'toHaveCount', expected }, options?.timeout);
  },

  async toHaveScreenshot(
    this: MatcherState,
    received: unknown,
    nameOrOptions?: string | ScreenshotOptions,
    extra?: ScreenshotOptions,
  ) {
    const target = targetOf(received, 'toHaveScreenshot');
    const options = (typeof nameOrOptions === 'string' ? extra : nameOrOptions) ?? {};
    const current = runningFor(target);
    const negate = negated(this);
    const name =
      typeof nameOrOptions === 'string'
        ? nameOrOptions
        : defaultName(current.test, (current.screenshots += 1));
    const result = await assertScreenshot({
      target,
      baseline: baselinePath(name, current.test),
      options,
      negate,
      timeoutMs: options.timeout ?? current.expectTimeout,
      policy: vitestBaseline(this.snapshotState.snapshotUpdateState),
      sink: current.sink,
    });
    return toMatcherResult(result, negate, current);
  },
});

export type LocatorAssertion = {
  toBeVisible(options?: MatcherOptions): Promise<void>;
  toBeEnabled(options?: MatcherOptions): Promise<void>;
  toBeSelected(options?: MatcherOptions): Promise<void>;
  toBeFocused(options?: MatcherOptions): Promise<void>;
  toHaveText(expected: string | RegExp, options?: TextMatcherOptions): Promise<void>;
  toHaveValue(expected: string | RegExp, options?: MatcherOptions): Promise<void>;
  toHaveCount(expected: number, options?: MatcherOptions): Promise<void>;
  toHaveScreenshot(
    nameOrOptions?: string | ScreenshotOptions,
    options?: ScreenshotOptions,
  ): Promise<void>;
  readonly not: LocatorAssertion;
};

export type DeviceAssertion = {
  toHaveScreenshot(
    nameOrOptions?: string | ScreenshotOptions,
    options?: ScreenshotOptions,
  ): Promise<void>;
  readonly not: DeviceAssertion;
};

/**
 * Vitest's `expect`, typed by its first parameter the way the Playwright entry
 * is. The eight matchers surface on a touchpress locator or on the device, and
 * every other value gets Vitest's own assertions. The value is Vitest's
 * `expect` with its statics, so `expect.soft`, `expect.poll` and
 * `expect.extend` are the same functions a spec would import from `vitest`.
 */
export type TouchpressExpect = {
  (actual: Locator): LocatorAssertion;
  (actual: Device): DeviceAssertion;
} & ExpectStatic;

export const expect = Object.assign(
  (actual: unknown) => vitestExpect(actual),
  vitestExpect,
) as TouchpressExpect;
