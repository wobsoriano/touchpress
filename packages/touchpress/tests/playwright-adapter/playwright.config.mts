import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from '../../src/playwright/index.ts';

/** A real Playwright run over the fake driver, spawned by `tests/playwright-adapter.test.ts`. */
export default defineConfig<TouchpressOptions>({
  testDir: '.',
  testMatch: /adapter\.spec\.mts/,
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 7000 },
  reporter: [['json']],
  use: {
    app: 'com.example.app',
    readyWhen: { text: 'GET STARTED' },
    settleQuietMs: 20,
    actionTimeout: 500,
  },
  projects: [{ name: 'fake', use: { platform: 'ios' } }],
});
