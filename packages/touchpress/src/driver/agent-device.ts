import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentDeviceClient, normalizeAgentDeviceError } from 'agent-device';
import type { Target } from '../core/config.ts';
import type {
  BackMode,
  Binding,
  DeviceDriver,
  DeviceFailure,
  DeviceInfo,
  DeviceSelection,
  OpenRequest,
  ScrollDirection,
  Settled,
  SettleOptions,
} from '../core/driver.ts';
import { TouchpressError } from '../core/errors.ts';
import type { PinnedRef, RawSnapshot } from '../core/screen.ts';

/** agent-device's root entry exports values only, so the client type is derived here and nowhere else. */
type Client = ReturnType<typeof createAgentDeviceClient>;
type ClientConfig = NonNullable<Parameters<typeof createAgentDeviceClient>[0]>;

/** `full` is explicit because a digest-level response omits `nodes`, and the whole library matches on nodes. */
export function createClient(target: Target): Client {
  return createAgentDeviceClient({ responseLevel: 'full', ...clientConfigFor(target) });
}

/**
 * The one place a `Target` becomes agent-device's own vocabulary. No credential passes through
 * here, because agent-device reads every one of them from the environment itself.
 *
 * A key is left out rather than set to `undefined`, so what reaches agent-device is only what the
 * project actually configured.
 */
export function clientConfigFor(target: Target): ClientConfig {
  switch (target.kind) {
    case 'local':
      return {};
    case 'browserstack':
      return {
        leaseProvider: 'browserstack',
        providerApp: target.app,
        providerOsVersion: target.osVersion,
        ...(target.project === null ? {} : { providerProject: target.project }),
        ...(target.build === null ? {} : { providerBuild: target.build }),
        ...(target.sessionName === null ? {} : { providerSessionName: target.sessionName }),
        ...(target.orientation === null ? {} : { providerDeviceOrientation: target.orientation }),
        ...(target.geoLocation === null ? {} : { providerGeoLocation: target.geoLocation }),
        ...(target.timezone === null ? {} : { providerTimezone: target.timezone }),
        ...(target.language === null ? {} : { providerLanguage: target.language }),
        ...(target.locale === null ? {} : { providerLocale: target.locale }),
        ...(target.networkProfile === null
          ? {}
          : { providerNetworkProfile: target.networkProfile }),
        ...(target.customNetwork === null ? {} : { providerCustomNetwork: target.customNetwork }),
        ...(target.noResignApp ? { providerNoResignApp: true } : {}),
      };
    case 'aws-device-farm':
      return {
        leaseProvider: 'aws-device-farm',
        awsProjectArn: target.projectArn,
        awsDeviceArn: target.deviceArn,
        ...(target.appArn === null ? {} : { awsAppArn: target.appArn }),
        ...(target.region === null ? {} : { awsRegion: target.region }),
        ...(target.interactionMode === null ? {} : { awsInteractionMode: target.interactionMode }),
        ...(target.sessionName === null ? {} : { providerSessionName: target.sessionName }),
      };
    case 'limrun':
      return { leaseProvider: 'limrun' };
    default: {
      const never: never = target;
      throw new Error(`unhandled target ${JSON.stringify(never)}`);
    }
  }
}

/** The seam a test observes instead of spawning a process. */
export type RunCommand = (file: string, args: readonly string[]) => Promise<void>;

const execFileAsync = promisify(execFile);

const spawnCommand: RunCommand = async (file, args) => {
  await execFileAsync(file, [...args]);
};

/**
 * The only file that imports `agent-device`. Two jobs: translate domain requests
 * into client calls carrying the session and device selection, and translate the
 * driver's error codes into `DeviceFailure`. Snapshot parsing is not one of
 * them, because role normalization and label rules live in `core/screen.ts`.
 */
