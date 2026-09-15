import type { AiOptions } from '../ai/options.ts';
import type { ReadyQuery, TouchpressOptions } from '../core/config.ts';
import type { Platform } from '../core/screen.ts';

/**
 * What a `vitest.config.ts` provides. Vitest has no `use` block, so the config
 * seam is `provide` and every key is an injected fixture with the same default
 * core falls back to. Three keys join `TouchpressOptions` because Playwright's
 * config supplied them for free and Vitest's does not.
 */
export type VitestOptions = TouchpressOptions &
  AiOptions & {
    /** @default 10_000. The whole budget for one action, target wait and settle together. */
    actionTimeout: number;
    /** @default 5_000. What a matcher waits when the call passes no `{ timeout }`. Playwright's own default. */
    expectTimeout: number;
    /**
     * @default 'touchpress-results'. Resolved against the working directory.
     * Attachments and per-test screenshots land in one directory per test
     * attempt under it, the way Playwright's `outputDir` works.
     */
    outputDir: string;
  };

/**
 * Only the structured-clone serializable keys. A non-serializable provided
 * value aborts the whole run at startup, so a model object comes in through
 * `test.extend({ aiModel })` in the spec that needs it, never through
 * `provide`. TypeScript checks the value of a key it knows here and does not
 * flag one it does not, so this catches a wrong type rather than a typo.
 */
declare module 'vitest' {
  interface ProvidedContext {
    platform?: Platform;
    app?: string;
    readyWhen?: ReadyQuery;
    deviceName?: string | readonly string[];
    launchUrl?: string;
    relaunch?: 'per-test' | 'per-worker';
    onDeviceInUse?: 'fail' | 'reclaim';
    settleQuietMs?: number;
    launchTimeout?: number;
    dismissDevOverlay?: boolean;
    evidence?: 'on-failure' | 'always' | 'off';
    sessionPrefix?: string;
    actionTimeout?: number;
    expectTimeout?: number;
    outputDir?: string;
    /** A model id only, such as `'anthropic/claude-haiku-4-5'`. A provider instance goes through `test.extend({ aiModel })`. */
    aiModel?: string;
  }
}

/**
 * `VITEST_POOL_ID` is 1-based and stable per slot, which makes it the
 * `parallelIndex` equivalent. `VITEST_WORKER_ID` is a per-process counter
 * whose base differs between Vitest 4 and 5, so it is never read.
 */
export function workerSlot(env: Record<string, string | undefined> = process.env): number {
  const id = Number(env['VITEST_POOL_ID']);
  return Number.isInteger(id) && id >= 1 ? id - 1 : 0;
}
