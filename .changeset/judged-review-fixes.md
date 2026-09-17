---
'touchpress': patch
---

Fix five `toBeJudged` defects a second review found. A slow screen capture could let the assertion pass after its timeout, and a hung one never ended. One slow poll could give up budget the next poll would have passed in. An `undefined` inside structured instructions or criteria reached the AI SDK and failed its validation. A chance and a fractional bound could print as the same number in a failure. A `null`, `undefined`, or array passed as the judgments crashed or was asked as judgments named "0".

0.3.0 also changed the `ai-timeout` error without saying so. Its `info.instruction` became `info.asked`, next to a new `info.command`. `info.instruction` is back as a deprecated alias of `asked`.
