import { TouchpressError } from './errors.ts';
import { textMatch, type Query, type Role } from './query.ts';
import type { Platform } from './screen.ts';

/**
 * The keys touchpress adds to Playwright's `use`. Each is its own option fixture, so
 * a project overrides one without restating the rest.
 *
 * Playwright types `use` as a partial of this, so a config may leave any key out.
 * `parseDeviceOptions` is what makes `platform`, `app`, and `readyWhen` required.
 * It runs once at worker start and nothing downstream re-validates.
 */
export type TouchpressOptions = {
  /** Required. */
  platform: Platform | undefined;
  /** Required. Bundle id on iOS, package name on Android. Never a path to an artifact. */
  app: string | undefined;
  /**
   * Required. `open` returns as soon as the native process launches, so without
   * this gate the first assertion would race the JavaScript bundle.
   */
  readyWhen: ReadyQuery | undefined;
  /**
   * Where the suite runs. Unset is the first booted local simulator or emulator.
   *
   * One key rather than one per field, so a project replaces the whole target in a single write
   * and Playwright's per-key `use` merge can never blend two providers.
   */
  target: TargetOptions | undefined;
  /**
   * A deep link to open the app with, on the launch and on every relaunch.
   * Unset launches the app plainly, which is what a release build wants. An
   * Expo development client needs one, because launching it plainly shows its
   * own server picker rather than the app.
   */
  launchUrl: string | undefined;
  /** @default 'per-test' */
  relaunch: 'per-test' | 'per-worker';
  /** @default 'fail'. Sessions carrying this library's own prefix are always reclaimed. */
  onDeviceInUse: 'fail' | 'reclaim';
  /** @default 500 */
  settleQuietMs: number;
  /** @default 90_000. Covers `open` plus the ready gate. */
  launchTimeout: number;
  /** @default false. Sends agent-device's `react-native dismiss-overlay` after every launch. */
  dismissDevOverlay: boolean;
  /** @default 'on-failure' */
  evidence: 'on-failure' | 'always' | 'off';
  /** @default 'touchpress'. Session names are `${prefix}-${project}-${parallelIndex}`. */
  sessionPrefix: string;
};

/**
 * The option fixtures declare these as their defaults and the parser falls back
 * to the same values, so a caller that reaches the parser without the fixtures,
 * such as `preflight`, resolves identically.
 */
export const TOUCHPRESS_DEFAULTS: Omit<
  TouchpressOptions,
  'platform' | 'app' | 'readyWhen' | 'target' | 'launchUrl'
> = {
  relaunch: 'per-test',
  onDeviceInUse: 'fail',
  settleQuietMs: 500,
  launchTimeout: 90_000,
  dismissDevOverlay: false,
  evidence: 'on-failure',
  sessionPrefix: 'touchpress',
};

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** The config-file friendly subset of a locator. Matched by the same rules as any other query. */
export type ReadyQuery =
  | { text: string; exact?: boolean }
  | { testId: string }
  | { role: Role; name?: string };

/**
 * The three cases are separate because only a pool can serve more than one
 * worker slot. A single name and "whatever is booted" both resolve to the same
 * device for every worker, and two workers on one device fight over the claim.
 */
export type DeviceChoice =
  | { readonly kind: 'first-booted' }
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'pool'; readonly names: readonly string[] };

/**
 * What `use.target` accepts. `provider` decides what the rest of the object means, which is why the
 * device selector sits inside it rather than beside it. agent-device reads every hosted provider's
 * credentials from the environment itself, so nothing here is a secret.
 */
export type TargetOptions =
  | {
      /** @default 'local' */
      provider?: 'local';
      /**
       * A booted simulator or emulator name. An array is a pool indexed by the runner's worker
       * slot. Unset means the first booted device.
       */
      name?: string | readonly string[];
    }
  | {
      provider: 'browserstack';
      /** The device exactly as BrowserStack lists it. An array is a pool indexed by worker slot. */
      name: string | readonly string[];
      /** bs:// reference, HTTP(S) URL, or local path. BrowserStack uploads a local path when it creates the session. */
      app: string;
      osVersion: string;
      project?: string;
      build?: string;
      sessionName?: string;
      orientation?: 'portrait' | 'landscape';
      geoLocation?: string;
      timezone?: string;
      language?: string;
      locale?: string;
      networkProfile?: string;
      customNetwork?: string;
      noResignApp?: boolean;
    }
  | {
      provider: 'aws-device-farm';
      projectArn: string;
      deviceArn: string;
      appArn?: string;
      /** Falls back to AWS_REGION / AWS_DEFAULT_REGION in the environment. */
      region?: string;
      interactionMode?: 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY';
      sessionName?: string;
    }
  | {
      provider: 'limrun';
      /** Local path or URL of the app artifact, installed on the fresh instance before the first launch. */
      install: string;
    };

