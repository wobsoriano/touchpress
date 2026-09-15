import { AppError } from 'agent-device';
import { expect, test } from 'vite-plus/test';
import type { Target } from '../src/core/config.ts';
import type { DeviceSelection } from '../src/core/driver.ts';
import { TouchpressError } from '../src/core/errors.ts';
import {
  classifyError,
  clientConfigFor,
  createAgentDeviceDriver,
  looksLikeRef,
  type RunCommand,
} from '../src/driver/agent-device.ts';

type Client = Parameters<typeof createAgentDeviceDriver>[0];

/** Only the calls the driver under test makes, stood up as a literal so no daemon is involved. */
function stubClient(overrides: Record<string, unknown>): Client {
  const noop = () => Promise.resolve({});
  return {
    apps: {
      install: noop,
      open: () =>
        Promise.resolve({
          session: 'touchpress-ios-0',
          identifiers: { udid: 'A1B2C3', deviceName: 'iPhone 17 Pro Max' },
        }),
    },
    interactions: { type: noop },
    settings: { update: noop },
    ...overrides,
  } as unknown as Client;
}

const LOCAL: Target = { kind: 'local', device: { kind: 'first-booted' } };

const BROWSERSTACK: Target = {
  kind: 'browserstack',
  device: { kind: 'named', name: 'iPhone 15' },
  app: 'bs://abc123',
  osVersion: '17',
  project: null,
  build: null,
  sessionName: null,
  orientation: null,
  geoLocation: null,
  timezone: null,
  language: null,
  locale: null,
  networkProfile: null,
  customNetwork: null,
  noResignApp: false,
};

function driverFor(
  selection: Omit<DeviceSelection, 'target'> & { target?: Target },
  runCommand: RunCommand,
  overrides: Record<string, unknown> = {},
) {
  return createAgentDeviceDriver(
    stubClient(overrides),
    'touchpress-ios-0',
    { ...selection, target: selection.target ?? LOCAL },
    runCommand,
  );
}

function recordingRunCommand(): RunCommand & { readonly ran: string[] } {
  const ran: string[] = [];
  const run = (file: string, args: readonly string[]) => {
    ran.push([file, ...args].join(' '));
    return Promise.resolve();
  };
  return Object.assign(run, { ran });
}

test('a claimed device reads its owner from the details bag', () => {
  const failure = classifyError(
    new AppError('DEVICE_IN_USE', 'Device is already in use', { session: 'lex' }),
  );
  expect(failure).toEqual({
    kind: 'device-busy',
    owner: 'lex',
    detail: 'Device is already in use',
  });
});

test('a claimed device falls back to the owner named in the message', () => {
  const failure = classifyError(
    new AppError('DEVICE_IN_USE', `Device is already in use by session "lex"`),
  );
  expect(failure.kind).toBe('device-busy');
  if (failure.kind !== 'device-busy') return;
  expect(failure.owner).toBe('lex');
});

test('a superseded ref generation is a stale ref, not an unknown command failure', () => {
  const failure = classifyError(
    new AppError('COMMAND_FAILED', 'Ref @e15 was minted from a superseded snapshot generation', {
      reason: 'ref_generation_mismatch',
      ref: '@e15',
      currentGeneration: 118062,
    }),
  );
  expect(failure.kind).toBe('stale-ref');
});

test('a node the driver will not tap is a covered failure, not an unknown one', () => {
  const failure = classifyError(
    new AppError(
      'COMMAND_FAILED',
      '@e44 has no parent-owned touch point outside its interactive descendants',
      { reason: 'covered_by_interactive_descendants', competitorRefs: ['@e45'] },
    ),
  );
  expect(failure).toEqual({
    kind: 'covered',
    detail: '@e44 has no parent-owned touch point outside its interactive descendants',
  });
});

test('a command timeout is separated from a transport fault under the same code', () => {
  expect(classifyError(new AppError('COMMAND_FAILED', 'wait timed out for text: Home')).kind).toBe(
    'timeout',
  );
  const other = classifyError(
    new AppError('COMMAND_FAILED', 'runner crashed', { logPath: '/tmp/run.ndjson' }),
  );
  expect(other).toEqual({
    kind: 'unknown',
    code: 'COMMAND_FAILED',
    detail: 'runner crashed',
    logPath: '/tmp/run.ndjson',
  });
});

test('a session bound to another device carries what it was bound to', () => {
  const failure = classifyError(
    new AppError(
      'INVALID_ARGS',
      'open is already bound to session touchpress-ios-0 on android device emulator-5554',
    ),
  );
  expect(failure.kind).toBe('session-rebound');
  if (failure.kind !== 'session-rebound') return;
  expect(failure.boundTo).toBe('session touchpress-ios-0 on android device emulator-5554');
});

