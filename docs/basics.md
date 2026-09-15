# Basics

A touchpress test is a Playwright test. You import `test` and `expect` from `touchpress` instead of from `@playwright/test`, and you get one extra fixture called `device`.

```ts
// e2e/home.spec.ts
import { expect, test } from 'touchpress';

test('the signed-out home screen offers a way in', async ({ device }) => {
  await expect(device.getByRole('text', { name: 'Welcome' })).toHaveText('Welcome', {
    exact: true,
  });
  await expect(device.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});
```

No browser is launched. `browser`, `context`, and `page` are still there because `test` extends Playwright's own, but they are lazy and nothing in touchpress names them.

## The `device` fixture

`device` is the only way into the running app. It is created fresh for every test and it is automatic, so evidence is captured even for a test that never touches it.

Three locator factories build a locator, and `device.locator()` is the escape hatch for anything they cannot express. A locator is a plain value until you await one of its methods.

```ts
device.getByText('Welcome');
device.getByRole('button', { name: 'Sign in' });
device.getByTestId('sign-in-link');
device.locator({ role: 'text-field', focused: true });
```

[Locators](locators.md) covers what each one matches and how ties are broken.

## Actions

```ts
await device.getByTestId('sign-in-link').tap();
await device.getByTestId('email').fill('rob@example.com');
await device.getByTestId('password').fill('hunter2', { secret: true });
await device.getByTestId('menu').longPress(1500);
await device.getByTestId('row-30').scrollIntoView();
await device.scroll('down');
await device.goBack();
await device.keyboard.type('123456');
await device.clearState();
await device.clearKeychain();
await device.relaunch();
await device.dismissDevOverlay();
```

Actions wait for their target the way Playwright actions do. Playwright's `use.actionTimeout` is the whole budget for one action, shared between waiting for the target and waiting for the screen to settle afterwards. Each action is one step in the list and HTML reporters.

A fill step is titled by its locator and never by the text. The value goes in a nested step, added after the node is resolved, because the node's role decides how much may be printed. A field the platform marks secure, or one filled with `{ secret: true }`, reports a count.

```
fill getByTestId('email')
  type "rob@example.com"
fill getByTestId('password')
  type 7 characters
```

`fill` reads back what it wrote. Device keyboards drop early keystrokes, and a controlled React Native input can put a stale value back over what the driver typed, so `fill` reads the field once, waits `settleQuietMs`, reads it again, and retries the whole fill until both reads hold the text or the action budget runs out. A secure field reports one mask character per character typed, so there the check is on length. Android has no secure role, so a password field there is a `text-field`, and a plain field's fill also confirms on a masked read-back of the right length. Retrying replaces rather than appends. Pacing keystrokes with the driver's per-character delay was tried and removed, because that path appends. When the budget runs out the error names the value found and the attempts made, by length for a secret.

`secret` is fill's only extra option. It hides the value from the step and from the `fill-unconfirmed` error. It does not hide what the device reports afterwards. An assertion on that field's value still prints it, and on Android a plain text field reports its contents as its accessibility name, which puts them in the screen listing. Assert on what the credential got you rather than on the credential.

`goBack()` goes back without naming a control. It presses the platform gesture on Android and the app's own navigation control on iOS, which has no system back, and `{ mode: 'in-app' }` or `{ mode: 'system' }` overrides that. The step reads `back (system)` or `back (in-app)`.

`keyboard.type(text)` types into whatever holds focus, for a field with nothing to select on. A one-time-code input the app focused for itself is the case it exists for. Nothing is read back, because there is no target to read, so a field you can name is better served by `fill`. It takes the same `{ secret: true }` as `fill` and reports a character count under it.

```ts
await device.keyboard.type('123456');
await device.keyboard.type('hunter2', { secret: true });
```

The driver refuses text whose first word looks like a node reference, a leading `@` followed by a name carrying a digit or by `ref`, `node`, `element` or `el`. touchpress refuses it first, and neither the check nor any failure raised from a type repeats the text back, so a password cannot reach a terminal or a report through this path.

`clearState()` discards the app's stored state and then relaunches, because an app still holding a cleared session in memory has not been cleared. It is Maestro's `clearState` and Detox's `launchApp({ delete: true })`.

`clearKeychain()` resets the simulator's keychain, which is where secure-storage libraries such as `expo-secure-store` keep a session. On iOS the keychain belongs to the simulator, not the app, so the reset clears what every app on it stored there. That is why it is a separate call rather than part of `clearState()`. On Android it does nothing, because clearing state already removes the app's keystore entries, and the step says so in a note. It is Maestro's `clearKeychain` and Detox's `device.clearKeychain()`. [Lifecycle](lifecycle.md) covers what each reaches on each platform.