/**
 * Where the suite runs, with every optional field resolved. The device selector is part of the
 * target rather than a sibling of it, because what a device name means is the target's to say.
 * BrowserStack needs one, AWS names its device by ARN, and Limrun takes none at all.
 */
export type Target =
  | { readonly kind: 'local'; readonly device: DeviceChoice }
  | {
      readonly kind: 'browserstack';
      readonly device: Extract<DeviceChoice, { kind: 'named' | 'pool' }>;
      readonly app: string;
      readonly osVersion: string;
      readonly project: string | null;
      readonly build: string | null;
      readonly sessionName: string | null;
      readonly orientation: 'portrait' | 'landscape' | null;
      readonly geoLocation: string | null;
      readonly timezone: string | null;
      readonly language: string | null;
      readonly locale: string | null;
      readonly networkProfile: string | null;
      readonly customNetwork: string | null;
      readonly noResignApp: boolean;
    }
  | {
      readonly kind: 'aws-device-farm';
      readonly projectArn: string;
      readonly deviceArn: string;
      readonly appArn: string | null;
      readonly region: string | null;
      readonly interactionMode: 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | null;
      readonly sessionName: string | null;
    }
  | { readonly kind: 'limrun'; readonly install: string };

/** Every optional field resolved. Constructed only by `parseDeviceOptions`, so internal code trusts it. */
export type ResolvedOptions = {
  readonly platform: Platform;
  readonly app: string;
  readonly readyWhen: Query;
  readonly target: Target;
  readonly launchUrl: string | null;
  readonly relaunch: 'per-test' | 'per-worker';
  readonly onDeviceInUse: 'fail' | 'reclaim';
  readonly actionTimeout: number;
  readonly settleQuietMs: number;
  readonly launchTimeout: number;
  readonly dismissDevOverlay: boolean;
  readonly evidence: 'on-failure' | 'always' | 'off';
  readonly sessionPrefix: string;
};

const ROLES: readonly Role[] = [
  'application',
  'window',
  'button',
  'text',
  'text-field',
  'secure-text-field',
  'link',
  'image',
  'switch',
  'slider',
  'tab-bar',
  'scroll-area',
  'cell',
  'alert',
  'other',
];

/**
 * The config boundary. Options arrive as `unknown` because a project can omit
 * any of them, or be written in JavaScript, and because `actionTimeout` rides
 * along from Playwright's own options. Every message names the key to fix.
 */
export function parseDeviceOptions(raw: unknown): ResolvedOptions {
  const platform = read(raw, 'platform');
  if (platform !== 'ios' && platform !== 'android')
    throw fail('platform', "must be 'ios' or 'android'.");

  const app = read(raw, 'app');
  if (typeof app !== 'string' || app.length === 0) {
    throw fail('app', 'must be the bundle id or package name of the app under test.');
  }

  return {
    platform,
    app,
    readyWhen: parseReadyWhen(read(raw, 'readyWhen')),
    target: parseTarget(read(raw, 'target')),
    launchUrl: optionalText('launchUrl', read(raw, 'launchUrl')),
    relaunch: oneOf(
      'relaunch',
      read(raw, 'relaunch'),
      ['per-test', 'per-worker'],
      TOUCHPRESS_DEFAULTS.relaunch,
    ),
    onDeviceInUse: oneOf(
      'onDeviceInUse',
      read(raw, 'onDeviceInUse'),
      ['fail', 'reclaim'],
      TOUCHPRESS_DEFAULTS.onDeviceInUse,
    ),
    actionTimeout: parseActionTimeout(read(raw, 'actionTimeout')),
    settleQuietMs: positive(
      'settleQuietMs',
      read(raw, 'settleQuietMs'),
      TOUCHPRESS_DEFAULTS.settleQuietMs,
    ),
    launchTimeout: positive(
      'launchTimeout',
      read(raw, 'launchTimeout'),
      TOUCHPRESS_DEFAULTS.launchTimeout,
    ),
    dismissDevOverlay: flag(
      'dismissDevOverlay',
      read(raw, 'dismissDevOverlay'),
      TOUCHPRESS_DEFAULTS.dismissDevOverlay,
    ),
    evidence: oneOf(
      'evidence',
      read(raw, 'evidence'),
      ['on-failure', 'always', 'off'],
      TOUCHPRESS_DEFAULTS.evidence,
    ),
    sessionPrefix: text(
      'sessionPrefix',
      read(raw, 'sessionPrefix'),
      TOUCHPRESS_DEFAULTS.sessionPrefix,
    ),
  };
}

