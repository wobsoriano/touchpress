# Configuration

Touchpress adds its own keys to the runner's config. Under Playwright they go in `use`, under Vitest in `provide`. They are parsed once at worker start and nothing downstream validates them again, so a mistake fails immediately and names the key to fix.

## Playwright

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress/playwright';

export default defineConfig<TouchpressOptions>({
  testDir: 'e2e',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    app: 'com.example.app',
    readyWhen: { testId: 'home' },
  },
  projects: [
    {
      name: 'setup-ios',
      testMatch: /preflight\.setup\.mts/,
      use: { platform: 'ios', deviceName: 'iPhone 17 Pro Max' },
    },
    {
      name: 'setup-android',
      testMatch: /preflight\.setup\.mts/,
      use: { platform: 'android', deviceName: 'ci-api34' },
    },
    {
      name: 'ios',
      dependencies: ['setup-ios'],
      use: { platform: 'ios', deviceName: 'iPhone 17 Pro Max' },
    },
    {
      name: 'android',
      dependencies: ['setup-android'],
      use: { platform: 'android', deviceName: 'ci-api34' },
    },
  ],
});
```

## Every key merges on its own

Playwright merges `use` one key at a time, and each of touchpress's options is a key of its own. What the projects share goes at the top level and a project sets only what differs. `app` and `readyWhen` above are written once.

A test reads those keys too, which is how a spec gates itself on the platform it is running against.

```ts
test.skip(({ platform }) => platform === 'android', 'iOS keychain prompt');
```

A skipped test opens no session, because touchpress's `device` fixture is never set up for it.

## Options

| key                 | default        | meaning                                                                                 |
| ------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `platform`          | required       | `'ios'` or `'android'`                                                                  |
| `app`               | required       | bundle id or package name, never a path to an artifact                                  |
| `readyWhen`         | required       | the locator that means the bundle loaded. `{ text }`, `{ testId }`, or `{ role, name }` |
| `deviceName`        | first booted   | device name. An array is a pool indexed by the worker slot                              |
| `launchUrl`         | none           | a deep link to launch the app with, on the launch and on every relaunch                 |
| `relaunch`          | `'per-test'`   | or `'per-worker'`                                                                       |
| `onDeviceInUse`     | `'fail'`       | or `'reclaim'`. Leftovers carrying touchpress's own prefix are always reclaimed         |
| `settleQuietMs`     | `500`          | the quiet window that ends the post-action settle                                       |
| `launchTimeout`     | `90_000`       | budget for the launch plus the ready gate                                               |
| `dismissDevOverlay` | `false`        | send `react-native dismiss-overlay` after every launch                                  |
| `evidence`          | `'on-failure'` | `'always'` or `'off'`                                                                   |
| `sessionPrefix`     | `'touchpress'` | session names are `${prefix}-${project}-${slot}`                                        |

## How long one action waits

Under Playwright, touchpress adds no option for that. It reads `use.actionTimeout`, which Playwright already defines, and falls back to 10_000 milliseconds when it is unset or zero. Zero means "no timeout" to Playwright, and here it would mean giving up at once.

```ts
use: { app: 'com.example.app', readyWhen: { testId: 'home' }, actionTimeout: 15_000 }
```

Under Vitest, `actionTimeout` is a touchpress key with the same default, because Vitest defines none. See [Vitest](#vitest).

The value is the whole budget for one action, so waiting for the target and waiting for the screen to go quiet afterwards share it.

## Launching through a deep link

`launchUrl` opens the app with a URL rather than plainly, on the worker's launch and on every relaunch after it. Leave it unset for a release build, which has nothing to deep link into.

An Expo development client needs it. That build is a shell around a server picker, so launching it plainly lands on its own "DEVELOPMENT SERVERS" list rather than on your app, and the ready gate times out reporting that screen. The URL that skips the picker names the Metro server to load.

```ts
use: {
  app: 'com.example.app',
  readyWhen: { text: 'Welcome' },
  launchUrl: 'com.example.app://expo-development-client/?url=http://localhost:8081',
}
```

The scheme has to be one only the app under test registers. An Expo app registers its `scheme` from `app.json` as well as its bundle id, and the `scheme` is the one a second build of the same app also claims. Two builds claiming it means the system picks which one receives the link, and it may not be the one `app` names, so the bundle id is the safer scheme. `xcrun simctl listapps <udid>` lists what is installed if you need to check.

`localhost` works against a simulator, which shares the host's network. A physical device needs the host's address on the LAN.

## `readyWhen` is required

The driver returns from a launch as soon as the native process starts. The JavaScript bundle is still loading at that point, so the first assertion of the first test would race it. `readyWhen` names something that only appears once the bundle has rendered, and touchpress holds until it resolves.

Ambiguity is still ready. The gate asks whether the bundle loaded, not whether a locator is unique.

## One device per worker

`deviceName` as a string, or `deviceName` omitted, serves worker slot 0 only. Two workers pointed at one device would both try to claim it, and because leftovers carrying touchpress's own prefix are always reclaimed, the second worker would close the first worker's live session mid-test. That is a configuration error rather than a race, and it fails at worker start.

To run more than one worker, give `deviceName` an array with one entry per worker. The slot is Playwright's `parallelIndex` or Vitest's `VITEST_POOL_ID` less one, both of which a replacement worker reuses.

```ts
use: { platform: 'ios', deviceName: ['iPhone 17 Pro', 'iPhone 17 Pro Max'] }
```

## Timeouts

`expect.timeout` is what every matcher uses unless the call passes its own `{ timeout }`. `timeout` is Playwright's per-test budget, and it needs room for a relaunch plus a ready gate on every test after the first. `launchTimeout` covers only the launch and the gate, and it is charged to touchpress's own fixtures rather than to the test, so a slow launch reads as a launch failure rather than a test timeout.

## Vitest

The same keys go in `provide`, and `touchpress/vitest` turns every one of them into a worker fixture with the same default. A spec reads a key off its context the way it reads `device`, and `inject` reads one at module scope, which is how a spec gates itself on the platform.

```ts
// vitest.config.ts
/// <reference types="touchpress/vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.spec.ts'],
    provide: {
      app: 'com.example.app',
      readyWhen: { testId: 'home' },
      expectTimeout: 10_000,
    },
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'ios',
          provide: { platform: 'ios', deviceName: 'iPhone 17 Pro Max' },
          globalSetup: 'e2e/preflight.ios.ts',
        },
      },
      {
        extends: true,
        test: {
          name: 'android',
          provide: { platform: 'android', deviceName: 'ci-api34' },
          globalSetup: 'e2e/preflight.android.ts',
        },
      },
    ],
  },
});
```

```ts
import { inject } from 'vitest';

