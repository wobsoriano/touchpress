# Lifecycle

## One session per worker slot

touchpress opens one `agent-device` session per Playwright worker slot and names it `${sessionPrefix}-${project}-${parallelIndex}`. The name is deterministic on purpose. Playwright discards a worker after any test failure and starts a replacement that reuses the same `parallelIndex`, so the replacement reconnects to the session the failed worker left behind instead of stranding it.

Startup is convergent. Running it twice settles on one ready session.

1. Close any leftover session of that exact name.
2. Launch the app with a relaunch, carrying the device selection on that first command.
3. Recover once from a device claimed by one of touchpress's own leftovers, or by any owner when `onDeviceInUse` is `'reclaim'`.
4. Recover once from a session already bound to a different device.
5. Hold until `readyWhen` resolves, or fail with the screen listing.

A session binds to a device on its first command, even a read-only one, which is why the selection rides on the launch rather than on a separate call.

## Every command runs on one queue

Reads included. The driver advances a reference generation on every snapshot, and a reference pinned to an older generation is rejected before it dispatches. A read landing between a resolution and the action pinned to it would invalidate that pin, so one queue is what makes "snapshot, resolve, pin, act" atomic.

Each action is therefore one unit. Capture a screen, resolve the locator, pin the node's reference to that screen's generation, dispatch, and re-capture and retry once if the driver reports the generation was superseded. A second rejection means the screen is changing faster than touchpress can act on it, and that is reported rather than retried forever.

## Relaunch

`relaunch` defaults to `'per-test'`. Before every test after the worker's first, the app is relaunched and the ready gate runs again, so no test inherits the previous test's screen. The worker's own launch already relaunched, so the first test in a worker does not pay for a second one.

`'per-worker'` skips that. Use it when your app is expensive to launch and your tests genuinely do not care what came before.

`device.relaunch()` does the same thing on demand inside a test.

Every one of those launches carries `launchUrl` when it is set, the worker's first launch included, so a development client returns to your app rather than to its server picker between tests. See [Configuration](configuration.md) for the URL shape.

## Clearing state

`device.clearState()` puts the app back to a fresh install as far as a test can, and it is reported as one step with its relaunch nested under it.

```
clear state of com.example.app
  relaunch com.example.app
```

It clears the app's stored state through the driver, then relaunches and runs the ready gate again. The relaunch is part of the operation, because an app still holding a cleared session in memory has not been cleared.

It reaches the app's own storage and nothing else. On iOS that leaves the keychain alone, which is where secure-storage libraries such as `expo-secure-store` keep a session, so a signed-in user stays signed in until the keychain is cleared too.

## Clearing the keychain

`device.clearKeychain()` runs `xcrun simctl keychain <udid> reset` on an iOS simulator, using the identifier `open` reported or simctl's `booted` alias when it reported none. It is reported as one step.

```
clear keychain
```

The keychain is the simulator's, not the app's. Resetting it clears what every app on that simulator stored there, which is why it is its own call rather than part of `clearState()`. Maestro splits the two the same way, `clearState` and `clearKeychain`, and so does Detox with `launchApp({ delete: true })` and `device.clearKeychain()`. To put a signed-in app back to a fresh install, call both.

```ts
await device.clearKeychain();
await device.clearState();
```

On Android it does nothing. Clearing state already removes the app's keystore entries, and the step records a note saying there was nothing to reset. On macOS it does nothing either and records the same kind of note, because touchpress never touches the login keychain.

## DEVICE_IN_USE

A device claim is a file in the `agent-device` state directory, and it outlives the process that made it. A claim made in another workspace does not show up in a session listing run from yours, but it still blocks a launch.

Leftovers whose session name starts with your `sessionPrefix` are always reclaimed, because those are yours. Anything else fails by default with the owner and the command to release it.

```
Device iPhone 17 Pro Max is held by session "lex".
Release it with: agent-device close --session lex
Or set use.onDeviceInUse to 'reclaim'.
```

Set `onDeviceInUse: 'reclaim'` when a shared CI device should always be taken over.

## Evidence

`evidence` defaults to `'on-failure'`. When a test does not end in the status it expected, the `device` fixture captures `screen.png` and a `screen.txt` listing and attaches both to that test, before the worker fixture closes the session. That teardown runs in the separate budget Playwright grants after a test finishes, so a test that timed out still gets its screenshot.

A capture that itself fails records an annotation and returns. Masking the test's real error with a screenshot error would be worse than having no screenshot.

`'always'` captures on every test. `'off'` never does.

`screen.txt` lists each node's reference, role, name, test id and flags, and never a field's value, so an iOS secure field's contents cannot reach it. An Android text field is the exception, because it reports its contents as its accessibility name. The step titles hold the same line. A fill is titled by its locator alone, and the value it typed is a nested step that reports a character count for a secure field and for any fill marked `{ secret: true }`.

No `trace.zip` is produced, because no browser is involved. The HTML report is the evidence surface.

## Shutdown

The worker fixture closes the session when the worker exits. `close` is idempotent, it reaches the closed state even when the driver call fails, and it never shuts the simulator down. touchpress does not boot, build, install, or tear down devices.

## Running the CLI alongside a test run

The `agent-device` CLI and the client touchpress uses share one daemon. A CLI at another version replaces that daemon on every call and drops every open session, which shows up as `SESSION_NOT_FOUND` in the middle of a suite. Run the CLI through the workspace so it is the pinned version.

```sh
pnpm exec agent-device session list
```

`pnpm exec` resolves through the nearest `node_modules/.bin`, and a package that only reaches agent-device through touchpress has no such binary, so the command would fall through to a global install. The workspace root pins `agent-device` at the library's exact version for that reason. Pin the same version in any project that drives a device by hand next to touchpress.