test('the remaining codes map onto their own kinds', () => {
  expect(classifyError(new AppError('DEVICE_NOT_FOUND', 'no device')).kind).toBe('device-missing');
  expect(classifyError(new AppError('APP_NOT_INSTALLED', 'not installed')).kind).toBe(
    'app-missing',
  );
  expect(classifyError(new AppError('AMBIGUOUS_MATCH', 'matched multiple')).kind).toBe('ambiguous');
  expect(classifyError(new AppError('INVALID_ARGS', 'bad flag')).kind).toBe('unknown');
  expect(classifyError(new Error('something else')).kind).toBe('unknown');
});

test('looksLikeRef copies what agent-device refuses and leaves ordinary text alone', () => {
  expect(looksLikeRef('@e12')).toBe(true);
  expect(looksLikeRef('@Word12')).toBe(true);
  expect(looksLikeRef('@ref-x')).toBe(true);
  expect(looksLikeRef('@')).toBe(false);
  expect(looksLikeRef('@x')).toBe(false);
  expect(looksLikeRef('@word')).toBe(false);
  expect(looksLikeRef('@ home')).toBe(false);
});

test('type refuses ref-shaped text before sending it, and the error never holds the text', async () => {
  const sent: string[] = [];
  const driver = driverFor({ platform: 'ios', name: null }, recordingRunCommand(), {
    interactions: {
      type: (options: { text: string }) => {
        sent.push(options.text);
        return Promise.resolve({});
      },
    },
  });

  const error = await driver
    .type('@e12', { settleQuietMs: 100, timeoutMs: 600 })
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('type-rejected');
  expect(error.message).not.toContain('@e12');
  expect(sent).toEqual([]);
});

test('a failure raised from type carries no trace of what was typed', async () => {
  const driver = driverFor({ platform: 'ios', name: null }, recordingRunCommand(), {
    interactions: {
      type: () =>
        Promise.reject(new AppError('COMMAND_FAILED', 'could not type "hunter2" into the field')),
    },
  });

  const error = await driver
    .type('hunter2', { settleQuietMs: 100, timeoutMs: 600 })
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.message).not.toContain('hunter2');
  expect(error.message).toContain('<typed text>');
});

test('clearing state clears the app and touches nothing else', async () => {
  const runCommand = recordingRunCommand();
  const updates: Record<string, unknown>[] = [];
  const driver = driverFor({ platform: 'ios', name: null }, runCommand, {
    settings: {
      update: (options: Record<string, unknown>) => {
        updates.push(options);
        return Promise.resolve({});
      },
    },
  });
  await driver.open({ app: 'com.example.app', relaunch: true, url: null, install: null });
  await driver.clearAppState('com.example.app');
  expect(updates).toEqual([
    expect.objectContaining({ setting: 'clear-app-state', state: 'clear', app: 'com.example.app' }),
  ]);
  expect(runCommand.ran).toEqual([]);
});

test('resetting the keychain names the iOS simulator the driver reported', async () => {
  const runCommand = recordingRunCommand();
  const driver = driverFor({ platform: 'ios', name: null }, runCommand);
  await driver.open({ app: 'com.example.app', relaunch: true, url: null, install: null });
  await driver.resetKeychain();
  expect(runCommand.ran).toEqual(['xcrun simctl keychain A1B2C3 reset']);
});

test('an iOS session with no reported identifier resets the booted simulator', async () => {
  const unopened = recordingRunCommand();
  await driverFor({ platform: 'ios', name: null }, unopened).resetKeychain();
  expect(unopened.ran).toEqual(['xcrun simctl keychain booted reset']);
});

test('resetting the keychain runs nothing on Android', async () => {
  const android = recordingRunCommand();
  const androidDriver = driverFor({ platform: 'android', name: null }, android);
  await androidDriver.open({ app: 'com.example.app', relaunch: true, url: null, install: null });
  await androidDriver.resetKeychain();
  expect(android.ran).toEqual([]);
});

test('a local target sends agent-device no provider configuration at all', () => {
  expect(clientConfigFor(LOCAL)).toStrictEqual({});
});

