# AI

Two methods on the `device` fixture take a model. `act` drives the app from an instruction in English. `extract` asks one question about the screen and returns a typed answer.

```ts
import { expect, test } from 'touchpress/playwright';
import { z } from 'zod';

test('sign in', async ({ device }) => {
  await device.act('Sign in with the email rob@example.com and the password hunter2');
  await expect(device.getByTestId('greeting')).toHaveText('Hi, Rob');

  const { signedIn } = await device.extract(
    'Is a user signed in?',
    z.object({ signedIn: z.boolean(), reason: z.string() }),
  );
});
```

Both are opt-in. A project that never calls one needs no model and no extra dependency.

## Install

`ai` is an optional peer dependency, imported the first time `act` or `extract` runs. Importing `touchpress` without it works, and so does type-checking against it, because the types on the main entry name no AI SDK type.

```sh
pnpm add -D ai
```

Version 6 or 7. Both carry every name touchpress uses.

## The `aiModel` key

`aiModel` is one more key in Playwright's `use`, and it merges on its own like the rest.

```ts
// playwright.config.ts
use: {
  app: 'com.example.app',
  readyWhen: { testId: 'home' },
  aiModel: process.env.AI_MODEL,
}
```

A string is a gateway model id, which the AI SDK resolves against `AI_GATEWAY_API_KEY`.

```ts
use: { app: 'com.example.app', aiModel: 'anthropic/claude-sonnet-5' }
```

A provider instance works the same way, for a project that already has its own credentials wired.

```ts
import { anthropic } from '@ai-sdk/anthropic';

use: { app: 'com.example.app', aiModel: anthropic('claude-sonnet-5') }
```

Leave it unset and `act` and `extract` fail naming the key. Nothing else reads it, so a config that sets it costs nothing until a test calls one of them.

Playwright reads no `.env` on its own. Load one from the config before `defineConfig`, as the sample app does, and keep the file out of git.

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
```

## `act`

```ts
const summary = await device.act('Open the list and mark the second item done');
```

`act` runs a tool loop. The model takes a snapshot, decides what to do, and runs one command against the same daemon session the deterministic steps use, so it acts on the app this test already launched. It stops when the model reports the instruction is satisfied, and it resolves with the model's one-line summary of what it did.

It fails when the model reports it cannot proceed, when it runs out of steps, and when it runs out of time without reaching an outcome. Each error prints the instruction and the screen the run ended on.

```
act stopped without finishing: The list screen has no second item

Instruction: Open the list and mark the second item done

Screen:
  @e1 [button] "List"
```

`{ timeout }` is the whole budget for the loop and defaults to 120000 milliseconds. `{ maxSteps }` caps how many turns the model gets and defaults to 25.

```ts
await device.act('Work through the onboarding', { timeout: 300_000, maxSteps: 60 });
```

## The tools the model gets

Ten commands, all of them agent-device's own, with their upstream descriptions.

| tool       | what it does                                  |
| ---------- | --------------------------------------------- |
| `snapshot` | read the accessibility tree                   |
| `press`    | tap a node                                    |
| `fill`     | replace a field's text                        |
| `type`     | type into whatever holds focus                |
| `scroll`   | scroll the screen                             |
| `back`     | go back                                       |
| `wait`     | wait for a node or for the screen to go quiet |
| `get`      | read a value off the screen                   |
| `is`       | check a predicate against the screen          |
| `alert`    | answer a system alert                         |

`open`, `close`, and `screenshot` are not among them, because the session is the test's rather than the model's. Every key that names a device, a daemon, or a workspace is cut from each tool's input schema before the model sees it, so a command can only reach the device this worker opened. The one addressing key that survives is `target` on `press`, `fill`, and `get`, the ref from the model's last snapshot.

What comes back is trimmed too. The snapshot the model reads is the compact listing a failure message prints, one node per line, rather than the driver's node JSON. Every other command answers with its outcome. A `press` reports what it pressed and whether the screen settled, and drops the settle diff, the evidence paths, and the cost breakdown. On the captures in this repo the listing is three to seven times smaller than the JSON, which is what keeps a long instruction inside its step budget.

## Credentials

The examples on this page use the sample app's fake account. Do not hand a real credential to `act`. The instruction goes to the model, and the value the model types back is printed in the step it ran, in the transcript attached to the test, and in the model provider's own logs.

Sign in deterministically and let `act` take over afterwards.

```ts
await device.getByTestId('email').fill('rob@example.com');
await device.getByTestId('password').fill(process.env.PASSWORD, { secret: true });
await device.getByRole('button', { name: 'Sign in' }).tap();

await device.act('Dismiss the tour and open the settings screen');
```

`secret` is what keeps the value out of the step and out of the failure message. See [Basics](basics.md).

## `extract`

```ts
const answer = await device.extract(
  'Which row is selected?',
  z.object({ label: z.string(), index: z.number() }),
);
```

`extract` takes one snapshot, renders it the way a failure message does, and asks the model for an answer matching the schema. The answer is validated before it comes back, so the result is typed rather than parsed by the caller. There are no tools, so the model cannot change the screen it is describing.

The rendered screen carries each node's ref, role, name, and test id. It never carries a field's value, which is the same rule every touchpress failure message follows.

`{ timeout }` defaults to 60000 milliseconds.

Any schema the AI SDK accepts works, so Zod, Valibot, and a plain JSON schema are all fine.

## What the report shows

`act` is one step, and every command the model ran is a step nested under it. A `fill` or a `type` puts the text in a nested step of its own, the way a deterministic fill does.

```
act "Sign in with the email rob@example.com"
  snapshot
  press @e12
  fill @e4
    type "rob@example.com"
  snapshot
  press @e9
extract "Is a user signed in?"
```

Each `act` also attaches `ai-act-1.json` to the test. It holds every tool call with its input, each result truncated to 2 KB, each errored call with its error message, the model's text, and the token usage for the run. Read it when a loop did something surprising.

## Test timeouts

A loop can run for minutes. Playwright's per-test timeout defaults to 30 seconds and is not what `act` reads, so raise it on any spec that calls `act`.

```ts
test.setTimeout(180_000);
```

Or give the AI specs a project of their own with a longer `timeout`.

## What you give up

An AI step is not deterministic. The same instruction can take a different route on two runs, and it can fail on a screen a deterministic locator would have found. It also costs a model call per turn, which is slower and not free.

Use it where a locator is genuinely awkward, and assert deterministically afterwards. The example at the top signs in with `act` and then asserts on `getByTestId('greeting')`, so the check that decides whether the test passes is still exact.
