/**
 * `touchpress/playwright`. What the root entry exported before the split, and
 * the only entry that names Playwright.
 *
 * `defineConfig` is not re-exported. A config imports it from `@playwright/test`
 * and parameterizes it with `TouchpressOptions` from here, which keeps this
 * package from wrapping something it adds nothing to.
 */

export { setupTest, test } from './fixtures.ts';
export { expect } from './expect.ts';
export type { MatcherOptions, TextMatcherOptions } from './expect.ts';

/** Everything the root entry exports, so a spec file needs one import line. */
export * from '../index.ts';