export function createAgentDeviceDriver(
  client: Client,
  session: string,
  selection: DeviceSelection,
  runCommand: RunCommand = spawnCommand,
): DeviceDriver {
  const where = {
    session,
    platform: selection.platform,
    ...(selection.name === null ? {} : { device: selection.name }),
  };
  // Only `open` learns the simulator identifier, and `resetKeychain` is the one call that needs it.
  let udid: string | null = null;

  async function run<T>(command: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw new TouchpressError({ kind: 'driver', command, failure: classifyError(error) });
    }
  }

  return {
    listDevices: (): Promise<readonly DeviceInfo[]> =>
      run('listDevices', async () => {
        // Only the platform crosses: naming the session here would bind it, and preflight must bind nothing.
        const devices = await client.devices.list({ platform: selection.platform });
        return devices.map((device) => ({
          id: device.id,
          name: device.name,
          booted: device.booted ?? false,
        }));
      }),

    open: (request: OpenRequest): Promise<Binding> =>
      run('open', async () => {
        if (request.install !== null) {
          await client.apps.install({ ...where, app: request.app, appPath: request.install });
        }
        const result = await client.apps.open({
          ...where,
          app: request.app,
          relaunch: request.relaunch,
          ...(request.url === null ? {} : { url: request.url }),
        });
        udid = result.identifiers.udid ?? result.identifiers.deviceId ?? null;
        return {
          session: result.session,
          platform: selection.platform,
          deviceLabel:
            result.device?.name ??
            result.identifiers.deviceName ??
            selection.name ??
            selection.platform,
          appId: result.appBundleId ?? result.appId ?? request.app,
          stateDir: result.sessionStateDir ?? null,
          udid,
        };
      }),

    capture: (options): Promise<RawSnapshot> =>
      run('snapshot', () =>
        client.capture.snapshot({
          ...where,
          forceFull: true,
          raw: options.tree === 'raw',
          timeoutMs: options.timeoutMs,
        }),
      ),

    screenshot: (path: string): Promise<string> =>
      run('screenshot', async () => (await client.capture.screenshot({ ...where, path })).path),

    tap: (ref: PinnedRef, options: SettleOptions): Promise<Settled> =>
      run('tap', async () =>
        toSettled(await client.interactions.press({ ...where, ref, ...settle(options) })),
      ),

    longPress: (ref: PinnedRef, durationMs: number, options: SettleOptions): Promise<Settled> =>
      run('longPress', async () =>
        toSettled(
          await client.interactions.longPress({ ...where, ref, durationMs, ...settle(options) }),
        ),
      ),

    fill: (ref: PinnedRef, text: string, options: SettleOptions): Promise<Settled> =>
      run('fill', async () =>
        toSettled(await client.interactions.fill({ ...where, ref, text, ...settle(options) })),
      ),

    back: (mode: BackMode, options: SettleOptions): Promise<Settled> =>
      run('back', async () =>
        toSettled(await client.command.back({ ...where, mode, ...settle(options) })),
      ),

    /**
     * Scrubbed rather than run through `run`, because agent-device echoes the
     * text it rejected and a password has no business in a report.
     */
    type: async (text: string, _options: SettleOptions): Promise<Settled> => {
      if (looksLikeRef(text)) throw new TouchpressError({ kind: 'type-rejected' });
      try {
        await client.interactions.type({ ...where, text });
        // agent-device's `type` takes no settle and reports none, so nothing here may claim the screen went quiet.
        return { settled: false, waitedMs: 0 };
      } catch (error) {
        throw new TouchpressError({
          kind: 'driver',
          command: 'type',
          failure: withoutText(classifyError(error), text),
        });
      }
    },

    clearAppState: (app: string): Promise<void> =>
      run('clearAppState', async () => {
        await client.settings.update({
          ...where,
          setting: 'clear-app-state',
          state: 'clear',
          app,
        });
      }),

    /**
     * agent-device has no keychain command, and the simulator keychain is where
     * clerk-ios and expo-secure-store keep a session. Lives in the driver
     * because it needs the udid and a process, neither of which the core has.
     */
    resetKeychain: (): Promise<void> =>
      run('resetKeychain', async () => {
        // Android keeps an app's keystore entries with its data, so clearing the app already removed them.
        // `simctl` reaches a simulator on this machine and nothing else, so a hosted device has no reset.
        if (selection.platform !== 'ios' || selection.target.kind !== 'local') return;
        // `booted` is simctl's own alias for the one running simulator, for a session opened
        // by a daemon that did not report the identifier.
        await runCommand('xcrun', ['simctl', 'keychain', udid ?? 'booted', 'reset']);
      }),

    scroll: (direction: ScrollDirection, options: SettleOptions): Promise<void> =>
      run('scroll', async () => {
        await client.interactions.scroll({ ...where, direction, ...settle(options) });
      }),

    dismissDevOverlay: (): Promise<void> =>
      run('dismissDevOverlay', async () => {
        await client.command.reactNative({ ...where, action: 'dismiss-overlay' });
      }),

    close: (target: string): Promise<void> =>
      run('close', async () => {
        try {
          await client.sessions.close({ session: target });
        } catch (error) {
          // Closing a session that is already gone is the desired end state.
          if (readNormalized(error).code !== 'SESSION_NOT_FOUND') throw error;
        }
      }),
  };
}

