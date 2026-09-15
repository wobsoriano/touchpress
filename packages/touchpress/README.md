# touchpress

> [!WARNING]
> This codebase was largely written by an LLM, supervised by a human maintainer. It is highly experimental. Use at your own risk.

touchpress runs e2e tests for mobile apps on the Playwright test runner or on Vitest. It drives a booted simulator or emulator through [`agent-device`](https://agent-device.dev/). The spec below is the same under either runner, apart from the import line.

```ts
import { expect, test } from 'touchpress/playwright';

test('the right credentials land on the profile', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');
  await device.getByTestId('password').fill('hunter2', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();

  await expect(device.getByTestId('signing-in')).toBeVisible();
  await expect(device.getByTestId('profile-email')).toHaveText('rob@example.com', { exact: true });
});

test('open sign in with AI', async ({ device }) => {
  test.setTimeout(180_000);
  await device.act('Open the sign-in screen');
  await expect(device.getByTestId('login')).toBeVisible();
});
```

## Usage

### Install

Pick a runner. Both are optional peer dependencies, so a project installs only the one it uses.

```sh
pnpm add -D touchpress @playwright/test   # import from 'touchpress/playwright'
pnpm add -D touchpress vitest             # import from 'touchpress/vitest'
```

### Configure

Set `app` to your app's bundle ID or package name and `readyWhen` to a locator visible once it has loaded. Under Playwright the keys go in `use`. Under Vitest they go in `provide`.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress/playwright';

export default defineConfig<TouchpressOptions>({
  testDir: 'e2e',
  workers: 1,
  use: {
    app: 'com.example.app',
    readyWhen: { testId: 'home' },
  },
  projects: [
    { name: 'ios', use: { platform: 'ios', deviceName: 'iPhone 17 Pro Max' } },
    { name: 'android', use: { platform: 'android', deviceName: 'Pixel 7 API 34' } },
  ],
});
```

```ts
// vitest.config.ts
/// <reference types="touchpress/vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.spec.ts'],
    provide: { app: 'com.example.app', readyWhen: { testId: 'home' } },
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    projects: [
      {
        extends: true,
        test: { name: 'ios', provide: { platform: 'ios', deviceName: 'iPhone 17 Pro Max' } },
      },
      {
        extends: true,
        test: { name: 'android', provide: { platform: 'android', deviceName: 'Pixel 7 API 34' } },
      },
    ],
  },
});
```

### Run

Install your app on a booted simulator or emulator, save your tests in `e2e/`, then run:

```sh
npx playwright test --project=ios
npx playwright test --project=android
```

```sh
npx vitest run --project=ios
npx vitest run --project=android
```

## Sample project

See [apps/e2e](https://github.com/wobsoriano/touchpress/tree/main/apps/e2e#building-and-running) for an Expo app with tests and setup instructions.

## Docs

- [Basics](https://github.com/wobsoriano/touchpress/blob/main/docs/basics.md)
- [Configuration](https://github.com/wobsoriano/touchpress/blob/main/docs/configuration.md)
- [Locators](https://github.com/wobsoriano/touchpress/blob/main/docs/locators.md)
- [Assertions](https://github.com/wobsoriano/touchpress/blob/main/docs/assertions.md)
- [AI](https://github.com/wobsoriano/touchpress/blob/main/docs/ai.md)
- [Lifecycle](https://github.com/wobsoriano/touchpress/blob/main/docs/lifecycle.md)
- [Continuous integration](https://github.com/wobsoriano/touchpress/blob/main/docs/ci.md)

## License

MIT
