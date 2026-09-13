import { AppError } from 'agent-device';
import { expect, test } from 'vite-plus/test';
import type { DeviceSelection } from '../src/core/driver.ts';
import { TouchpressError } from '../src/core/errors.ts';
import {
  classifyError,
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

function driverFor(
  selection: DeviceSelection,
  runCommand: RunCommand,
  overrides: Record<string, unknown> = {},
) {
  return createAgentDeviceDriver(stubClient(overrides), 'touchpress-ios-0', selection, runCommand);
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
  await driver.open({ app: 'com.example.app', relaunch: true, url: null });
  await driver.clearAppState('com.example.app');
  expect(updates).toEqual([
    expect.objectContaining({ setting: 'clear-app-state', state: 'clear', app: 'com.example.app' }),
  ]);
  expect(runCommand.ran).toEqual([]);
});

test('resetting the keychain names the iOS simulator the driver reported', async () => {
  const runCommand = recordingRunCommand();
  const driver = driverFor({ platform: 'ios', name: null }, runCommand);
  await driver.open({ app: 'com.example.app', relaunch: true, url: null });
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
  await androidDriver.open({ app: 'com.example.app', relaunch: true, url: null });
  await androidDriver.resetKeychain();
  expect(android.ran).toEqual([]);
});

test('resetting the keychain runs nothing on macOS', async () => {
  const mac = recordingRunCommand();
  const macDriver = driverFor({ platform: 'macos', name: null }, mac);
  await macDriver.open({ app: 'com.example.app', relaunch: true, url: null });
  await macDriver.resetKeychain();
  expect(mac.ran).toEqual([]);
});