function settle(options: SettleOptions): {
  settle: true;
  settleQuietMs: number;
  timeoutMs: number;
} {
  return { settle: true, settleQuietMs: options.settleQuietMs, timeoutMs: options.timeoutMs };
}

/** `settle` is best-effort upstream and never fails an action, so an absent observation is not an error. */
function toSettled(result: { settle?: { settled: boolean; waitedMs: number } }): Settled {
  return { settled: result.settle?.settled ?? false, waitedMs: result.settle?.waitedMs ?? 0 };
}

function readNormalized(error: unknown): {
  code: string;
  message: string;
  logPath?: string;
  details?: Record<string, unknown>;
} {
  return normalizeAgentDeviceError(error);
}

/**
 * agent-device 0.20.10's own check, copied rather than approximated so the two
 * agree on what it will refuse. `@e12` and `@ref-x` are refs, while `@word` and
 * `@ home` are text.
 */
export function looksLikeRef(text: string): boolean {
  const word = text.trim().split(/\s+/, 1)[0];
  if (word === undefined || !word.startsWith('@') || word.length < 3) return false;
  const rest = word.slice(1);
  return /^[A-Za-z_-]*\d[\w-]*$/i.test(rest) || /^(?:ref|node|element|el)[\w-]*$/i.test(rest);
}

/** Every failure kind carries a `detail`, and the driver puts what it was given into it. */
function withoutText(failure: DeviceFailure, text: string): DeviceFailure {
  if (text === '') return failure;
  return { ...failure, detail: failure.detail.split(text).join('<typed text>') };
}

/**
 * Timeouts and transport faults both arrive as `COMMAND_FAILED`, so the message
 * and `details.reason` separate them. That matches against upstream text, and it
 * is confined to this function for exactly that reason.
 */
export function classifyError(error: unknown): DeviceFailure {
  const normalized = readNormalized(error);
  const { code, message } = normalized;
  const details = normalized.details ?? {};
  const logPath = normalized.logPath ?? null;

  switch (code) {
    case 'DEVICE_IN_USE':
      return { kind: 'device-busy', owner: ownerOf(details, message), detail: message };
    case 'DEVICE_NOT_FOUND':
      return { kind: 'device-missing', detail: message };
    case 'APP_NOT_INSTALLED':
      return { kind: 'app-missing', detail: message };
    case 'AMBIGUOUS_MATCH':
      return { kind: 'ambiguous', detail: message };
    case 'INVALID_ARGS': {
      const bound = /bound to (.+?)(?:[.]|$)/i.exec(message);
      if (bound !== null)
        return { kind: 'session-rebound', boundTo: bound[1] ?? message, detail: message };
      return { kind: 'unknown', code, detail: message, logPath };
    }
    case 'COMMAND_FAILED':
      if (details['reason'] === 'ref_generation_mismatch')
        return { kind: 'stale-ref', detail: message };
      if (details['reason'] === 'covered_by_interactive_descendants')
        return { kind: 'covered', detail: message };
      if (/timed out|timeout/i.test(message)) return { kind: 'timeout', detail: message };
      return { kind: 'unknown', code, detail: message, logPath };
    default:
      return { kind: 'unknown', code, detail: message, logPath };
  }
}

/**
 * A device claim made in another workspace does not appear in a session listing
 * run from here, so the owning session name in the error is the only way to name
 * it. It arrives in `details` on some paths and only in the message text
 * (`by session "lex"`) on others.
 */
function ownerOf(details: Record<string, unknown>, message: string): string | null {
  for (const key of ['session', 'owner', 'ownerSession']) {
    const value = details[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const quoted = /by session "([^"]+)"/.exec(message);
  return quoted?.[1] ?? null;
}