`relaunch()` relaunches the app and waits for the ready gate again. `dismissDevOverlay()` clears the React Native development warning overlay. It is never automatic, because the overlay is a real node and hiding it by default would suppress a warning a test might want to assert on.

## Reaching a target below the fold

`tap`, `fill`, and `longPress` scroll to their own target. When a locator resolves to nothing, the action looks for the node off screen and scrolls toward it inside the same budget, so most tests never mention scrolling.

```ts
await device.getByTestId('list-done').tap();
```

`scrollIntoView()` scrolls and stops there.

```ts
const row = device.getByTestId('row-30');
await row.scrollIntoView();
await expect(row).toBeVisible();
```

Both stop when the locator resolves to one node on the driver's visible tree, the same tree every other locator uses. On iOS the driver's full tree also carries the rows a container has scrolled away, and their rects against the container's rect give the direction. On Android that tree has no off-screen rows, so the search reads the scroll container's own hint that it holds content above or below and scrolls that way until the row appears. A search never reverses, because at the end of a list the only remaining hint points back, and it stops after twenty steps regardless of the clock. Each scroll is a nested step under the action, and a failure names the steps taken.

```
Locator never resolved to a node within 10000ms.

Locator: getByTestId('row-99')
Scrolled: 3 steps down
```

`device.scroll('down')` scrolls the screen without naming a target.

## Reading values

`count()` returns how many distinct nodes a locator resolves to, after absorption.

```ts
expect(await device.getByRole('cell').count()).toBe(3);
```

`textContent()` returns the text of the one node a locator resolves to, or `null` when it resolves to nothing.

```ts
const name = await device.getByTestId('profile-name').textContent();
```

It takes one snapshot and reads it once. It does not retry, so use it to capture a value you already asserted on rather than to wait for one. A locator that matches more than one node throws the strict-mode error instead of picking one.

## The whole tree

`device.screen()` returns the parsed accessibility tree for an assertion touchpress does not model.

```ts
const screen = await device.screen();
const labels = screen.nodes.filter((node) => node.role === 'button').map((node) => node.name);
```

Each `ScreenNode` carries `ref`, `role`, `rawType`, `name`, `value`, `testId`, `rect`, `enabled`, `selected`, `focused`, `hiddenContentAbove`, `hiddenContentBelow`, its `index` among its siblings, a `parent` link, and its `depth`. The two hidden-content flags are the driver's own hints on a scroll container, and they are what a screen listing prints as `[more above]` and `[more below]`. The tree is frozen. It is one observation of the device, never refreshed in place, because every command the driver runs invalidates the refs a previous snapshot handed out.

## Screenshots

`device.screenshot()` saves a PNG of the device and returns the path the driver wrote it to.

```ts
const path = await device.screenshot();
await device.screenshot({ path: 'card.png' });
```

The default path is numbered per call and goes through the same output directory the runner gives the test, so it is unique per test and per retry attempt. An explicit path is used as given. Nothing is attached to the report, so the caller decides whether the file belongs in the run's output. Each call is reported as one step.

The agent-device CLI equivalent is `agent-device screenshot ./card.png`, which also takes `--scale` and `--overlay-refs`.

`device.screenshot()` saves the whole device. To compare one control against a committed baseline, use `toHaveScreenshot` on its locator, which crops the control out of that screenshot. See [Assertions](assertions.md).

## Preflight

`preflight` answers one question before any test opens a session. Is the device this project names actually booted?

```ts
// e2e/preflight.setup.mts
import { preflight, setupTest } from 'touchpress';

setupTest(
  'the project names a booted device',
  async ({ platform, app, readyWhen, target, sessionPrefix }) => {
    const report = await preflight({ platform, app, readyWhen, target, sessionPrefix });
    if (report.ok) return;
    throw new Error(report.problems.join('\n'));
  },
);
```

`setupTest` carries touchpress's options and none of its fixtures. touchpress's own `test` would open a session through its auto `device` fixture, and preflight has to run before any session exists.

It returns `{ ok: true, device }` or `{ ok: false, problems }`, where every problem is one line ending in something to do about it. Run it as a Playwright setup project that the device projects depend on, so a missing simulator reads as one short failure rather than a launch timeout in every test.

Give each platform its own setup project off this one spec. A setup project has a single `use`, so one shared project could only ever check one platform's device. [Configuration](configuration.md) shows the wiring.
