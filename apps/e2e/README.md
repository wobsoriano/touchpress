# touchpress-e2e

The app `touchpress` is tested against. An Expo SDK 57 project with expo-router, four screens, and a fake sign-in held in React state. Nothing here is a product. Every screen exists so a spec can name something on it.

## Routes

| route      | file              | what it shows                                                                                  |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `/`        | `app/index.tsx`   | Signed out, a Welcome heading and a Sign in button. Signed in, a greeting and a Profile button |
| `/login`   | `app/login.tsx`   | Email and password fields, a Sign in button, an error only after a rejected attempt            |
| `/profile` | `app/profile.tsx` | The signed-in name and email and a Sign out button. Redirects to `/login` when signed out      |
| `/list`    | `app/list.tsx`    | Forty rows in a ScrollView and a Done button after the last one, for scrolling tests           |

`src/auth.tsx` holds the whole auth model. The session is a union of `signed-out`, `signing-in`, and `signed-in`, so a screen switches on one value instead of reading a pile of booleans. State lives in React memory only, and that is the point. The library relaunches the app before every test, so each spec starts signed out with no cleanup code.

## Credentials

`rob@example.com` / `hunter2`. Anything else is rejected as `invalid-credentials`.

`signIn` waits `SIGN_IN_DELAY_MS`, 4000 milliseconds, before resolving either way. It stands in for a network round trip so the specs have to wait on a pending state rather than an instant one. While it is pending the Sign in button is disabled and a `signing-in` text reads "Signing in...".

## Test IDs and the roles they report

A React Native `testID` becomes the accessibility identifier on both platforms, which is what `getByTestId` matches. These are the roles each tree actually reports, the iOS column from XCTest and the Android column from a booted API 36 emulator.

| test ID         | iOS role     | Android role | Android class             | screen  |
| --------------- | ------------ | ------------ | ------------------------- | ------- |
| `home`          | `other`      | `other`      | `android.view.ViewGroup`  | home    |
| `greeting`      | `text`       | `text`       | `android.widget.TextView` | home    |
| `sign-in-link`  | `button`     | `button`     | `android.widget.Button`   | home    |
| `profile-link`  | `button`     | `button`     | `android.widget.Button`   | home    |
| `login`         | `other`      | `other`      | `android.view.ViewGroup`  | login   |
| `email`         | `text-field` | `text-field` | `android.widget.EditText` | login   |
| `password`      | `text-field` | `text-field` | `android.widget.EditText` | login   |
| `error`         | `text`       | `text`       | `android.widget.TextView` | login   |
| `signing-in`    | `text`       | `text`       | `android.widget.TextView` | login   |
| `sign-in`       | `button`     | `button`     | `android.widget.Button`   | login   |
| `profile`       | `other`      | `other`      | `android.view.ViewGroup`  | profile |
| `profile-name`  | `text`       | `text`       | `android.widget.TextView` | profile |
| `profile-email` | `text`       | `text`       | `android.widget.TextView` | profile |
| `sign-out`      | `button`     | `button`     | `android.widget.Button`   | profile |

The roles agree across the platforms. Two Android differences do not show in this table. An Android snapshot also carries the system status bar, `com.android.systemui` clock and battery nodes at the top of the tree, and an `EditText` reports its own contents as its accessibility name, so `getByRole('text-field', { name: 'Email' })` matches that field only while it is empty. [Locators](../../docs/locators.md) has the detail.

Two details the tree makes visible. A `Text` renders as a `text` node wrapped in another `text` node carrying the same string, and the library collapses that pair to the deepest one, so `getByRole('text', { name: 'Rob' })` finds one node rather than two. Matching is a case-insensitive substring by default, so `{ name: 'Rob' }` also matches `rob@example.com` on the profile screen and needs `exact: true` to separate them.

The password field is deliberately not `secureTextEntry`. iOS reads a secure field next to an email field as a real credential and covers the profile screen with a "Save Password?" system alert once sign-in succeeds, which no test can dismiss reliably.

## Building and running

The library must be built first, because this app imports it by package name and resolves its `dist`.

```sh
pnpm --filter touchpress build     # or: vp run -r build, from the repo root
```

Then, from this directory, build and install the app on a booted simulator and start Metro. The build takes several minutes the first time.

```sh
npx expo run:ios --device 'iPhone 17 Pro Max' --no-bundler
npx expo start --port 8081
```

For Android, pass the AVD's own name with its underscores, which is not the spaced name the Playwright config uses, and point the emulator at the host's Metro.

```sh
npx expo run:android --device Expo_API_36 --no-bundler
adb reverse tcp:8081 tcp:8081
npx expo start --port 8081
```

`expo run:android` rejects an adb serial such as `emulator-5554`, so give it the AVD name. `adb devices` lists the serials and `adb -s <serial> emu avd name` says which AVD each one is.

Leave Metro running. No other project's Metro may hold port 8081. A development build loads whichever bundle answers, so a stray server means the tests drive someone else's app.

Then run the suite. The scripts take the project from the caller, so one script per runner serves both platforms and CI.

```sh
pnpm test:e2e --project=ios
pnpm test:e2e --project=android
```

```sh
pnpm test:e2e:vitest --project=ios
pnpm test:e2e:vitest --project=android
```

Under Playwright a `setup-ios` or `setup-android` project runs first and checks that the device the project names is booted. Under Vitest each project's `globalSetup` does the same. `TOUCHPRESS_IOS_DEVICE` and `TOUCHPRESS_ANDROID_DEVICE` override those names, which is how CI points the suite at whatever its runner booted.

## The specs

`e2e/` holds them. They are `.mts` rather than `.ts` only because this app consumes touchpress through a workspace link. Playwright transpiles the linked `dist` as source and then cannot `require` `agent-device`, which ships only ES modules. A project that installs touchpress from npm keeps plain `.spec.ts` files, which was verified with a packed tarball on Node 22.

- `home.spec.mts` reads the signed-out home through `getByRole`.
- `login.spec.mts` covers a rejected attempt, then a successful one through the pending state to the profile.
- `profile.spec.mts` signs in, signs out, and expects the signed-out home back.
- `relaunch.spec.mts` signs in in one test and expects the next test to start signed out, which is what per-test relaunch buys.
- `list.spec.mts` scrolls a row into view and taps the button below the fold on a forty-row list.
- `screenshot.spec.mts` compares the home screen and the Sign in button against committed baselines.
- `failing.spec.mts` fails on purpose so the failure message and the `screen.png` and `screen.txt` attachments can be read. It is excluded from the default run. Include it with `TOUCHPRESS_INCLUDE_FAILING=1`.

`e2e-vitest/` holds the same specs for Vitest, each differing from its twin in `e2e/` by the import line alone, and `scripts/spec-parity.mjs` fails CI when that stops being true. `ai.spec.mts` is the one allowed exception, because Vitest takes the timeout as a third argument, gates with `test.skipIf`, and builds the Anthropic provider through `test.extend`. There is no preflight spec on that side. `devices.ts` names the device per platform for both the config's `provide` and the two `globalSetup` files, `preflight.ios.ts` and `preflight.android.ts`, so the device a project provides and the one it checks cannot drift. Its screenshot baselines live in `e2e-vitest/screenshot.spec.mts-snapshots/`.
