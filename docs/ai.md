# AI

Two methods on the `device` fixture take a model. `act` drives the app from an instruction in English. `extract` asks one question about the screen and returns a typed answer. `act` runs on either kind of model, a language model or an evaluation model such as TypeSafe's Jev, and both drive the same way, by picking each move from the ones the screen offers.

```ts
import { expect, test } from 'touchpress';
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

Version 6 or 7 for `aiModel`. `evaluationModel` needs 7.0.103 or newer, where `experimental_evaluate` arrived.

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

## The `evaluationModel` key

`evaluationModel` is a decision model. When it is set, `act` runs on it instead of on `aiModel`. An evaluation model answers typed questions about a block of state, and never writes text or calls a tool, so it is its own kind of model and the two keys are separate. A project can set one, the other, or both. With both, `act` runs on the evaluation model and `extract` on the language model.

To run one file or one test on the language model while the config sets an evaluation model, pass `null`. Playwright reads `undefined` in `test.use` as "not set" and keeps the config's value, so `null` is the form that turns it off.

```ts
test.use({ evaluationModel: null });
```

```ts
use: {
  app: 'com.example.app',
  aiModel: 'anthropic/claude-sonnet-5',
  evaluationModel: 'typesafe-ai/jev-latest',
}
```

A string is a gateway model id again. A provider instance works the same way.

```ts
import { typeSafeAi } from '@ai-sdk/typesafe-ai';

use: { app: 'com.example.app', evaluationModel: typeSafeAi.evaluationModel('jev-latest') }
```

This one rides `experimental_evaluate`, an AI SDK API still marked experimental, so it can change in a patch release of `ai`. It arrived in ai 7.0.103, and a gateway model id needs 7.0.105. An older `ai` fails naming the version, the way a missing one fails naming the install.

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

`act` drives the app until the instruction is satisfied, then resolves with a one-line summary. It fails when the model reports it cannot proceed, when it runs out of steps, and when it runs out of time without reaching an outcome. Each error prints the instruction and the screen the run ended on.

```
act stopped without finishing: The list screen has no second item

Instruction: Open the list and mark the second item done

Screen:
  @e1 [button] "List"
```

`{ timeout }` is the budget for the loop and defaults to 120000 milliseconds. It is checked before each model call and bounds the call itself, so one capture or one device action can run past it. `{ maxSteps }` caps how many turns the model gets and defaults to 25.

```ts
await device.act('Work through the onboarding', { timeout: 300_000, maxSteps: 60 });
```

### How it drives

`act` runs a decision loop. Each step captures the screen, lists every move the screen offers, and asks the model one question, which move next. The moves are a tap for each enabled control, a fill for each field with each text the instruction quoted, scrolling, going back, waiting, and three verdicts, pass, fail, and incomplete. The model picks one, touchpress performs it through the same driver a deterministic step uses, and the loop repeats on a fresh capture. It ends when the model picks a verdict.

```ts
test.use({ evaluationModel: typeSafeAi.evaluationModel('jev-latest') });

await device.act(
  'Sign in with "rob@example.com" and "hunter2". Verify the home screen shows the account\'s email.',
);
```

Three things follow from the loop.

- A verdict ends the run, so a task that says "verify" is judged as well as carried out. `pass` resolves the promise with the model's chance behind it when the model reports one. `fail` and `incomplete` throw the way a blocked run throws.
- Each step is one capture and one model call. On a sign-in flow Jev took six moves and 29 seconds, with calls of 120 to 450 milliseconds. Claude Haiku 4.5 on the same loop took the same six moves and 45 seconds, with calls of one to three seconds and 61k input tokens, where the tool loop it ran before took 13 to 22 calls and 116k to 215k tokens.
- The model reads the screen as a list of nodes with role, name, test id, focus, hittability, and bounds. It never reads a field's value.

### On an evaluation model

With `evaluationModel` set, an evaluation model answers the question as a `choice` with a calibrated distribution over the moves. It never writes text, so it types only what the instruction put in double quotes. Put every exact value there. When the task needs text it was not given and a field is on the screen, the run stops and says so. A pass the model puts below an 80% chance is looked at again rather than trusted, and a run that ends on such a pass fails saying so.

A choice question holds 255 options, so on a screen with more controls than that the moves past the limit are left out and the state says how many. The same move on the same screen three times ends the run, except a wait, which may repeat until the budget ends.

This path rides `experimental_evaluate`, an AI SDK API still marked experimental, so it can change in a patch release of `ai`. It arrived in ai 7.0.103, and a gateway model id needs 7.0.105. An older `ai` fails naming the version, the way a missing one fails naming the install.

### On a language model

With `aiModel` set and no evaluation model, a language model answers the same question as structured output, the id of one move. It gets one move an evaluation model never does, a fill whose text it writes itself, so an instruction can leave the exact words to it. It reports no probability, so a pass is taken as it is. With both keys set, the evaluation model drives and `extract` keeps the language model.

## Credentials

The examples on this page use the sample app's fake account. Do not hand a real credential to `act`. The instruction goes to the model and shows in the `act` step title, and a value typed into a plain field is printed in the step that typed it and in the transcript attached to the test. A secure field's text is hidden in both. The model provider sees the instruction either way.

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

`act` is one step, and every move the model picked is a step nested under it. A `fill` puts the text in a nested step of its own, the way a deterministic fill does, and hides it for a secure field. The last line is the verdict, with the model's chance behind it when it reported one.

```
act "Sign in with "rob@example.com" and "hunter2". Verify the home screen shows the account's email."
  tap Sign in
  fill Email
    type "rob@example.com"
  fill Password
    type 7 characters
  tap Continue
  jev-latest: passed (95% chance)
extract "Is a user signed in?"
```

Each `act` attaches `ai-act-1.json` to the test. It holds each move the model picked with its chance and latency, the outcome, the model, and the token usage summed over the run. It is attached on every exit, so a failed run is readable too.

## Test timeouts

A loop can run for minutes. Playwright's per-test timeout defaults to 30 seconds and is not what `act` reads, so raise it on any spec that calls `act`.

```ts
test.setTimeout(180_000);
```

Or give the AI specs a project of their own with a longer `timeout`.

## What you give up

An AI step is not deterministic. The same instruction can take a different route on two runs, and it can fail on a screen a deterministic locator would have found. It also costs a model call per turn, which is slower and not free.

Use it where a locator is genuinely awkward, and assert deterministically afterwards. The example at the top signs in with `act` and then asserts on `getByTestId('greeting')`, so the check that decides whether the test passes is still exact.
