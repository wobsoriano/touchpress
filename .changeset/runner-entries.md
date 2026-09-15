---
'touchpress': minor
---

Two runner entries. `touchpress` no longer exports `test`, `setupTest` or `expect`. Import them from `touchpress/playwright`, which also re-exports everything the root does, so a spec keeps one import line. The root entry is the runner-free vocabulary, the types a config or page-object module names, `TouchpressError` and `preflight`.

`touchpress/vitest` is new and runs the same specs on Vitest 4 or 5. The keys go in `provide` instead of `use`, plus three of its own, `actionTimeout`, `expectTimeout` and `outputDir`, which Playwright's config supplied for free. A failing matcher or step attaches `steps.txt`, `screen.png` and `screen.txt`, and screenshot baselines land at the path Playwright's default template produces, so one committed tree serves both runners.

`@playwright/test`, `vitest` and `ai` are all optional peer dependencies, so a project installs the runner it uses and nothing else.

`Device` carries `options`, the resolved configuration, so a spec reads `device.options.platform` under either runner.
