# AI

Two methods on the `device` fixture and one matcher take a model. `act` drives the app from an instruction in English. `extract` asks one question about the screen and returns a typed answer. `toBeJudged` asserts what an evaluation model judges the screen to be, with the chance behind each judgment.

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

  await expect(device).toBeJudged('A user is signed in');
});
```

All three are opt-in. A project that never calls one needs no model and no extra dependency.

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

## The `evaluationModel` key

`toBeJudged` reads `evaluationModel`, not `aiModel`. An evaluation model is a different kind of model from a language model, so the two keys are separate and a project can set one, the other, or both.

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

## `toBeJudged`

```ts
await expect(device).toBeJudged('A user is signed in');
```

`toBeJudged` puts a judgment about the screen to an evaluation model and passes when the model gives it a high enough chance. It polls, taking a fresh capture each time, and fails when the budget runs out first. A bare statement passes at an 80% chance.

A plain statement is enough for most assertions. Across 28 statements of this kind on 8 captured iOS and Android screens, Jev put 27 inside the default bounds and got none wrong.

The model receives the screen as a nested tree of roles, names, and test ids, which these models read more decisively than the indented listing a failure message prints. Like the listing, the tree never carries a field's value.

### Named judgments

Pass a record to ask several judgments at once. The model answers them together from one capture, so five cost the latency of one, and each name shows up in the report and in a failure.

```ts
await expect(device).toBeJudged({
  signedIn: 'A user is signed in',
  showingError: { instructions: 'An error message is visible', max: 0.1 },
  screen: {
    type: 'choice',
    instructions: 'Which screen is this?',
    criteria: {
      home: 'Shows the Welcome title',
      'sign-in': 'Asks for an email address or a social provider',
      password: 'Asks for a password',
    },
    is: 'home',
  },
});
```

Each value is one of three things.

- A string is a statement that must reach an 80% chance.
- A yes or no judgment is the AI SDK's boolean question plus two bounds. `min` is the lowest chance that passes and `max` is the highest. `criteria` says what true and false look like on this screen.
- A choice judgment is the AI SDK's choice question plus `is`, the option the model must pick. `min` there is the lowest chance the picked option must carry, when the provider reports one.

The assertion passes when every judgment passes on the same capture. `is` is checked against `criteria` before any model is asked, so a typo fails at once rather than after the whole budget.

### Saying something must be false

Use `max`. A statement the screen must not match is a judgment with a low ceiling.

```ts
await expect(device).toBeJudged({
  showingError: { instructions: 'An error message is visible', max: 0.1 },
});
```

`not.toBeJudged` is refused. A negated record has two readings, all of it false or any of it false, and a negated chance would pass on a model that is merely unsure. A chance of 50% passes neither `min: 0.8` nor `max: 0.2`, which is what you want from an assertion a model decides. A judgment it is unsure about is not a pass.

Write what would be true and bound it, rather than writing the negative into the statement. These models read a double negative poorly.

### When an answer hovers

Add `criteria` before you loosen a bound. On a signed-in home screen, "The screen offers a way to sign in" sits at a 37% chance, which passes neither bound. With criteria it falls to 15%, and it stays at 99% on the signed-out screen.

```ts
await expect(device).toBeJudged({
  offersSignIn: {
    instructions: 'The screen offers a way to sign in',
    criteria: {
      true: 'A button or link that starts signing in is showing',
      false: 'An account button or an account email address is showing',
    },
    max: 0.2,
  },
});
```

A looser bound accepts every unsure answer, not only this one.

### Writing a judgment

- Ask one judgment per entry. A statement that joins two claims hides two judgments behind one chance. "Is this the signed-out home / welcome screen?" scored 82% on a login form, because a login form is signed out too.
- Do not ask for a count, arithmetic, or a date comparison. Count with `toHaveCount`, and compute in the test.
- Keep judgments a person can review. They are plain objects, so a file of them works, typed with `satisfies Judgments` so a choice keeps its `type`.
- Assert deterministically where a locator can do the job. A locator is exact and free. A judgment is for what a locator cannot say.

### Options and failures

`{ timeout }` is the second argument. It defaults to `expect.timeout` from the Playwright config, the way every other matcher's does. Each poll is a capture plus a model call, and both count against the budget. A capture that uses all of it fails the assertion as a timeout, and another poll starts whenever the half second wait still fits.

A capture or a model call that fails on a later poll is absorbed, because a screen mid-transition is what the polling is for. If the budget ends that way, the failure prints the last verdicts and the error that interrupted the polls. The first poll has nothing to fall back on, so an error there fails the assertion as it is.

A judgment is checked before any model is asked. A missing instruction, a `type` other than `boolean` or `choice`, a bound outside 0 to 1, a key the judgment's kind does not take, and an `is` that is not one of the criteria all fail at once, naming the judgment.

A failure names the model, marks each judgment, prints what a failed one asked, and ends on the screen it last judged.

```
Error: Expected toBeJudged but jev-latest never agreed.

FAIL  signedIn 41% chance, needed at least 80%
      asked: A user is signed in
pass  showingError 3% chance, needed at most 10%

Timeout: 5000ms (6 polls)

Screen:
  @e1 [button] "Sign in"
```

### `toBeJudged` or `extract`

Use `toBeJudged` for a decision. A yes or no, or one of a fixed set, where a fast model built for the job answers in a fraction of a second and says how sure it is.

Use `extract` for a value. A label, a count, anything free-form, where the answer is whatever the screen holds rather than one of the options you wrote down.

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
toBeJudged signedIn, showingError
  jev-latest: signedIn 96% chance, needed at least 80%
  jev-latest: showingError 2% chance, needed at most 10%
```

A `toBeJudged` is one step whatever its poll count, with one line per judgment under it naming the model that judged and the chance it ended on. So the report says who decided without anyone opening an attachment.

Each `act` also attaches `ai-act-1.json` to the test. It holds every tool call with its input, each result truncated to 2 KB, each errored call with its error message, the model's text, and the token usage for the run. Read it when a loop did something surprising.

Each `toBeJudged` attaches `ai-judged-1.json`, which holds the judgments as you wrote them, the last answers, each verdict, the poll count, the token usage summed over every poll, and the provider metadata. That last one is where a provider puts what it knows beyond the answer, such as TypeSafe's per-question confidence.

## Test timeouts

A loop can run for minutes. Playwright's per-test timeout defaults to 30 seconds and is not what `act` reads, so raise it on any spec that calls `act`.

```ts
test.setTimeout(180_000);
```

Or give the AI specs a project of their own with a longer `timeout`.

## What you give up

An AI step is not deterministic. The same instruction can take a different route on two runs, and it can fail on a screen a deterministic locator would have found. It also costs a model call per turn, which is slower and not free.

Use it where a locator is genuinely awkward, and assert deterministically afterwards. The example at the top signs in with `act` and then asserts on `getByTestId('greeting')`, so the check that decides whether the test passes is still exact.
