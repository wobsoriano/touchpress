---
'touchpress': minor
---

Add `expect(device).toBeJudged`, which asserts what an evaluation model judges the screen to be. It takes one statement or a record of named judgments the model answers together from a single capture, each with the chance it must reach through `min`, `max`, or `is`. Set `use.evaluationModel` to a model instance or a gateway model id. It rides `experimental_evaluate`, which needs ai 7.0.103 or newer and is still experimental upstream.
