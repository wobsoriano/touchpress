import { existsSync } from 'node:fs';
import path from 'node:path';
import { anthropic } from '@ai-sdk/anthropic';
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress';

// AI_MODEL and the provider key live in a gitignored .env next to this file on a developer machine
// and in the workflow's secrets on CI, so the file is optional.
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// An Anthropic key makes AI_MODEL a bare Anthropic id. Without one, AI_MODEL is a gateway id
// such as anthropic/claude-haiku-4-5, resolved against AI_GATEWAY_API_KEY.
const modelId = process.env['AI_MODEL'];
const aiModel =
  modelId === undefined || process.env['ANTHROPIC_API_KEY'] === undefined
    ? modelId
    : anthropic(modelId);

// The device names are overridable because CI boots whatever model its runner image carries, which
// is not the one on a developer's machine. Preflight turns a mismatch into one readable failure.
const ios = {
  platform: 'ios',
  target: { name: process.env['TOUCHPRESS_IOS_DEVICE'] ?? 'iPhone 17 Pro Max' },
} as const;
const android = {
  platform: 'android',
  target: { name: process.env['TOUCHPRESS_ANDROID_DEVICE'] ?? 'Expo API 36' },
} as const;

export default defineConfig<TouchpressOptions>({
  // The specs are .mts because Playwright transpiles the workspace-linked library as source, and
  // that CommonJS output cannot require agent-device. A published install keeps plain .ts specs.
  testDir: 'e2e',
  // The deliberate-failure spec stays out of the default run. Include it with TOUCHPRESS_INCLUDE_FAILING=1.
  testIgnore: process.env['TOUCHPRESS_INCLUDE_FAILING'] === '1' ? [] : ['**/failing.spec.mts'],
  workers: 1,
  // A second line of defense on a shared runner, not the fix. Playwright replaces the worker after
  // a failure and the replacement reuses the slot, so a retry reclaims the same device and session.
  retries: process.env['CI'] ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    app: 'dev.touchpress.e2e',
    readyWhen: { testId: 'home' },
    aiModel,
  },
  projects: [
    // One setup project per platform, off the same spec. A Playwright setup project has a single
    // `use`, so a shared one could only ever gate on one platform's device.
    { name: 'setup-ios', testMatch: /preflight\.setup\.mts/, use: ios },
    { name: 'setup-android', testMatch: /preflight\.setup\.mts/, use: android },
    { name: 'ios', dependencies: ['setup-ios'], use: ios },
    { name: 'android', dependencies: ['setup-android'], use: android },
  ],
});
