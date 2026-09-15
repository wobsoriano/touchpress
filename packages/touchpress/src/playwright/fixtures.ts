import { test as base, type TestInfo } from '@playwright/test';
import { parseDeviceOptions, TOUCHPRESS_DEFAULTS, type TouchpressOptions } from '../core/config.ts';
import { withAi, type AiDevice } from '../ai/device.ts';
import type { AiOptions } from '../ai/options.ts';
import { createDevice, type Device } from '../core/device.ts';
import { captureEvidence } from '../core/evidence.ts';
import { silentSink, type ActionSink, type EvidenceFile } from '../core/report.ts';
import { openSession, type DeviceSession } from '../core/session.ts';
import { createAgentDeviceDriver, createClient } from '../driver/agent-device.ts';

const SESSION_FIXTURE_TIMEOUT_MS = 180_000;
// The per-test relaunch and the evidence capture run in this fixture, not the test body, so it
// needs its own budget. On the test timeout, a slow relaunch reads as a test timeout instead.
const DEVICE_FIXTURE_TIMEOUT_MS = 120_000;

/**
 * Touchpress's options and none of its fixtures, for a setup project that reads the
 * configuration before any session exists, such as one calling `preflight`.
 *
 * `platform`, `app`, and `readyWhen` default to `undefined` rather than to a
 * plausible value. A Playwright option fixture needs a default of its declared
 * type, and `parseDeviceOptions` rejects `undefined` by name, so a config that
 * forgot a key and one that never set it fail the same way.
 */
export const setupTest = base.extend<object, TouchpressOptions & AiOptions>({
  platform: [undefined, { option: true, scope: 'worker' }],
  app: [undefined, { option: true, scope: 'worker' }],
  readyWhen: [undefined, { option: true, scope: 'worker' }],
  deviceName: [undefined, { option: true, scope: 'worker' }],
  cloud: [undefined, { option: true, scope: 'worker' }],
  launchUrl: [undefined, { option: true, scope: 'worker' }],
  relaunch: [TOUCHPRESS_DEFAULTS.relaunch, { option: true, scope: 'worker' }],
  onDeviceInUse: [TOUCHPRESS_DEFAULTS.onDeviceInUse, { option: true, scope: 'worker' }],
  settleQuietMs: [TOUCHPRESS_DEFAULTS.settleQuietMs, { option: true, scope: 'worker' }],
  launchTimeout: [TOUCHPRESS_DEFAULTS.launchTimeout, { option: true, scope: 'worker' }],
  dismissDevOverlay: [TOUCHPRESS_DEFAULTS.dismissDevOverlay, { option: true, scope: 'worker' }],
  evidence: [TOUCHPRESS_DEFAULTS.evidence, { option: true, scope: 'worker' }],
  sessionPrefix: [TOUCHPRESS_DEFAULTS.sessionPrefix, { option: true, scope: 'worker' }],
  // Unset rather than a plausible default, because there is no model this library could pick.
  aiModel: [undefined, { option: true, scope: 'worker' }],
});

/** The worker session already opened the app with a relaunch, so the first test skips one. */
const startedTests = new WeakSet<DeviceSession>();

/**
 * `device` is auto so evidence capture runs for every test in a device project,
 * whether or not the body touched it. Its teardown runs before the session's,
 * inside the separate budget Playwright grants after the test finishes, so a
 * timed-out test still gets a screenshot.
 *
 * Importing and extending `test` launches no browser: `browser`, `context`, and
 * `page` are lazy and non-auto, and nothing here names them.
 */
export const test = setupTest.extend<{ device: Device & AiDevice }, { session: DeviceSession }>({
  session: [
    async (
      {
        platform,
        app,
        readyWhen,
        deviceName,
        cloud,
        launchUrl,
        relaunch,
        onDeviceInUse,
        settleQuietMs,
        launchTimeout,
        dismissDevOverlay,
        evidence,
        sessionPrefix,
      },
      use,
      workerInfo,
    ) => {
      const options = parseDeviceOptions({
        platform,
        app,
        readyWhen,
        deviceName,
        cloud,
        launchUrl,
        relaunch,
        onDeviceInUse,
        settleQuietMs,
        launchTimeout,
        dismissDevOverlay,
        evidence,
        sessionPrefix,
        // Playwright's own option rather than one of touchpress's, so it is read off the project.
        actionTimeout: workerInfo.project.use.actionTimeout,
      });
      const session = await openSession({
        options,
        // `parallelIndex` and not `workerIndex`: Playwright discards a worker after any failure and
        // the replacement reuses the same slot, so this is what makes a retry reuse the same device
        // and reconnect to the same daemon session instead of stranding it.
        slot: workerInfo.parallelIndex,
        scope: workerInfo.project.name,
        sink: playwrightSink(),
        createDriver: (name, selection) =>
          createAgentDeviceDriver(createClient(selection.target), name, selection),
      });
      await use(session);
      await session.close('worker-exit');
    },
    { scope: 'worker', timeout: SESSION_FIXTURE_TIMEOUT_MS },
  ],

  device: [
    async ({ session, aiModel }, use, testInfo) => {
      const sink = playwrightSink();
      if (session.options.relaunch === 'per-test' && startedTests.has(session)) {
        await session.relaunch(sink);
      }
      startedTests.add(session);

      await use(withAi(createDevice(session, sink), session, sink, aiModel));

      if (shouldCapture(testInfo, session.options.evidence)) await captureEvidence(session, sink);
    },
    { auto: true, timeout: DEVICE_FIXTURE_TIMEOUT_MS },
  ],
});

function shouldCapture(testInfo: TestInfo, evidence: 'on-failure' | 'always' | 'off'): boolean {
  if (evidence === 'off') return false;
  return evidence === 'always' || testInfo.status !== testInfo.expectedStatus;
}

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
