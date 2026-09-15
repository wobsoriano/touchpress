/// <reference types="touchpress/vitest" />
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { android, app, ios, readyWhen } from './e2e-vitest/devices';

// AI_MODEL and the provider key live in a gitignored .env next to this file on a developer machine
// and in the workflow's secrets on CI, so the file is optional.
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// `provide` carries only what structured clone can. A gateway id such as anthropic/claude-haiku-4-5
// rides here, and an Anthropic provider instance is built in ai.spec.mts through `test.extend`.
const aiModel =
  process.env['ANTHROPIC_API_KEY'] === undefined ? process.env['AI_MODEL'] : undefined;

export default defineConfig({
  test: {
    include: ['e2e-vitest/**/*.spec.mts'],
    exclude: process.env['TOUCHPRESS_INCLUDE_FAILING'] === '1' ? [] : ['**/failing.spec.mts'],
    provide: { app, readyWhen, expectTimeout: 10_000, aiModel },
    // One device, one session, one worker. The session lives in the worker's module registry,
    // so isolating files would open a session per file.
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    // The first test in a worker pays the launch and the ready gate, and every later one pays a
    // relaunch, all inside the test's own budget. Playwright bills those to its fixtures instead.
    testTimeout: 180_000,
    // A retry reuses the worker's session.
    retry: process.env['CI'] ? 1 : 0,
    projects: [
      {
        extends: true,
        test: { name: 'ios', provide: ios, globalSetup: 'e2e-vitest/preflight.ios.ts' },
      },
      {
        extends: true,
        test: { name: 'android', provide: android, globalSetup: 'e2e-vitest/preflight.android.ts' },
      },
    ],
  },
});
