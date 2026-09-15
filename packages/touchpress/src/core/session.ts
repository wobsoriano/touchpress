import { deviceNameForSlot, type ResolvedOptions } from './config.ts';
import type {
  BackMode,
  Binding,
  DeviceDriver,
  DeviceFailure,
  DeviceSelection,
  ScrollDirection,
  Settled,
} from './driver.ts';
import { TouchpressError } from './errors.ts';
import { describeQuery } from './query.ts';
import { renderTitle, type ActionSink } from './report.ts';
import { parseScreen, renderScreen, resolve, type PinnedRef, type Screen } from './screen.ts';

const READY_POLL_MS = 250;
const SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * There is no unopened or opening variant because `openSession` is the only
 * constructor and it returns after `open` succeeded and the ready gate passed.
 * `broken` carries the first failure so a later call reports the root cause
 * rather than a follow-on symptom.
 */
export type SessionState =
  | { readonly phase: 'ready'; readonly binding: Binding }
  | { readonly phase: 'closed'; readonly reason: 'requested' | 'worker-exit' }
  | { readonly phase: 'broken'; readonly failure: DeviceFailure };

/**
 * Serializes every command on one session, reads included. Reads could run in
 * parallel per the driver's own rule, but a read between a snapshot and the
 * action pinned to it advances the ref generation and invalidates the pin. One
 * queue is what makes "snapshot, resolve, pin, act" atomic.
 */
export type Queue = {
  enqueue<T>(body: () => Promise<T>): Promise<T>;
};