test.skipIf(inject('platform') === 'android')('iOS keychain prompt', async ({ device }) => {});
```

The reference directive types `provide` against touchpress's keys without running anything at config time, so a wrong value is a type error. A key it does not know passes through, which catches a wrong type rather than a typo.

### Projects

One project per platform, selected with `--project=ios` or `--project=android`. `extends: true` makes a project inherit the root `test` block, which is what puts `provide`, `include` and the timeouts in every project without repeating them. Without it a project starts empty. The project name is part of the session name, so two projects never share one.

### One worker, one session

The session lives in the worker's module registry. `isolate: false` keeps that registry across spec files, so the run opens one session and every later test relaunches on it. `fileParallelism: false` keeps two files from fighting over one device. `maxWorkers: 1` matches the one device a string `deviceName` serves. A pool is an array, one entry per worker, and each worker takes the entry at `VITEST_POOL_ID` less one.

A different `provide` per spec file is not supported. The session is keyed by project name, so the first file's options are the ones the worker keeps.

### Timeouts

Vitest bills a fixture's setup to the test that triggered it. The first test in a worker pays the launch and the ready gate, and every later one pays a relaunch, all inside `testTimeout`. Size it for the launch. Playwright bills those to its fixtures instead, which is why its per-test `timeout` can be smaller.

### The three Vitest-only keys

Playwright's config supplies these for free and Vitest's does not, so they are touchpress keys here.

| key             | default                | meaning                                                                              |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `actionTimeout` | `10_000`               | the whole budget for one action, target wait and settle together                     |
| `expectTimeout` | `5_000`                | what a matcher waits when the call passes no `{ timeout }`. Playwright's own default |
| `outputDir`     | `'touchpress-results'` | where per-test files land, resolved against the working directory                    |

Under `outputDir` each test attempt gets one directory, `<spec>-<title>[-<project>][-retry<N>]`, the shape of Playwright's own output directory.

### `aiModel`

`provide` carries only what structured clone can, so `aiModel` in the config is a gateway model id string. A provider instance goes through `test.extend` in the spec that needs it. [AI](ai.md) shows both.

### Preflight

Vitest has no setup project, so `preflight` runs from a `globalSetup` file, one per project, before any worker starts.

```ts
// e2e/preflight.ios.ts
import { preflight } from 'touchpress';

export async function setup(): Promise<void> {
  const report = await preflight({
    platform: 'ios',
    app: 'com.example.app',
    readyWhen: { testId: 'home' },
    deviceName: 'iPhone 17 Pro Max',
  });
  if (report.ok) return;
  throw new Error(report.problems.join('\n'));
}
```

Keep the device names in one module the config and the setup files both import, so the device a project provides and the one its preflight checks cannot drift. The sample app does that in `e2e-vitest/devices.ts`.
