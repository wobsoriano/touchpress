---
'touchpress': minor
---

`act` runs on an evaluation model when `use.evaluationModel` is set. Each step captures the screen, offers the model every move on it, and asks one choice question. The model picks a tap, a fill with text the instruction quoted, a scroll, back, wait, or a verdict, and touchpress performs it through the same driver a deterministic step uses. A task that says "verify" is judged as well as carried out. On a sign-in flow Jev took seven moves and 21 seconds where a language model took about 45.

`expect(device).toBeJudged` is removed, one release after it shipped. The same judgment is an `act` whose instruction says what to verify, and it retries by choosing to wait. The `Judgment` types and `JudgedOptions` go with it.

`ScreenNode` gains `hittable`, null where the driver does not report it.
