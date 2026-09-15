# Cloud devices

A project runs on a local simulator or emulator by default. Set `use.target.provider` and it runs on a hosted device instead, on BrowserStack App Automate, AWS Device Farm, or Limrun.

`target` is one key rather than one key per field. A project replaces the whole target in a single write, and Playwright's per-key `use` merge can never blend two providers.

Credentials never appear in the config. agent-device reads them from the environment itself.

## BrowserStack App Automate

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { TouchpressOptions } from 'touchpress';

export default defineConfig<TouchpressOptions>({
  testDir: 'e2e',
  use: {
    app: 'com.example.app',
    readyWhen: { testId: 'home' },
  },
  projects: [
    {
      name: 'android',
      use: {
        platform: 'android',
        target: {
          provider: 'browserstack',
          name: 'Google Pixel 8',
          app: 'bs://a1b2c3d4e5f6',
          osVersion: '14.0',
          project: 'checkout',
          build: process.env.GITHUB_RUN_ID,
        },
      },
    },
  ],
});
```

`target.app` is a `bs://` reference, an HTTP(S) URL, or a local path. BrowserStack uploads a local path when it creates the session. `use.app` stays the bundle id or package name, because that is what launches the installed build.

`target.name` is required and has to match a BrowserStack device name exactly.

Environment: `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`.

The rest of the options are optional. `sessionName` names the session in the BrowserStack dashboard, `orientation` is `'portrait'` or `'landscape'`, and `geoLocation`, `timezone`, `language`, and `locale` set what the hosted device reports. `networkProfile` names one of BrowserStack's profiles and `customNetwork` describes one of your own. Setting both is a config error. `noResignApp` tells BrowserStack to leave the signature on the build alone.

## AWS Device Farm

```ts
{
  name: 'ios',
  use: {
    platform: 'ios',
    target: {
      provider: 'aws-device-farm',
      projectArn: process.env.AWS_DEVICE_FARM_PROJECT_ARN!,
      deviceArn: process.env.AWS_DEVICE_FARM_DEVICE_ARN!,
      appArn: process.env.AWS_DEVICE_FARM_APP_ARN!,
      region: 'us-west-2',
    },
  },
}
```

`target.name` must not be set. `target.deviceArn` names the device.

AWS cannot install an app after it has allocated the device, so the build has to be in Device Farm already. Upload it and pass its ARN as `appArn`.

Environment: the AWS CLI credential chain, which covers `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, named profiles, and web identity. The region comes from `target.region`, `AWS_REGION`, or `AWS_DEFAULT_REGION`.

`interactionMode` is `'INTERACTIVE'`, `'NO_VIDEO'`, or `'VIDEO_ONLY'`.

## Limrun

```ts
{
  name: 'android',
  use: {
    platform: 'android',
    target: { provider: 'limrun', install: './build/app.apk' },
  },
}
```

Limrun creates a fresh simulator or emulator on the first device command, so it takes no device selector at all. `target.name` must not be set.

A fresh instance carries no app. `target.install` is the local path or URL of the artifact, and touchpress installs it before the worker's first launch. Every relaunch after that launches the installed build.

Environment: `LIMRUN_API_KEY`, and `LIMRUN_REGION` if you want a region other than the default.

## What preflight checks

`preflight` never contacts the provider for a hosted target. Listing devices against one can allocate the session the lease defers, so a check meant to run before the suite would start the run it is checking.

What it does check is the environment agent-device will read.

| provider          | checked                                            | not checked                                   |
| ----------------- | -------------------------------------------------- | --------------------------------------------- |
| `browserstack`    | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` | whether the device name and OS version exist  |
| `aws-device-farm` | a region from `target.region` or the environment   | the credentials, which the AWS chain resolves |
| `limrun`          | `LIMRUN_API_KEY`                                   | quota and availability                        |

Anything the provider rejects surfaces on the first launch instead.

## What differs from local

One BrowserStack device name serves every worker. Each worker opens its own hosted session on that device model, so the local rule of one device per worker does not apply. A pool still works if you want different models per worker.

`device.clearKeychain()` does nothing on a hosted device. It shells out to `xcrun simctl`, which reaches a simulator on this machine and nothing else. The session records a note saying so rather than failing.

`clearState` and the per-test relaunch depend on the provider honouring agent-device's `clear-app-state` and `open --relaunch`. This library's authors have not verified that against any provider.

Provider artifacts are not surfaced yet. Video and device logs stay with the provider. Run `agent-device artifacts --json` after the run to collect them.