/** A non-object source reads as every key unset, so a caller that passes nothing fails on the first required key. */
function read(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return key in source ? Reflect.get(source, key) : undefined;
}

/**
 * Playwright's own `use.actionTimeout`, not one of touchpress's. Playwright defaults
 * it to 0, which means "no timeout" there and would mean "give up at once" here,
 * so 0 falls back the way an unset value does.
 */
function parseActionTimeout(value: unknown): number {
  if (value === 0) return DEFAULT_ACTION_TIMEOUT_MS;
  return positive('actionTimeout', value, DEFAULT_ACTION_TIMEOUT_MS);
}

function parseReadyWhen(raw: unknown): Query {
  if (typeof raw !== 'object' || raw === null) {
    throw fail(
      'readyWhen',
      "is required. Name something that only appears once the bundle has loaded, such as { text: 'Welcome' }.",
    );
  }
  const wanted = read(raw, 'text');
  if (wanted !== undefined) {
    if (typeof wanted !== 'string' || wanted.length === 0)
      throw fail('readyWhen.text', 'must be a non-empty string.');
    return { name: textMatch(wanted, flag('readyWhen.exact', read(raw, 'exact'), false)) };
  }
  const testId = read(raw, 'testId');
  if (testId !== undefined) {
    if (typeof testId !== 'string' || testId.length === 0)
      throw fail('readyWhen.testId', 'must be a non-empty string.');
    return { testId: textMatch(testId, true) };
  }
  const wantedRole = read(raw, 'role');
  const role = ROLES.find((candidate) => candidate === wantedRole);
  if (role === undefined) {
    throw fail('readyWhen', 'must be one of { text }, { testId }, or { role, name }.');
  }
  const name = read(raw, 'name');
  if (name === undefined) return { role };
  if (typeof name !== 'string') throw fail('readyWhen.name', 'must be a string.');
  return { role, name: textMatch(name) };
}

function parseDeviceChoice(raw: unknown): DeviceChoice {
  if (raw === undefined) return { kind: 'first-booted' };
  if (typeof raw === 'string') {
    if (raw.length === 0) throw fail('target.name', 'must not be empty.');
    return { kind: 'named', name: raw };
  }
  if (!isStringArray(raw) || raw.length === 0) {
    throw fail('target.name', 'must be a device name or a non-empty array of device names.');
  }
  return { kind: 'pool', names: raw };
}

function isStringArray(raw: unknown): raw is readonly string[] {
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string');
}

const PROVIDERS = ['local', 'browserstack', 'aws-device-farm', 'limrun'] as const;

function parseTarget(raw: unknown): Target {
  if (raw === undefined) return { kind: 'local', device: { kind: 'first-booted' } };
  // A bare device name reads as an object with no keys, so without this it would silently resolve
  // to the first booted device rather than to the one it names.
  if (typeof raw !== 'object' || raw === null) {
    throw fail(
      'target',
      "must be an object, such as { name: 'iPhone 17 Pro Max' } or { provider: 'browserstack', ... }.",
    );
  }
  const at = (key: string): unknown => read(raw, key);
  const optional = (key: string): string | null => optionalText(`target.${key}`, at(key));

  switch (oneOf('target.provider', at('provider'), PROVIDERS, 'local')) {
    case 'local':
      return { kind: 'local', device: parseDeviceChoice(at('name')) };
    case 'browserstack': {
      const networkProfile = optional('networkProfile');
      const customNetwork = optional('customNetwork');
      if (networkProfile !== null && customNetwork !== null) {
        throw fail(
          'target.networkProfile',
          'and use.target.customNetwork cannot both be set. Choose a named profile or a custom network.',
        );
      }
      return {
        kind: 'browserstack',
        device: browserstackDevice(at('name')),
        app: required(
          'target.app',
          at('app'),
          'is required. Give a bs:// reference, an HTTP(S) URL, or a local path to the app artifact.',
        ),
        osVersion: required(
          'target.osVersion',
          at('osVersion'),
          "is required. Name the OS version BrowserStack lists for the device, such as '14.0'.",
        ),
        project: optional('project'),
        build: optional('build'),
        sessionName: optional('sessionName'),
        orientation: optionalOneOf('target.orientation', at('orientation'), [
          'portrait',
          'landscape',
        ]),
        geoLocation: optional('geoLocation'),
        timezone: optional('timezone'),
        language: optional('language'),
        locale: optional('locale'),
        networkProfile,
        customNetwork,
        noResignApp: flag('target.noResignApp', at('noResignApp'), false),
      };
    }
    case 'aws-device-farm':
      if (at('name') !== undefined) {
        throw fail(
          'target.name',
          'must not be set on AWS Device Farm. The device is named by use.target.deviceArn.',
        );
      }
      return {
        kind: 'aws-device-farm',
        projectArn: required(
          'target.projectArn',
          at('projectArn'),
          'is required. Copy the ARN of the AWS Device Farm project to run in.',
        ),
        deviceArn: required(
          'target.deviceArn',
          at('deviceArn'),
          'is required. Copy the ARN of the AWS Device Farm device to run on.',
        ),
        appArn: optional('appArn'),
        region: optional('region'),
        interactionMode: optionalOneOf('target.interactionMode', at('interactionMode'), [
          'INTERACTIVE',
          'NO_VIDEO',
          'VIDEO_ONLY',
        ]),
        sessionName: optional('sessionName'),
      };
    case 'limrun':
      if (at('name') !== undefined) {
        throw fail(
          'target.name',
          'must not be set on Limrun. Limrun allocates a fresh instance and takes no device selector.',
        );
      }
      return {
        kind: 'limrun',
        install: required(
          'target.install',
          at('install'),
          'is required. Give the local path or URL of the app artifact. A fresh Limrun instance has no app on it.',
        ),
      };
  }
}