export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(body: () => Promise<T>): Promise<T> {
      const next = tail.then(body);
      // One failed command must not wedge the queue, so the tail swallows what the caller receives.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Every mutation takes the budget it has left rather than reading
 * `actionTimeout` again, so waiting for a target and waiting for the screen to
 * settle share one allowance instead of each getting a full one.
 */
export type SessionDevice = {
  capture(): Promise<Screen>;
  /**
   * The driver's full provider tree. Only a scroll search reads it, because it
   * carries nodes no locator should resolve against: on iOS the rows scrolled
   * out of the window, and on both platforms the wrappers the default tree
   * collapses away.
   */
  captureRaw(): Promise<Screen>;
  tap(ref: PinnedRef, budgetMs: number): Promise<Settled>;
  longPress(ref: PinnedRef, durationMs: number, budgetMs: number): Promise<Settled>;
  fill(ref: PinnedRef, text: string, budgetMs: number): Promise<Settled>;
  back(mode: BackMode, budgetMs: number): Promise<Settled>;
  type(text: string, budgetMs: number): Promise<Settled>;
  clearAppState(app: string): Promise<void>;
  resetKeychain(): Promise<void>;
  scroll(direction: ScrollDirection, budgetMs: number): Promise<void>;
};

export type DeviceSession = {
  readonly name: string;
  readonly options: ResolvedOptions;
  state(): SessionState;
  /** The failure that broke this session, or null while it is usable. */
  failure(): DeviceFailure | null;
  /** Runs `body` as one unit on the session's queue. Nothing else touches the device while it runs. */
  run<T>(body: (device: SessionDevice) => Promise<T>): Promise<T>;
  screen(): Promise<Screen>;
  screenshot(path: string): Promise<string>;
  /** Relaunches the app and re-runs the ready gate. Reported as one step. */
  relaunch(sink: ActionSink): Promise<void>;
  /**
   * Called by an adapter before every test body. The open already launched the
   * app, so the first test after it skips the relaunch that `relaunch:
   * 'per-test'` gives every later one. Under `'per-worker'` nothing happens.
   */
  beginTest(sink: ActionSink): Promise<void>;
  /**
   * Discards the app's stored state, then relaunches and re-runs the ready
   * gate, because an app holding a cleared session in memory has not been
   * cleared. Reported as one step with the relaunch nested under it.
   */
  clearState(sink: ActionSink): Promise<void>;
  /**
   * Resets the simulator's keychain, which every app on it shares. Separate
   * from `clearState` so an app-scoped clear never wipes another app's store.
   * Reported as one step, with a note on Android where there is nothing to reset.
   */
  clearKeychain(sink: ActionSink): Promise<void>;
  dismissDevOverlay(): Promise<void>;
  awaitReady(deadline: number): Promise<void>;
  /** Idempotent. Never shuts the simulator down, and reaches `closed` even when the driver call fails. */
  close(reason: 'requested' | 'worker-exit'): Promise<void>;
};

export type OpenSessionInput = {
  readonly options: ResolvedOptions;
  /** The runner's stable worker slot. Playwright passes `parallelIndex`, which a replacement worker reuses. */
  readonly slot: number;
  /** The runner's project name. Part of the session name so two projects never share one. */
  readonly scope: string;
  readonly sink: ActionSink;
  readonly createDriver: (session: string, selection: DeviceSelection) => DeviceDriver;
};

/**
 * Convergent startup. Running it twice settles on one ready session. In order:
 * reclaim a leftover session of the same name, open with the selection carried
 * on that first command, recover once from a device claimed by a leftover or
 * under `onDeviceInUse: 'reclaim'`, recover once from a session bound to another
 * device, then hold until `readyWhen` resolves, because `open` returns while the
 * JavaScript bundle is still loading.
 */
export async function openSession(input: OpenSessionInput): Promise<DeviceSession> {
  const { options, sink } = input;
  const name = sessionName(options, input.scope, input.slot);
  const deviceName = deviceNameForSlot(options, input.slot);
  const driver = input.createDriver(name, { platform: options.platform, name: deviceName });
  const deadline = Date.now() + options.launchTimeout;

  await driver.close(name);
  const binding = await openWithRecovery(driver, options, name, deviceName);
  sink.note('device', `${binding.deviceLabel} (${binding.platform}) session ${binding.session}`);

  const session = createSession(driver, options, name, binding);
  await sink.step(
    renderTitle({ kind: 'open', app: options.app, device: binding.deviceLabel, session: name }),
    async () => {
      if (options.dismissDevOverlay) await session.dismissDevOverlay();
      await session.awaitReady(deadline);
    },
  );
  return session;
}

async function openWithRecovery(
  driver: DeviceDriver,
  options: ResolvedOptions,
  name: string,
  deviceName: string | null,
): Promise<Binding> {
  const request = { app: options.app, relaunch: true, url: options.launchUrl };
  try {
    return await driver.open(request);
  } catch (error) {
    const failure = failureOf(error);
    if (failure === null) throw error;
    if (failure.kind === 'device-busy') {
      const owner = failure.owner;
      const reclaimable =
        owner !== null &&
        (owner.startsWith(options.sessionPrefix) || options.onDeviceInUse === 'reclaim');
      if (!reclaimable) {
        throw new TouchpressError({
          kind: 'device-in-use',
          owner,
          device: deviceName ?? options.platform,
          releaseCommand: `agent-device close --session ${owner ?? '<owner>'}`,
          canReclaim: options.onDeviceInUse === 'fail',
        });
      }
      await driver.close(owner);
      return await driver.open(request);
    }
    if (failure.kind === 'session-rebound') {
      await driver.close(name);
      return await driver.open(request);
    }
    throw new TouchpressError({
      kind: 'launch-failed',
      app: options.app,
      device: deviceName ?? options.platform,
      failure,
    });
  }
}

function createSession(
  driver: DeviceDriver,
  options: ResolvedOptions,
  name: string,
  binding: Binding,
): DeviceSession {
  const queue = createQueue();
  let state: SessionState = { phase: 'ready', binding };
  let testsBegun = 0;

  // The settle is best-effort upstream, so a short remaining budget costs settling, never the action.
  const settle = (budgetMs: number) => ({
    settleQuietMs: options.settleQuietMs,
    timeoutMs: Math.max(budgetMs, options.settleQuietMs),
  });

  const device: SessionDevice = {
    capture: async () =>
      parseScreen(
        await driver.capture({ timeoutMs: SNAPSHOT_TIMEOUT_MS, tree: 'default' }),
        options.platform,
      ),
    captureRaw: async () =>
      parseScreen(
        await driver.capture({ timeoutMs: SNAPSHOT_TIMEOUT_MS, tree: 'raw' }),
        options.platform,
      ),
    tap: (ref, budgetMs) => driver.tap(ref, settle(budgetMs)),
    longPress: (ref, durationMs, budgetMs) => driver.longPress(ref, durationMs, settle(budgetMs)),
    fill: (ref, text, budgetMs) => driver.fill(ref, text, settle(budgetMs)),
    back: (mode, budgetMs) => driver.back(mode, settle(budgetMs)),
    type: (text, budgetMs) => driver.type(text, settle(budgetMs)),
    clearAppState: (app) => driver.clearAppState(app),
    resetKeychain: () => driver.resetKeychain(),
    scroll: (direction, budgetMs) => driver.scroll(direction, settle(budgetMs)),
  };

  function run<T>(body: (device: SessionDevice) => Promise<T>): Promise<T> {
    return queue.enqueue(async () => {
      if (state.phase !== 'ready') throw unusable(state);
      try {
        return await body(device);
      } catch (error) {
        const failure = failureOf(error);
        if (failure !== null && breaksTheSession(failure)) state = { phase: 'broken', failure };
        throw error;
      }
    });
  }

  async function awaitReady(deadline: number): Promise<void> {
    const started = Date.now();
    let screen: Screen;
    for (;;) {
      screen = await run((one) => one.capture());
      // Ambiguity is still ready. This gate asks whether the bundle loaded, not whether a locator is unique.
      if (resolve(screen, options.readyWhen).outcome !== 'none') return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(READY_POLL_MS, remaining));
    }
    throw new TouchpressError({
      kind: 'not-ready',
      locator: describeQuery(options.readyWhen),
      timeoutMs: Date.now() - started,
      screen: renderScreen(screen),
    });
  }

  function relaunch(sink: ActionSink): Promise<void> {
    return sink.step(renderTitle({ kind: 'relaunch', app: options.app }), async () => {
      // Relaunching with the session's own selection is what keeps `open` legal on an already-bound session.
      await run(() => driver.open({ app: options.app, relaunch: true, url: options.launchUrl }));
      if (options.dismissDevOverlay) await run(() => driver.dismissDevOverlay());
      await awaitReady(Date.now() + options.launchTimeout);
    });
  }

  return {
    name,
    options,
    state: () => state,
    failure: () => (state.phase === 'broken' ? state.failure : null),
    run,
    screen: () => run((one) => one.capture()),
    screenshot: (path) => queue.enqueue(() => driver.screenshot(path)),
    relaunch,
    beginTest: async (sink) => {
      if (testsBegun > 0 && options.relaunch === 'per-test') await relaunch(sink);
      testsBegun += 1;
    },
    clearState: (sink) =>
      sink.step(renderTitle({ kind: 'clear-state', app: options.app }), async () => {
        await run((one) => one.clearAppState(options.app));
        await relaunch(sink);
      }),
    clearKeychain: (sink) =>
      sink.step(renderTitle({ kind: 'clear-keychain' }), async () => {
        if (options.platform === 'android')
          sink.note('keychain', 'nothing to reset on Android, clearing state covers the keystore');
        await run((one) => one.resetKeychain());
      }),
    dismissDevOverlay: () => run(() => driver.dismissDevOverlay()),
    awaitReady,
    close: async (reason) => {
      if (state.phase === 'closed') return;
      try {
        await driver.close(name);
      } finally {
        state = { phase: 'closed', reason };
      }
    },
  };
}

function unusable(state: SessionState): TouchpressError {
  if (state.phase === 'broken')
    return new TouchpressError({
      kind: 'driver',
      command: 'device command',
      failure: state.failure,
    });
  return new TouchpressError({ kind: 'session-closed', command: 'run a device command' });
}

/**
 * Only a failure meaning the device or the session itself is gone breaks the
 * session. A stale ref, an ambiguous match, or one timed-out command is a
 * per-command outcome the caller recovers from.
 */
function breaksTheSession(failure: DeviceFailure): boolean {
  return (
    failure.kind === 'device-busy' ||
    failure.kind === 'device-missing' ||
    failure.kind === 'session-rebound'
  );
}

/** Deterministic, so a worker replaced after a failure reconnects to the session it left behind. */
export function sessionName(options: ResolvedOptions, project: string, slot: number): string {
  return `${options.sessionPrefix}-${project === '' ? 'default' : project}-${String(slot)}`;
}

export function failureOf(error: unknown): DeviceFailure | null {
  if (!(error instanceof TouchpressError)) return null;
  if (error.info.kind === 'driver') return error.info.failure;
  if (error.info.kind === 'launch-failed') return error.info.failure;
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
