# touchpress

## 0.5.0

### Minor Changes

- 04caff9: `act` on a language model runs the same decision loop an evaluation model does. Each step offers the model every move on the screen and takes one structured answer, instead of a tool loop in which the model chose when to snapshot and composed each command. On a sign-in flow that cut Claude Haiku 4.5 from 13 to 22 tool calls and 116k to 215k input tokens down to the same six moves Jev takes and 61k tokens. A language model keeps one move an evaluation model never has, a fill whose text it writes itself.

  The tool loop is gone with its `agent-device/ai-sdk` import. The `ai-act-N.json` transcript now has one shape for both kinds of model, a list of moves with chance and latency rather than tool calls and results.

### Patch Changes

- 26e493d: `act` on an evaluation model offers `need_input` only when the screen has a field to type into. On a sign-in options sheet with no field yet, Jev picked it at the first step and the run ended, where a tap on "Enter your email" would have carried the task forward. The instructions now say the same.

  A named text the driver marks hittable is offered as a tap. Clerk's sign-in sheet shows "Enter your email" as such a text before the field exists, and the run had no move that reached it.

## 0.4.0

### Minor Changes

- fb6967f: `act` runs on an evaluation model when `use.evaluationModel` is set. Each step captures the screen, offers the model every move on it, and asks one choice question. The model picks a tap, a fill with text the instruction quoted, a scroll, back, wait, or a verdict, and touchpress performs it through the same driver a deterministic step uses. A task that says "verify" is judged as well as carried out. On a sign-in flow Jev took seven moves and 21 seconds where a language model took about 45.

  `expect(device).toBeJudged` is removed, one release after it shipped. The same judgment is an `act` whose instruction says what to verify, and it retries by choosing to wait. The `Judgment` types and `JudgedOptions` go with it.

  `ScreenNode` gains `hittable`, null where the driver does not report it.

## 0.3.0

### Minor Changes

- d31f12a: Add `expect(device).toBeJudged`, which asserts what an evaluation model judges the screen to be. It takes one statement or a record of named judgments the model answers together from a single capture, each with the chance it must reach through `min`, `max`, or `is`. Set `use.evaluationModel` to a model instance or a gateway model id. It rides `experimental_evaluate`, which needs ai 7.0.103 or newer and is still experimental upstream.

## 0.2.3

### Patch Changes

- c05095d: Bump agent-device to 0.21.2

## 0.2.2

### Patch Changes

- 847f7c7: Bump agent-device to 0.21.1

## 0.2.1

### Patch Changes

- 5daccf8: Find a filled field again by its role rather than its raw tree index, so a fill retry never writes to the node the software keyboard shifted into the field's place.

## 0.2.0

### Minor Changes

- 430001a: Add `device.goBack`, `device.keyboard.type`, `device.clearState`, and `device.clearKeychain`. `goBack` presses the platform gesture on Android and the app's own control on iOS. `keyboard.type` types into whatever holds focus, for a field with nothing to select on. `clearState` discards the app's stored state, then relaunches and waits for the ready gate. `clearKeychain` resets the simulator keychain on iOS, which every app on it shares, and does nothing on Android.

## 0.1.3

### Patch Changes

- de6417d: Retarget a tap or a long press the driver refuses onto the control that covers the matched node, and report where it landed.

## 0.1.2

### Patch Changes

- f555fa3: Confirm a fill into an Android password field, which is a plain `text-field` that reads back a mask.

## 0.1.1

### Patch Changes

- 2494598: Confirm a fill against normalized text, match global regexes on every sibling, paint a screenshot mask only where it overlaps the image, name unnamed baselines by their full title path, run a model turn's tool calls one at a time, drop undeclared tool input keys, and type-check without `ai` installed.

## 0.1.0

### Minor Changes

- cb7a838: Add `device.act` and `device.extract`, which drive the app and read the screen with a model set through the new `aiModel` option.

## 0.0.2

### Patch Changes

- 1e58d6e: Initial release
