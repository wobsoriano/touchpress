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
  /** Device name. An array is a pool indexed by the runner's worker slot. Unset means the first booted device. */
  deviceName: string | readonly string[] | undefined;
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
  'platform' | 'app' | 'readyWhen' | 'deviceName' | 'launchUrl'
> = {
  relaunch: 'per-test',
  onDeviceInUse: 'fail',
  settleQuietMs: 500,
  launchTimeout: 90_000,
  dismissDevOverlay: false,
  evidence: 'on-failure',
  sessionPrefix: 'touchpress',
};

/**
 * The budget for one action when the runner supplies none. Playwright's own
 * `use.actionTimeout` overrides it, and the Vitest adapter declares it as the
 * default of its `actionTimeout` option, so there is one number, not two.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** Playwright's own `expect.timeout` default, so a spec moved between runners waits the same. */
export const DEFAULT_EXPECT_TIMEOUT_MS = 5_000;

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

/** Every optional field resolved. Constructed only by `parseDeviceOptions`, so internal code trusts it. */
export type ResolvedOptions = {
  readonly platform: Platform;
  readonly app: string;
  readonly readyWhen: Query;
  readonly device: DeviceChoice;
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
 * along from the runner's own options. Every message names the key to fix.
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
    device: parseDeviceChoice(read(raw, 'deviceName')),
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
    actionTimeout: parseTimeout(
      'actionTimeout',
      read(raw, 'actionTimeout'),
      DEFAULT_ACTION_TIMEOUT_MS,
    ),
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
 * Under Playwright `actionTimeout` is its own `use.actionTimeout`, not a
 * touchpress option. Playwright defaults it to 0, which means "no timeout"
 * there and would mean "give up at once" here, so 0 falls back the way an
 * unset value does.
 */
function parseTimeout(field: string, value: unknown, fallback: number): number {
  if (value === 0) return fallback;
  return positive(field, value, fallback);
}

/**
 * The Vitest adapter's `expectTimeout` option, by the rule `actionTimeout`
 * follows. It is not part of `ResolvedOptions` because Playwright hands a
 * matcher its timeout as `this.timeout` and exposes it nowhere else, so only
 * the runner with no assertion timeout of its own carries one.
 */
export function parseExpectTimeout(value: unknown): number {
  return parseTimeout('expectTimeout', value, DEFAULT_EXPECT_TIMEOUT_MS);
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
    if (raw.length === 0) throw fail('deviceName', 'must not be empty.');
    return { kind: 'named', name: raw };
  }
  if (!isStringArray(raw) || raw.length === 0) {
    throw fail('deviceName', 'must be a device name or a non-empty array of device names.');
  }
  return { kind: 'pool', names: raw };
}

function isStringArray(raw: unknown): raw is readonly string[] {
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string');
}

/**
 * Anything but a pool serves slot 0 only. Two workers pointed at one device both
 * try to claim it, and because leftovers carrying this library's session prefix
 * are always reclaimed, the second worker would close the first worker's live
 * session mid-test. That has to be a config error, not a race.
 */
export function deviceNameForSlot(options: ResolvedOptions, slot: number): string | null {
  const choice = options.device;
  switch (choice.kind) {
    case 'first-booted':
      if (slot > 0)
        throw tooFewDevices('is unset, so every worker would target the same booted device', slot);
      return null;
    case 'named':
      if (slot > 0) throw tooFewDevices(`names one device, "${choice.name}"`, slot);
      return choice.name;
    case 'pool': {
      const name = choice.names[slot];
      if (name === undefined) {
        throw tooFewDevices(`lists ${String(choice.names.length)} devices`, slot);
      }
      return name;
    }
    default: {
      const never: never = choice;
      throw new Error(`unhandled device choice ${JSON.stringify(never)}`);
    }
  }
}

function tooFewDevices(problem: string, slot: number): TouchpressError {
  return fail(
    'deviceName',
    `${problem}, but the runner asked for worker slot ${String(slot)}. List one device name per worker, or run one worker (\`workers: 1\` under Playwright, \`maxWorkers: 1\` under Vitest).`,
  );
}

function oneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined)
    throw fail(field, `must be one of ${allowed.map((one) => `'${one}'`).join(', ')}.`);
  return found;
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

function text(field: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0)
    throw fail(field, 'must be a non-empty string.');
  return value;
}

function fail(field: string, detail: string): TouchpressError {
  return new TouchpressError({ kind: 'config', field, detail });
}
