# Configuration

Touchpress adds its own keys to Playwright's `use`. They are parsed once at worker start and nothing downstream validates them again, so a mistake fails immediately and names the key to fix.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress';

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
| `deviceName`        | first booted   | device name. An array is a pool indexed by Playwright's `parallelIndex`                 |
| `cloud`             | none           | run on a hosted device. `'browserstack'`, `'aws-device-farm'`, or `'limrun'`            |
| `launchUrl`         | none           | a deep link to launch the app with, on the launch and on every relaunch                 |
| `relaunch`          | `'per-test'`   | or `'per-worker'`                                                                       |
| `onDeviceInUse`     | `'fail'`       | or `'reclaim'`. Leftovers carrying touchpress's own prefix are always reclaimed         |
| `settleQuietMs`     | `500`          | the quiet window that ends the post-action settle                                       |
| `launchTimeout`     | `90_000`       | budget for the launch plus the ready gate                                               |
| `dismissDevOverlay` | `false`        | send `react-native dismiss-overlay` after every launch                                  |
| `evidence`          | `'on-failure'` | `'always'` or `'off'`                                                                   |
| `sessionPrefix`     | `'touchpress'` | session names are `${prefix}-${project}-${parallelIndex}`                               |

## Running on a hosted device

`cloud` moves a project off the local simulator or emulator and onto a hosted device. It is one key holding the whole target, so a project swaps providers in a single write and two providers can never merge into one. Credentials stay out of the config, because agent-device reads them from the environment.

```ts
use: {
  platform: 'android',
  deviceName: 'Google Pixel 8',
  cloud: { provider: 'browserstack', app: 'bs://a1b2c3', osVersion: '14.0' },
}
```

What `deviceName` selects, what preflight can check, and which local behaviours stop applying all depend on the provider. See [Cloud devices](https://github.com/wobsoriano/touchpress/blob/main/docs/cloud.md).

## How long one action waits

Touchpress adds no option for that. It reads `use.actionTimeout`, which Playwright already defines, and falls back to 10_000 milliseconds when it is unset or zero. Zero means "no timeout" to Playwright, and here it would mean giving up at once.

```ts
use: { app: 'com.example.app', readyWhen: { testId: 'home' }, actionTimeout: 15_000 }
```

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

To run more than one worker, give `deviceName` an array with one entry per worker.

```ts
use: { platform: 'ios', deviceName: ['iPhone 17 Pro', 'iPhone 17 Pro Max'] }
```

## Timeouts

`expect.timeout` is what every matcher uses unless the call passes its own `{ timeout }`. `timeout` is Playwright's per-test budget, and it needs room for a relaunch plus a ready gate on every test after the first. `launchTimeout` covers only the launch and the gate, and it is charged to touchpress's own fixtures rather than to the test, so a slow launch reads as a launch failure rather than a test timeout.
