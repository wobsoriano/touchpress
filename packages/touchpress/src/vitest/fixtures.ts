import { writeFileSync } from 'node:fs';
import { test as base, type RunnerTestCase } from 'vitest';
import { withAi, type AiDevice } from '../ai/device.ts';
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_EXPECT_TIMEOUT_MS,
  parseDeviceOptions,
  parseExpectTimeout,
  TOUCHPRESS_DEFAULTS,
} from '../core/config.ts';
import { createDevice, type Device } from '../core/device.ts';
import type { DriverFactory } from '../core/driver.ts';
import { captureEvidence, evidenceWanted } from '../core/evidence.ts';
import { openSession, sessionName, type DeviceSession } from '../core/session.ts';
import { agentDeviceDriver } from '../driver/index.ts';
import { workerSlot, type VitestOptions } from './options.ts';
import type { TestIdentity } from './paths.ts';
import { bindRunning, unbindRunning } from './running.ts';
import { createVitestSink, type VitestSink } from './sink.ts';

const DEFAULT_OUTPUT_DIR = 'touchpress-results';

/**
 * Every open session in this worker, by session name.
 *
 * Module-level rather than held in a worker fixture. A worker fixture's context
 * is empty, so it cannot learn the project name a session is named after, and
 * worker fixtures cache per `extend` registration, so a spec overriding one
 * option could open a second session under the same name and reclaim the first
 * one mid-file. Under `isolate: false` this map lives exactly as long as a
 * worker fixture would, and a worker is one process, so there is one writer.
 */
const openSessions = new Map<string, DeviceSession>();

/** Idempotent. A duplicated worker fixture registration closing twice is harmless. */
async function closeAll(): Promise<void> {
  const sessions = [...openSessions.values()];
  openSessions.clear();
  await Promise.all(sessions.map((session) => session.close('worker-exit')));
}

export type TouchpressFixtures = VitestOptions & {
  /**
   * Opened lazily on the first test that needs it, the first moment
   * `task.file.projectName` is known, and cached across files and retries.
   */
  session: DeviceSession;
  /** Per test. Relaunches on the way in and captures evidence on the way out. */
  device: Device & AiDevice;
  workerTeardown: undefined;
};

/**
 * The seam the adapter's own suite drives the real fixtures through with
 * `tests/fake-driver.ts`. Not on the public entry, which exports the `test`
 * built on the agent-device factory below.
 *
 * Every option is an `injected` worker fixture, so `provide` in the config
 * overrides its default, and a spec's `test.extend({ aiModel: model })`
 * overrides one by value when the value cannot ride `provide`.
 */