function browserstackDevice(raw: unknown): Extract<DeviceChoice, { kind: 'named' | 'pool' }> {
  const choice = parseDeviceChoice(raw);
  if (choice.kind === 'first-booted') {
    throw fail(
      'target.name',
      "is required on BrowserStack. Name the device exactly as BrowserStack lists it, such as 'Google Pixel 8'.",
    );
  }
  return choice;
}

/**
 * Locally, anything but a pool serves slot 0 only. Two workers pointed at one device both
 * try to claim it, and because leftovers carrying this library's session prefix
 * are always reclaimed, the second worker would close the first worker's live
 * session mid-test. That has to be a config error, not a race.
 *
 * That rule does not reach BrowserStack, where each worker opens its own hosted session on the
 * named device model rather than sharing one device.
 */
export function deviceNameForSlot(options: ResolvedOptions, slot: number): string | null {
  const target = options.target;
  switch (target.kind) {
    case 'local':
      return localDeviceForSlot(target.device, slot);
    case 'browserstack':
      if (target.device.kind === 'named') return target.device.name;
      return fromPool(target.device.names, slot);
    case 'aws-device-farm':
    case 'limrun':
      return null;
    default: {
      const never: never = target;
      throw new Error(`unhandled target ${JSON.stringify(never)}`);
    }
  }
}

function localDeviceForSlot(choice: DeviceChoice, slot: number): string | null {
  switch (choice.kind) {
    case 'first-booted':
      if (slot > 0)
        throw tooFewDevices('is unset, so every worker would target the same booted device', slot);
      return null;
    case 'named':
      if (slot > 0) throw tooFewDevices(`names one device, "${choice.name}"`, slot);
      return choice.name;
    case 'pool':
      return fromPool(choice.names, slot);
    default: {
      const never: never = choice;
      throw new Error(`unhandled device choice ${JSON.stringify(never)}`);
    }
  }
}

function fromPool(names: readonly string[], slot: number): string {
  const name = names[slot];
  if (name === undefined) throw tooFewDevices(`lists ${String(names.length)} devices`, slot);
  return name;
}

function tooFewDevices(problem: string, slot: number): TouchpressError {
  return fail(
    'target.name',
    `${problem}, but Playwright asked for worker slot ${String(slot)}. List one device name per worker, or set \`workers: 1\`.`,
  );
}

/** No fallback makes the field required. */
function oneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined)
    throw fail(field, `must be one of ${allowed.map((one) => `'${one}'`).join(', ')}.`);
  return found;
}

function optionalOneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (value === undefined) return null;
  return oneOf(field, value, allowed);
}

function positive(field: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw fail(field, 'must be a positive number of milliseconds.');
  }
  return value;
}

function flag(field: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw fail(field, 'must be true or false.');
  return value;
}

function optionalText(field: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0)
    throw fail(field, 'must be a non-empty string.');
  return value;
}

/** Carries its own detail, because what to put in a required device field differs for every one of them. */
function required(field: string, value: unknown, detail: string): string {
  if (typeof value !== 'string' || value.length === 0) throw fail(field, detail);
  return value;
}

function text(field: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0)
    throw fail(field, 'must be a non-empty string.');
  return value;
}

function fail(field: string, detail: string): TouchpressError {
  return new TouchpressError({ kind: 'config', field, detail });
}
