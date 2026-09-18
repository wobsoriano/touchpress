import { expect as base, type ExpectMatcherState } from '@playwright/test';
import type { Device, Locator } from '../core/device.ts';
import type { Check, CheckName } from '../core/checks.ts';
import { textMatch } from '../core/query.ts';
import { assertScreenshot, type ScreenshotOptions } from './screenshot.ts';

export type MatcherOptions = { timeout?: number };
export type TextMatcherOptions = MatcherOptions & { exact?: boolean };

type MatcherResult = {
  pass: boolean;
  message: () => string;
  name: string;
  expected: string;
  actual: string | null;
};

/**
 * `this.timeout` is `expect.timeout` from the Playwright config. `this.isNot`
 * selects the predicate the poll waits for, which is what makes
 * `.not.toBeVisible()` wait for a control to leave instead of passing on a race.
 */
async function runCheck(
  state: ExpectMatcherState,
  locator: Locator,
  check: Check,
  timeout: number | undefined,
): Promise<MatcherResult> {
  const result = await locator.expect(check, {
    negate: state.isNot,
    timeoutMs: timeout ?? state.timeout,
  });
  return {
    pass: result.pass,
    name: check.name,
    expected: result.expected,
    actual: result.actual,
    message: () => result.message,
  };
}

function retrying(
  name: Extract<CheckName, 'toBeVisible' | 'toBeEnabled' | 'toBeSelected' | 'toBeFocused'>,
) {
  return function (
    this: ExpectMatcherState,
    locator: Locator,
    options?: MatcherOptions,
  ): Promise<MatcherResult> {
    return runCheck(this, locator, { name }, options?.timeout);
  };
}

/**
 * Playwright's own matcher names on this package's `expect` only. Matcher
 * typing is by the first parameter, so these surface on `expect(locator)` and
 * nothing else.
 */
export const expect = base.extend({
  toBeVisible: retrying('toBeVisible'),
  toBeEnabled: retrying('toBeEnabled'),
  toBeSelected: retrying('toBeSelected'),
  toBeFocused: retrying('toBeFocused'),

  toHaveText(
    this: ExpectMatcherState,
    locator: Locator,
    expected: string | RegExp,
    options?: TextMatcherOptions,
  ) {
    return runCheck(
      this,
      locator,
      { name: 'toHaveText', expected: textMatch(expected, options?.exact) },
      options?.timeout,
    );
  },

  // Whole-string, like Playwright's own `toHaveValue`. A field's value is not prose to search.
  toHaveValue(
    this: ExpectMatcherState,
    locator: Locator,
    expected: string | RegExp,
    options?: MatcherOptions,
  ) {
    return runCheck(
      this,
      locator,
      { name: 'toHaveValue', expected: textMatch(expected, true) },
      options?.timeout,
    );
  },

  toHaveCount(
    this: ExpectMatcherState,
    locator: Locator,
    expected: number,
    options?: MatcherOptions,
  ) {
    return runCheck(this, locator, { name: 'toHaveCount', expected }, options?.timeout);
  },

  toHaveScreenshot(
    this: ExpectMatcherState,
    target: Device | Locator,
    nameOrOptions?: string | ScreenshotOptions,
    options?: ScreenshotOptions,
  ) {
    return assertScreenshot(this, target, nameOrOptions, options);
  },

  // The one matcher a model decides. It polls a probability rather than a predicate, so it takes a threshold.
});