test('a BrowserStack target maps onto agent-device, and an unset field sends no key', () => {
  const bare: Target = {
    kind: 'browserstack',
    device: { kind: 'named', name: 'Google Pixel 8' },
    app: 'bs://abc123',
    osVersion: '14.0',
    project: null,
    build: null,
    sessionName: null,
    orientation: null,
    geoLocation: null,
    timezone: null,
    language: null,
    locale: null,
    networkProfile: null,
    customNetwork: null,
    noResignApp: false,
  };
  // Strict, because `toEqual` would let a `providerProject: undefined` key through and agent-device
  // merges this config into every request, where such a key overrides a per-call value with nothing.
  expect(clientConfigFor(bare)).toStrictEqual({
    leaseProvider: 'browserstack',
    providerApp: 'bs://abc123',
    providerOsVersion: '14.0',
  });

  expect(
    clientConfigFor({
      ...bare,
      project: 'checkout',
      build: '4711',
      sessionName: 'sign in',
      orientation: 'landscape',
      geoLocation: 'FR',
      timezone: 'Europe/Paris',
      language: 'fr',
      locale: 'fr_FR',
      customNetwork: '1000 1000 50 0',
      noResignApp: true,
    }),
  ).toStrictEqual({
    leaseProvider: 'browserstack',
    providerApp: 'bs://abc123',
    providerOsVersion: '14.0',
    providerProject: 'checkout',
    providerBuild: '4711',
    providerSessionName: 'sign in',
    providerDeviceOrientation: 'landscape',
    providerGeoLocation: 'FR',
    providerTimezone: 'Europe/Paris',
    providerLanguage: 'fr',
    providerLocale: 'fr_FR',
    providerCustomNetwork: '1000 1000 50 0',
    providerNoResignApp: true,
  });

  // The two network keys exclude each other upstream, so the named profile needs its own case.
  expect(clientConfigFor({ ...bare, networkProfile: '4g-lte-lossy' })).toStrictEqual({
    leaseProvider: 'browserstack',
    providerApp: 'bs://abc123',
    providerOsVersion: '14.0',
    providerNetworkProfile: '4g-lte-lossy',
  });
});

test('an AWS target maps its ARNs, and its session name rides on the shared provider key', () => {
  const bare: Target = {
    kind: 'aws-device-farm',
    projectArn: 'arn:project',
    deviceArn: 'arn:device',
    appArn: null,
    region: null,
    interactionMode: null,
    sessionName: null,
  };
  expect(clientConfigFor(bare)).toStrictEqual({
    leaseProvider: 'aws-device-farm',
    awsProjectArn: 'arn:project',
    awsDeviceArn: 'arn:device',
  });
  expect(
    clientConfigFor({
      ...bare,
      appArn: 'arn:app',
      region: 'eu-west-1',
      interactionMode: 'NO_VIDEO',
      sessionName: 'sign in',
    }),
  ).toStrictEqual({
    leaseProvider: 'aws-device-farm',
    awsProjectArn: 'arn:project',
    awsDeviceArn: 'arn:device',
    awsAppArn: 'arn:app',
    awsRegion: 'eu-west-1',
    awsInteractionMode: 'NO_VIDEO',
    providerSessionName: 'sign in',
  });
});

test('a Limrun target names the provider and nothing else, because it takes no selector', () => {
  expect(clientConfigFor({ kind: 'limrun', install: './app.apk' })).toStrictEqual({
    leaseProvider: 'limrun',
  });
});

test('an open carrying an artifact installs it before it launches the app', async () => {
  const calls: string[] = [];
  const driver = driverFor({ platform: 'android', name: null }, recordingRunCommand(), {
    apps: {
      install: (options: { app?: string; appPath: string }) => {
        calls.push(`install ${String(options.app)} ${options.appPath}`);
        return Promise.resolve({});
      },
      open: (options: { app?: string }) => {
        calls.push(`open ${String(options.app)}`);
        return Promise.resolve({ session: 'touchpress-android-0', identifiers: {} });
      },
    },
  });

  await driver.open({
    app: 'com.example.app',
    relaunch: true,
    url: null,
    install: './build/app.apk',
  });

  expect(calls).toEqual(['install com.example.app ./build/app.apk', 'open com.example.app']);
});

test('an open with nothing to install goes straight to the launch', async () => {
  const calls: string[] = [];
  const driver = driverFor({ platform: 'android', name: null }, recordingRunCommand(), {
    apps: {
      install: () => {
        calls.push('install');
        return Promise.resolve({});
      },
      open: () => {
        calls.push('open');
        return Promise.resolve({ session: 'touchpress-android-0', identifiers: {} });
      },
    },
  });

  await driver.open({ app: 'com.example.app', relaunch: true, url: null, install: null });

  expect(calls).toEqual(['open']);
});

test('resetting the keychain runs nothing on a hosted iOS device', async () => {
  const browserstack = recordingRunCommand();
  const hosted = driverFor(
    { platform: 'ios', name: 'iPhone 15', target: BROWSERSTACK },
    browserstack,
  );
  await hosted.open({ app: 'com.example.app', relaunch: true, url: null, install: null });
  await hosted.resetKeychain();
  expect(browserstack.ran).toEqual([]);

  const limrun = recordingRunCommand();
  const fresh = driverFor(
    { platform: 'ios', name: null, target: { kind: 'limrun', install: './app.app' } },
    limrun,
  );
  await fresh.open({ app: 'com.example.app', relaunch: true, url: null, install: './app.app' });
  await fresh.resetKeychain();
  expect(limrun.ran).toEqual([]);
});
