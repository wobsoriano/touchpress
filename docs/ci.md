# Continuous integration

Two workflows live in `.github/workflows`. One is fast and runs on every push. The other boots devices and runs the real suite.

The device workflow is manual for now. The repository has no Actions minutes left, so `e2e.yml` triggers on `workflow_dispatch` only and nothing starts it automatically. Start one by hand once there are minutes again.

```sh
gh workflow run e2e.yml
```

Until then the device suite is verified locally, against a booted simulator and a booted emulator. [Running the suite from a script](#running-the-suite-from-a-script) has the commands.

## `ci.yml`

Runs on pushes to `main` and on every pull request, on `ubuntu-latest`. It checks out the repository, sets up Vite Plus with its cache, and runs the commands you run locally.

```sh
vp run -r build                          # build every package in dependency order
vp check                                 # format, lint, and type check every package
node apps/e2e/scripts/spec-parity.mjs    # the Vitest specs match the Playwright specs
vp test                                  # the library's unit tests
```

The build leads. The sample app imports touchpress through its exports map, which points at `dist`, so nothing can typecheck until the workspace is built.

The parity script diffs `apps/e2e/e2e/` against `apps/e2e/e2e-vitest/` after normalizing the import line, so the two runners keep being proven against the same specs. `ai.spec.mts` is on its allowlist with the reason it may differ, and the script prints a diff and fails on anything else. `pnpm --filter touchpress-e2e check:parity` runs it locally.

Nothing here touches a device, so it finishes in about a minute and it is what gates a pull request.

## `e2e.yml`

Two jobs, one per platform, with a 60 minute cap and a concurrency group on the branch so a new run cancels the one it replaced. It triggers on `workflow_dispatch` only, for the reason above.

The device workflow runs the Playwright suite. The iOS job runs on `macos-26`. In order, it builds the library, boots an iPhone simulator through `futureware-tech/simulator-action` with `erase_before_boot` so every run starts from a clean device, builds `apps/e2e` in Release for the simulator, installs the app with `xcrun simctl install`, prepares the `agent-device` iOS runner, and runs the suite with `--project=ios`.

The Android job runs on `ubuntu-latest` and uses `reactivecircus/android-emulator-runner` for an API 34 `google_apis` x86_64 emulator with animations disabled. It builds and installs a Release APK and runs `--project=android`.

### A Release build and no Metro

Both jobs build in Release, which bundles the JavaScript into the app. A development build would need a Metro server alive for the whole run, and a bundler that dies mid-suite looks like a launch timeout rather than an infrastructure failure. Release removes that whole failure mode from CI.

### Naming the device

`TOUCHPRESS_ANDROID_DEVICE` has to match what `agent-device devices` prints, and for an emulator that is the AVD name with its underscores shown as spaces. An AVD created as `ci_api34` is `ci api34` there, so a config that names it `ci-api34` finds nothing and preflight fails with the booted names listed. The workflow sidesteps the trap by creating its AVD as `ci-api34`, with hyphens, and passing that same string through, so the two agree without a translation step.

The same applies locally. The checked-in default is `Expo API 36`, which is the AVD `Expo_API_36`.

### The runner cache

`agent-device` builds a small XCTest runner the first time it drives an iOS device, and that build costs several minutes. The workflow caches `~/.agent-device/apple-runner/derived` keyed on the `agent-device` version and the Xcode version, then runs `agent-device prepare ios-runner` explicitly so the build happens in a step you can read rather than inside the first test.

The Android emulator's AVD is cached the same way, keyed by API level, target, and architecture.

### The native build cache

The cold native build is what a run actually costs, so both jobs cache the artifact it produces. A step hashes the inputs the build reads, using `git ls-files -s` over the lockfile, the workspace file, and the sample app's `package.json`, `app.json`, `app`, `src`, and `assets`, piped to `git hash-object --stdin`. The iOS job folds in the Xcode version and the Android job folds in the API level, because the same sources build differently against a different toolchain.

The key is `touchpress-native-v1-<platform>-<hash>`. `actions/cache/restore` looks for the `.app` bundle on iOS and the release APK on Android. A hit skips both `expo prebuild` and the platform build. A miss runs them and `actions/cache/save` stores the artifact under the key that was just missed. Bump the `v1` when the build commands change, since the commands are not part of the hash.

The library source is deliberately left out of the hash. The sample app never imports touchpress. It is a devDependency the specs use on the host, so a library change cannot alter the native build. `vp run -r build` stays unconditional for that reason, because the specs need the built library whether or not the app was rebuilt.

### Losing input on a slow runner

A hosted runner has few cores, and a text field there can lose input that never goes missing on a developer's machine. The fix for that lives in the library. `fill` reads the field back twice with the settle wait between them, so a value that the app's own render puts back over what was typed is caught rather than trusted. [Basics](basics.md) has the detail.

The sample config also sets `retries` to 1 when `CI` is set and 0 otherwise. That is a second line of defense and not the fix. Playwright discards the worker after a failure and the replacement reuses the same slot, so the retry reclaims the same device and reconnects to the same session, which is the path the session lifecycle is built for.

A test that fails both attempts is a real failure. A test that needs its retry every run is a bug to fix rather than a flake to absorb.

### Artifacts

Both jobs upload `apps/e2e/playwright-report` when they fail, with seven day retention. That report carries the `screen.png` and `screen.txt` attachments for every failed test, which is the whole reason to look at a failed device run.

## Running the suite from a script

The e2e scripts take the project flag from the caller, so one script serves both jobs. Run them through pnpm, not `vp run`.

```sh
pnpm --filter touchpress-e2e test:e2e --project=ios
pnpm --filter touchpress-e2e test:e2e --project=android
pnpm --filter touchpress-e2e test:e2e:vitest --project=ios
pnpm --filter touchpress-e2e test:e2e:vitest --project=android
```

`vp run` tracks every process a task starts through an IPC socket it passes in the environment. `agent-device` starts its daemon with that environment when no daemon is running, the daemon lives on after the suite, and `vp run` keeps waiting for it. The run prints its results and then hangs. pnpm passes no such environment, so the daemon starts clean and the command exits when Playwright does. The root `pnpm test:e2e` and `pnpm test:e2e:vitest` scripts are these pnpm commands without a project flag, so each runs every project of its runner. The workflows call `apps/e2e/node_modules/.bin/playwright` and `packages/touchpress/node_modules/.bin/agent-device` directly instead, because `setup-vp` puts `vp` on the PATH but not `pnpm`.

## What a run costs

Both workflows have run green on GitHub-hosted runners. A cold native build is what a run pays for, about 26 minutes for the iOS Release build on `macos-26` and about 42 minutes for the Android Release build on `ubuntu-latest`, against under four minutes for the suite itself. The native build cache removes that cost from every run that does not touch the sample app or the lockfile.
