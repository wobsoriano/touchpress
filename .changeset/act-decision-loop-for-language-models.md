---
'touchpress': minor
---

`act` on a language model runs the same decision loop an evaluation model does. Each step offers the model every move on the screen and takes one structured answer, instead of a tool loop in which the model chose when to snapshot and composed each command. On a sign-in flow that cut Claude Haiku 4.5 from 13 to 22 tool calls and 116k to 215k input tokens down to the same six moves Jev takes and 61k tokens. A language model keeps one move an evaluation model never has, a fill whose text it writes itself.

The tool loop is gone with its `agent-device/ai-sdk` import. The `ai-act-N.json` transcript now has one shape for both kinds of model, a list of moves with chance and latency rather than tool calls and results.