export function createTest(createDriver: DriverFactory) {
  return base.extend<TouchpressFixtures>({
    platform: [undefined, { injected: true, scope: 'worker' }],
    app: [undefined, { injected: true, scope: 'worker' }],
    readyWhen: [undefined, { injected: true, scope: 'worker' }],
    deviceName: [undefined, { injected: true, scope: 'worker' }],
    launchUrl: [undefined, { injected: true, scope: 'worker' }],
    relaunch: [TOUCHPRESS_DEFAULTS.relaunch, { injected: true, scope: 'worker' }],
    onDeviceInUse: [TOUCHPRESS_DEFAULTS.onDeviceInUse, { injected: true, scope: 'worker' }],
    settleQuietMs: [TOUCHPRESS_DEFAULTS.settleQuietMs, { injected: true, scope: 'worker' }],
    launchTimeout: [TOUCHPRESS_DEFAULTS.launchTimeout, { injected: true, scope: 'worker' }],
    dismissDevOverlay: [TOUCHPRESS_DEFAULTS.dismissDevOverlay, { injected: true, scope: 'worker' }],
    evidence: [TOUCHPRESS_DEFAULTS.evidence, { injected: true, scope: 'worker' }],
    sessionPrefix: [TOUCHPRESS_DEFAULTS.sessionPrefix, { injected: true, scope: 'worker' }],
    actionTimeout: [DEFAULT_ACTION_TIMEOUT_MS, { injected: true, scope: 'worker' }],
    expectTimeout: [DEFAULT_EXPECT_TIMEOUT_MS, { injected: true, scope: 'worker' }],
    outputDir: [DEFAULT_OUTPUT_DIR, { injected: true, scope: 'worker' }],
    // Unset rather than a plausible default, because there is no model this library could pick.
    aiModel: [undefined, { injected: true, scope: 'worker' }],

    session: async (
      {
        task,
        annotate,
        platform,
        app,
        readyWhen,
        deviceName,
        launchUrl,
        relaunch,
        onDeviceInUse,
        settleQuietMs,
        launchTimeout,
        dismissDevOverlay,
        evidence,
        sessionPrefix,
        actionTimeout,
        outputDir,
      },
      use,
    ) => {
      const options = parseDeviceOptions({
        platform,
        app,
        readyWhen,
        deviceName,
        launchUrl,
        relaunch,
        onDeviceInUse,
        settleQuietMs,
        launchTimeout,
        dismissDevOverlay,
        evidence,
        sessionPrefix,
        actionTimeout,
      });
      const scope = task.file.projectName ?? '';
      const slot = workerSlot();
      const name = sessionName(options, scope, slot);
      let session = openSessions.get(name);
      if (session === undefined || session.state().phase !== 'ready') {
        // A broken or closed leftover is replaced, the way `openSession` reclaims one by name.
        if (session !== undefined) {
          openSessions.delete(name);
          await session.close('requested').catch(() => undefined);
        }
        const sink = createVitestSink({ context: { annotate }, test: identify(task), outputDir });
        session = await openSession({ options, slot, scope, sink, createDriver });
        await sink.settle();
        openSessions.set(name, session);
      }
      await use(session);
    },

    // Its setup is a no-op and `auto` makes it run for a test that names nothing,
    // which is what guarantees every session this worker opened is closed.
    workerTeardown: [
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await use(undefined);
        await closeAll();
      },
      { scope: 'worker', auto: true },
    ],

    device: [
      async ({ task, annotate, session, aiModel, outputDir, expectTimeout }, use) => {
        const identity = identify(task);
        const matcherTimeout = parseExpectTimeout(expectTimeout);
        const policy = session.options.evidence;
        let captured = false;
        // Vitest closes a test's annotations the moment its body ends, so evidence is
        // attached at the failure site, by the matcher or the step that failed. A
        // `test.fails` body ends as expected and attaches nothing.
        const failed = async (): Promise<void> => {
          if (captured || !evidenceWanted(policy, task.fails !== true)) return;
          captured = true;
          const trail = sink.trail();
          if (trail !== null) {
            await annotate('steps.txt', 'attachment', { body: trail, contentType: 'text/plain' });
          }
          await captureEvidence(session, sink);
        };
        const sink = createVitestSink({
          context: { annotate },
          test: identity,
          outputDir,
          onFailure: failed,
        });
        await session.beginTest(sink);
        const core = createDevice(session, sink);
        const device = withAi(core, session, sink, aiModel);
        // A locator carries the core device and a spec holds the AI one, so both resolve to this test.
        const current = {
          sink,
          test: identity,
          expectTimeout: matcherTimeout,
          screenshots: 0,
          failed,
        };
        bindRunning(core, current);
        bindRunning(device, current);

        await use(device);

        unbindRunning(core);
        unbindRunning(device);
        // A failure touchpress never saw, or a green test under `evidence: 'always'`, can no
        // longer be annotated, so its evidence goes to the test's output directory only.
        if (!captured && evidenceWanted(policy, endedUnexpectedly(task))) {
          await captureEvidence(session, filesOnly(sink));
        }
        await sink.settle();
      },
      { auto: true },
    ],
  });
}

export const test = createTest(agentDeviceDriver);

/** The same evidence files, written where `outputPath` points instead of annotated. */
function filesOnly(sink: VitestSink): VitestSink {
  const trail = sink.trail();
  if (trail !== null) writeFileSync(sink.outputPath('steps.txt'), trail);
  return {
    ...sink,
    attach: (file) => {
      if ('body' in file) writeFileSync(sink.outputPath(file.name), file.body);
      return Promise.resolve();
    },
    note: () => {},
  };
}

/** Just enough of Vitest's `Test` for the predicate to be unit-testable without a runner. */
export type TaskView = {
  readonly result?: { readonly state?: string };
  /** True for `test.fails(...)`. */
  readonly fails?: boolean;
};

/**
 * The Vitest spelling of Playwright's `status !== expectedStatus`. A
 * `test.fails` that failed ended exactly as expected and captures nothing.
 */
export function endedUnexpectedly(task: TaskView): boolean {
  return (task.result?.state === 'fail') !== (task.fails ?? false);
}

/** Reads a `TestIdentity` off the task. The describe chain gives the title path and `retryCount` the attempt. */
export function identify(task: RunnerTestCase): TestIdentity {
  const titlePath: string[] = [];
  for (
    let suite = task.suite;
    suite !== undefined && suite.name !== task.file.name;
    suite = suite.suite
  ) {
    if (suite.name !== '') titlePath.unshift(suite.name);
  }
  titlePath.push(task.name);
  return {
    filepath: task.file.filepath,
    projectName: task.file.projectName ?? '',
    titlePath,
    retry: task.result?.retryCount ?? 0,
  };
}
