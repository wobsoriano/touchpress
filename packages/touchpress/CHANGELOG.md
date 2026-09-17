# touchpress

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
