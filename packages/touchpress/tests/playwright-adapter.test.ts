import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const harness = join(packageRoot, 'tests', 'playwright-adapter');

type Result = { status: string; attachments: { name: string }[] };
type Suite = {
  suites?: Suite[];
  specs?: { title: string; tests: { results: Result[] }[] }[];
};

function collect(suites: Suite[], into: Map<string, Result[]>): Map<string, Result[]> {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      into.set(
        spec.title,
        spec.tests.flatMap((one) => one.results),
      );
    }
    collect(suite.suites ?? [], into);
  }
  return into;
}

/**
 * Playwright's `test()` cannot run inside Vitest, so the Playwright half of the
 * adapter contract is a real `playwright test` over the fake driver, read back
 * through the JSON reporter. The deliberate failure makes the run exit 1.
 */
test('the Playwright adapter runs the contract, captures evidence, and writes baselines', async () => {
  const out = mkdtempSync(join(tmpdir(), 'touchpress-playwright-adapter-'));
  const report = join(out, 'report.json');
  rmSync(join(harness, 'adapter.spec.mts-snapshots'), { recursive: true, force: true });
  await new Promise<void>((done) => {
    execFile(
      join(packageRoot, 'node_modules', '.bin', 'playwright'),
      [
        'test',
        '--config',
        join(harness, 'playwright.config.mts'),
        '--output',
        join(out, 'results'),
      ],
      { cwd: packageRoot, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report, CI: '' } },
      () => done(),
    );
  });
  const parsed: { suites: Suite[] } = JSON.parse(readFileSync(report, 'utf8'));
  const results = collect(parsed.suites, new Map());
  const statuses = [...results].map(([title, runs]) => [title, runs.map((run) => run.status)]);
  expect(statuses).toEqual([
    ['the first test opens the session once and skips the relaunch', ['passed']],
    ['the second test relaunches on the way in', ['passed']],
    ['a node on screen passes toBeVisible, toBeEnabled and toHaveText', ['passed']],
    ['a node not on screen passes not.toBeVisible and toHaveCount(0)', ['passed']],
    ['a matcher that never holds rejects with the probe message', ['passed']],
    ['.not on a node that stays on screen waits the budget and names the negation', ['passed']],
    ['the device carries the resolved options a spec may read', ['passed']],
    ['a failing body captures evidence', ['failed']],
    ['an expected failure attaches nothing', ['failed']],
    ['a named screenshot is written under the project on the first run', ['passed']],
  ]);
  // Playwright attaches its own error-context on a failure. Only touchpress's attachments are of interest.
  const names = (title: string) =>
    results
      .get(title)?.[0]
      ?.attachments.map((file) => file.name)
      .filter((name) => name !== 'error-context') ?? null;
  expect(names('a failing body captures evidence')).toEqual(['screen.png', 'screen.txt']);
  expect(names('an expected failure attaches nothing')).toEqual([]);
  expect(
    readFileSync(
      join(harness, 'adapter.spec.mts-snapshots', `explore-fake-${process.platform}.png`),
    ).length,
  ).toBeGreaterThan(0);
  rmSync(join(harness, 'adapter.spec.mts-snapshots'), { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}, 120_000);
