# touchpress

> [!WARNING]
> This codebase was largely written by an LLM, supervised by a human maintainer. It is highly experimental. Use at your own risk.

touchpress runs e2e tests for mobile apps on the Playwright test runner. It drives a booted simulator or emulator, or a hosted device on BrowserStack, AWS Device Farm, or Limrun, through [`agent-device`](https://agent-device.dev/).

```ts
import { expect, test } from 'touchpress';

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

```sh
pnpm add -D touchpress @playwright/test
```

### Configure

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress';

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

Set `app` to your app's bundle ID or package name and `readyWhen` to a locator visible once it has loaded.

### Run

Install your app on a booted simulator or emulator, save your tests in `e2e/`, then run:

```sh
npx playwright test --project=ios
npx playwright test --project=android
```

## Sample project

See [apps/e2e](https://github.com/wobsoriano/touchpress/tree/main/apps/e2e#building-and-running) for an Expo app with tests and setup instructions.

## Docs

- [Basics](https://github.com/wobsoriano/touchpress/blob/main/docs/basics.md)
- [Configuration](https://github.com/wobsoriano/touchpress/blob/main/docs/configuration.md)
- [Cloud devices](https://github.com/wobsoriano/touchpress/blob/main/docs/cloud.md)
- [Locators](https://github.com/wobsoriano/touchpress/blob/main/docs/locators.md)
- [Assertions](https://github.com/wobsoriano/touchpress/blob/main/docs/assertions.md)
- [AI](https://github.com/wobsoriano/touchpress/blob/main/docs/ai.md)
- [Lifecycle](https://github.com/wobsoriano/touchpress/blob/main/docs/lifecycle.md)
- [Continuous integration](https://github.com/wobsoriano/touchpress/blob/main/docs/ci.md)

## License

MIT
