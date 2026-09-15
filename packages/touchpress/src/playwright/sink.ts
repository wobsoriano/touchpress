import { test as base, type TestInfo } from '@playwright/test';
import { silentSink, type ActionSink, type EvidenceFile } from '../core/report.ts';

/**
 * Resolves the running test on every call rather than capturing a `TestInfo`. A
 * worker outlives every test in it, so a captured one would file the second
 * test's evidence under the first test's report entry.
 */
export function playwrightSink(): ActionSink {
  return {
    step: (title, body, options) => base.step(title, body, options),
    attach: async (file: EvidenceFile) => {
      const info = currentTest();
      if (info === null) return;
      await info.attach(
        file.name,
        'path' in file
          ? { path: file.path, contentType: file.contentType }
          : { body: file.body, contentType: file.contentType },
      );
    },
    note: (key, value) => {
      currentTest()?.annotations.push({ type: key, description: value });
    },
    outputPath: (fileName) =>
      currentTest()?.outputPath(fileName) ?? silentSink.outputPath(fileName),
  };
}

function currentTest(): TestInfo | null {
  try {
    return base.info();
  } catch {
    // `test.info()` throws outside test execution, which is not a reason to fail a device command.
    return null;
  }
}
