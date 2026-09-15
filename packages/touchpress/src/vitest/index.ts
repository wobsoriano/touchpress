/**
 * `touchpress/vitest`.
 *
 * ```ts
 * import { expect, test } from 'touchpress/vitest';
 *
 * test('the signed-out home screen offers a way in', async ({ device }) => {
 *   await expect(device.getByRole('button', { name: 'Sign in' })).toBeEnabled();
 * });
 * ```
 *
 * Importing this module registers the eight matchers on Vitest's `expect` and
 * the `ProvidedContext` augmentation for `provide`. There is no `setupTest`.
 * Vitest has no setup-project graph, so `preflight` runs from `globalSetup`.
 *
 * `defineConfig` is not re-exported. A config imports it from `vitest/config`.
 */

export { expect } from './expect.ts';
export type {
  DeviceAssertion,
  LocatorAssertion,
  MatcherOptions,
  TextMatcherOptions,
  TouchpressExpect,
} from './expect.ts';

export { test } from './fixtures.ts';
export type { TouchpressFixtures } from './fixtures.ts';

export type { VitestOptions } from './options.ts';

/** Everything the root entry exports, so a spec file needs one import line. */
export * from '../index.ts';
