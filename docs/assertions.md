# Assertions

Eight matchers, all on touchpress's own `expect`, all retrying, all accepting `{ timeout }`, all working under `.not`.

| matcher                           | asserts                                    |
| --------------------------------- | ------------------------------------------ |
| `toBeVisible()`                   | the locator resolves to exactly one node   |
| `toHaveText(expected, { exact })` | that node's name or value matches          |
| `toHaveValue(expected)`           | that node's value matches, whole string    |
| `toBeEnabled()`                   | that node is enabled                       |
| `toBeSelected()`                  | that node is selected                      |
| `toBeFocused()`                   | that node is focused                       |
| `toHaveCount(n)`                  | the locator resolves to `n` distinct nodes |
| `toHaveScreenshot(name, options)` | the pixels match a committed baseline      |

They carry Playwright's own matcher names, but they are typed by their first parameter, so they surface on a touchpress locator and on nothing else. Web locators are never mixed into the same `expect` here. `toHaveScreenshot` also takes the `device` itself, for a whole-screen comparison.

```ts
import { expect, test } from 'touchpress';

test('the wrong password is rejected without leaving the login screen', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');
  await device.getByTestId('password').fill('wrong', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();

  await expect(device.getByTestId('error')).toHaveText('Wrong email or password', { exact: true });
  await expect(device.getByTestId('profile-name')).not.toBeVisible();
});
```

`toHaveText` reads a node's name and falls back to its value, and it takes the same `{ exact }` option the text locators take. `toHaveValue` is whole-string, like Playwright's own, because a field's value is not prose to search.

## `.not`

`.not` polls for the opposite condition rather than checking once. `not.toBeVisible()` waits for a control to leave, which is what you want after tapping something that dismisses it.

Two things fail the assertion whichever way you write it. An ambiguous locator is wrong under `.not` too, and so is a device session that has died. Neither becomes a pass by inversion.

## Timeouts

Every matcher uses `expect.timeout` from the Playwright config unless the call passes its own.

```ts
await expect(device.getByTestId('signing-in')).toBeVisible({ timeout: 3000 });
```

The first evaluation happens immediately, so an expectation that already holds costs one snapshot. After that the loop takes a fresh snapshot every 250 milliseconds until the check agrees or the budget runs out.

## What a failure says

Every failed assertion answers the same five questions in the same order. Which locator, what was expected, what the screen actually held, how long we waited, and what was on screen.

This is the real output of `e2e/failing.spec.mts` in `apps/e2e`, which asserts that 'Sign out' is visible on the signed-out home screen, where it is not.

```
Error: Expected toBeVisible but it never held.

Locator: getByText('Sign out')
Expected: visible
Received: no node matched. Closest names on screen:
  @e5 [button] "Sign in"
Timeout: 3000ms (5 snapshots)

Screen:
@e1 [application] "touchpress-e2e"
  @e2 [other] #home
  @e3 [text] "Welcome"
    @e4 [text] "Welcome"
  @e5 [button] "Sign in" #sign-in-link

screen.png and screen.txt are attached to this test in the HTML report.
```

The `Locator:` line is the factory call rendered back, so it reads like the line you wrote. `Received:` changes shape with the outcome. On a miss it lists the named nodes closest to what you asked for, because a miss is usually a wording drift. On an ambiguous locator it lists every match and suggests `.first()` or `.nth(n)`. `Timeout:` carries the snapshot count, which tells you whether the loop actually got to poll or the budget was spent elsewhere.

The `Screen:` listing uses `agent-device`'s own `[role] "label"` vocabulary, and it is produced by the same renderer that writes the `screen.txt` attachment, so the terminal and the report always agree. Long screens are cut at 60 nodes in the message and kept whole in the attachment. The listing carries a node's reference, role, name, test id and flags. It never carries a field's value, so a secure field's contents cannot reach it.

`Received:` is the one line that repeats a value back, and it prints what the node reported. That is safe for a secure field, which reports a mask rather than its contents. It is not safe for a field you filled with `{ secret: true }`, because the snapshot carries no mark for it. Assert on the result of a sign-in rather than on the credential you typed.

Run that spec yourself from `apps/e2e`.

```sh
TOUCHPRESS_INCLUDE_FAILING=1 npx playwright test --project=ios e2e/failing.spec.mts
```

## Screenshots

`toHaveScreenshot` compares the device, or one control on it, against a PNG committed next to the spec.

```ts
await expect(device).toHaveScreenshot('home.png');
await expect(device.getByRole('button', { name: 'Sign in' })).toHaveScreenshot('sign-in.png');
```

A locator is cropped out of the device's own screenshot, so the crop and the image come from one capture. The scale between the tree's units and the image's pixels is the image width divided by the window width. It measured 1 on both test devices, since agent-device writes the iOS simulator's screenshot at point resolution and the Android tree already reports pixels, but it is derived on every capture so a 2x or 3x image still crops the right region.

### Baselines

The baseline path comes from `testInfo.snapshotPath(name, { kind: 'screenshot' })`, which is the same call Playwright's own screenshot assertion makes. `snapshotPathTemplate`, the per-project and per-platform suffix, and `--update-snapshots` all behave the way they already do in the project, because none of it is reimplemented here.

```
e2e/screenshot.spec.mts-snapshots/home-ios-darwin.png
```

Leave the name out and it is the test's title with a number, one per assertion in that test.

A baseline that does not exist yet is written. Whether that also passes is Playwright's `updateSnapshots` setting, not touchpress's: `missing`, which is the default, and `all` write it and pass, and anything else writes it and fails with Playwright's own wording so a first run cannot go green on a file it just invented. A mismatch is rewritten under `all` and `changed`.

### Options

| option              | default          | meaning                                               |
| ------------------- | ---------------- | ----------------------------------------------------- |
| `maxDiffPixelRatio` | `0.01`           | the share of the image allowed to differ              |
| `threshold`         | `0.2`            | pixelmatch's per-pixel colour distance, 0 to 1        |
| `mask`              | none             | locators whose rects are painted black in both images |
| `timeout`           | `expect.timeout` | how long to keep re-capturing                         |

Use `mask` rather than a looser `maxDiffPixelRatio` when one region changes between runs, such as a clock or an avatar. A mask hides that region and keeps the rest of the image as strict as before.

```ts
await expect(device).toHaveScreenshot('home.png', {
  mask: [device.getByTestId('clock')],
});
```

A mask may match several nodes. It hides a region rather than picking one out, so ambiguity is not an error there the way it is everywhere else.

A mask is painted only where it overlaps the image. On a locator screenshot, a masked node outside the crop hides nothing, and one straddling the crop's edge hides only the part inside it.

### What a failure says

```
Error: Expected toHaveScreenshot but it never matched.

Target: the whole device
Baseline: /repo/apps/e2e/e2e/screenshot.spec.mts-snapshots/home-ios-darwin.png
Expected: at most 1% of pixels to differ
Received: 8.42% of pixels differ
Timeout: 3000ms (4 captures)

expected.png, actual.png and diff.png are attached to this test in the HTML report.
```

The three PNGs go into the HTML report, and the diff paints every pixel that differed. Two images of different sizes report both sizes instead of a ratio.

```
Received: the screenshot is 440x956 and the baseline is 100x44
```

## Assertions touchpress does not model

Use `device.screen()` and assert on the tree with plain `expect`. See [Basics](basics.md).
