import { expect, test } from 'vite-plus/test';
import { deviceNameForSlot, parseDeviceOptions } from '../src/core/config.ts';
import { sessionName } from '../src/core/session.ts';

const minimal = { platform: 'ios', app: 'com.example.app', readyWhen: { text: 'GET STARTED' } };

test('parse fills every default', () => {
  const options = parseDeviceOptions(minimal);
  expect(options.relaunch).toBe('per-test');
  expect(options.onDeviceInUse).toBe('fail');
  expect(options.actionTimeout).toBe(10_000);
  expect(options.settleQuietMs).toBe(500);
  expect(options.launchTimeout).toBe(90_000);
  expect(options.dismissDevOverlay).toBe(false);
  expect(options.evidence).toBe('on-failure');
  expect(options.sessionPrefix).toBe('touchpress');
  expect(options.target).toEqual({ kind: 'local', device: { kind: 'first-booted' } });
  expect(options.launchUrl).toBe(null);
});

test('launchUrl passes through as given, and an empty one names itself', () => {
  const url = 'com.example.app://expo-development-client/?url=http://localhost:8081';
  expect(parseDeviceOptions({ ...minimal, launchUrl: url }).launchUrl).toBe(url);
  expect(() => parseDeviceOptions({ ...minimal, launchUrl: '' })).toThrow(/use\.launchUrl/);
  expect(() => parseDeviceOptions({ ...minimal, launchUrl: 8081 })).toThrow(/use\.launchUrl/);
});

test('the unset option fixture defaults are rejected, one required key at a time', () => {
  expect(() => parseDeviceOptions({ platform: undefined })).toThrow(/use\.platform/);
  expect(() => parseDeviceOptions({ platform: 'ios', app: undefined })).toThrow(/use\.app/);
  expect(() => parseDeviceOptions(undefined)).toThrow(/use\.platform/);
});

test('every field names itself when it is wrong', () => {
  expect(() => parseDeviceOptions({ ...minimal, platform: 'web' })).toThrow(/use\.platform/);
  expect(() => parseDeviceOptions({ ...minimal, app: '' })).toThrow(/use\.app/);
  expect(() => parseDeviceOptions({ platform: 'ios', app: 'a' })).toThrow(/use\.readyWhen/);
  expect(() => parseDeviceOptions({ ...minimal, readyWhen: { role: 'menu' } })).toThrow(
    /use\.readyWhen/,
  );
  expect(() => parseDeviceOptions({ ...minimal, evidence: 'sometimes' })).toThrow(/use\.evidence/);
  expect(() => parseDeviceOptions({ ...minimal, target: { name: [] } })).toThrow(
    /use\.target\.name/,
  );
});

test("Playwright's own actionTimeout drives an action, and its zero reads as unset", () => {
  expect(parseDeviceOptions({ ...minimal, actionTimeout: 4000 }).actionTimeout).toBe(4000);
  expect(parseDeviceOptions({ ...minimal, actionTimeout: 0 }).actionTimeout).toBe(10_000);
  expect(parseDeviceOptions({ ...minimal, actionTimeout: undefined }).actionTimeout).toBe(10_000);
  expect(() => parseDeviceOptions({ ...minimal, actionTimeout: -1 })).toThrow(/use\.actionTimeout/);
});

test('readyWhen accepts text, testId, and role forms', () => {
  expect(
    parseDeviceOptions({ ...minimal, readyWhen: { text: 'Hi', exact: true } }).readyWhen,
  ).toEqual({
    name: { kind: 'exact', value: 'Hi' },
  });
  expect(parseDeviceOptions({ ...minimal, readyWhen: { testId: 'root' } }).readyWhen).toEqual({
    testId: { kind: 'exact', value: 'root' },
  });
  expect(
    parseDeviceOptions({ ...minimal, readyWhen: { role: 'button', name: 'Home' } }).readyWhen,
  ).toEqual({
    role: 'button',
    name: { kind: 'substring', value: 'Home' },
  });
});

test('a device pool is indexed by worker slot and a short pool is a config error', () => {
  const pool = parseDeviceOptions({ ...minimal, target: { name: ['one', 'two'] } });
  expect(deviceNameForSlot(pool, 0)).toBe('one');
  expect(deviceNameForSlot(pool, 1)).toBe('two');
  expect(() => deviceNameForSlot(pool, 2)).toThrow(/worker slot 2/);
});

test("one device never serves a second worker, because the second would reclaim the first's session", () => {
  const named = parseDeviceOptions({ ...minimal, target: { name: 'iPhone 17 Pro Max' } });
  expect(deviceNameForSlot(named, 0)).toBe('iPhone 17 Pro Max');
  expect(() => deviceNameForSlot(named, 1)).toThrow(/one device, "iPhone 17 Pro Max"/);
  expect(() => deviceNameForSlot(named, 1)).toThrow(/workers: 1/);

  const booted = parseDeviceOptions(minimal);
  expect(deviceNameForSlot(booted, 0)).toBe(null);
  expect(() => deviceNameForSlot(booted, 1)).toThrow(
    /every worker would target the same booted device/,
  );

  const onePool = parseDeviceOptions({ ...minimal, target: { name: ['only'] } });
  expect(() => deviceNameForSlot(onePool, 1)).toThrow(/lists 1 devices/);
});

test('a target object with no provider is local, and an empty one is the first booted device', () => {
  expect(parseDeviceOptions({ ...minimal, target: {} }).target).toEqual({
    kind: 'local',
    device: { kind: 'first-booted' },
  });
  expect(parseDeviceOptions({ ...minimal, target: { name: 'iPhone 16' } }).target).toEqual({
    kind: 'local',
    device: { kind: 'named', name: 'iPhone 16' },
  });
});

test('a local pool is indexed by slot whether or not the provider is spelled out', () => {
  const spelled = parseDeviceOptions({
    ...minimal,
    target: { provider: 'local', name: ['one', 'two'] },
  });
  expect(spelled.target).toEqual({
    kind: 'local',
    device: { kind: 'pool', names: ['one', 'two'] },
  });
  expect(deviceNameForSlot(spelled, 1)).toBe('two');
  expect(() => deviceNameForSlot(spelled, 2)).toThrow(/worker slot 2/);
});

test('session names are deterministic so a replacement worker reuses one', () => {
  const options = parseDeviceOptions({ ...minimal, sessionPrefix: 'touchpress' });
  expect(sessionName(options, 'ios', 2)).toBe('touchpress-ios-2');
  expect(sessionName(options, '', 0)).toBe('touchpress-default-0');
});

test('aiModel rides along in `use` without reaching the resolved device options', () => {
  const options = parseDeviceOptions({ ...minimal, aiModel: 'anthropic/claude-sonnet-4.5' });
  expect(options.app).toBe('com.example.app');
  expect(Object.keys(options)).not.toContain('aiModel');
});

const browserstack = {
  ...minimal,
  platform: 'android',
  target: {
    provider: 'browserstack',
    name: 'Google Pixel 8',
    app: 'bs://abc123',
    osVersion: '14.0',
  },
} as const;

test('a BrowserStack target carries its app and version, and every unset field is null', () => {
  expect(parseDeviceOptions(browserstack).target).toEqual({
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
  });
});

test('every BrowserStack option a project sets reaches the target', () => {
  const target = parseDeviceOptions({
    ...browserstack,
    target: {
      ...browserstack.target,
      project: 'checkout',
      build: '4711',
      sessionName: 'sign in',
      orientation: 'landscape',
      geoLocation: 'FR',
      timezone: 'Europe/Paris',
      language: 'fr',
      locale: 'fr_FR',
      networkProfile: '4g-lte-lossy',
      noResignApp: true,
    },
  }).target;
  expect(target).toEqual(
    expect.objectContaining({
      project: 'checkout',
      build: '4711',
      sessionName: 'sign in',
      orientation: 'landscape',
      geoLocation: 'FR',
      timezone: 'Europe/Paris',
      language: 'fr',
      locale: 'fr_FR',
      networkProfile: '4g-lte-lossy',
      customNetwork: null,
      noResignApp: true,
    }),
  );
});

test('an AWS Device Farm target carries both ARNs and defaults the rest to null', () => {
  const target = parseDeviceOptions({
    ...minimal,
    platform: 'android',
    target: { provider: 'aws-device-farm', projectArn: 'arn:project', deviceArn: 'arn:device' },
  }).target;
  expect(target).toEqual({
    kind: 'aws-device-farm',
    projectArn: 'arn:project',
    deviceArn: 'arn:device',
    appArn: null,
    region: null,
    interactionMode: null,
    sessionName: null,
  });
});

test('a Limrun target carries only the artifact to install', () => {
  const target = parseDeviceOptions({
    ...minimal,
    target: { provider: 'limrun', install: './app.app' },
  }).target;
  expect(target).toEqual({ kind: 'limrun', install: './app.app' });
});

test('every target field names itself when it is missing or wrong', () => {
  expect(() => parseDeviceOptions({ ...minimal, target: { provider: 'saucelabs' } })).toThrow(
    /use\.target\.provider/,
  );
  expect(() => parseDeviceOptions({ ...minimal, target: 'iPhone 17 Pro Max' })).toThrow(
    /use\.target .*must be an object/s,
  );
  expect(() =>
    parseDeviceOptions({
      ...browserstack,
      target: { provider: 'browserstack', name: 'Google Pixel 8', osVersion: '14.0' },
    }),
  ).toThrow(/use\.target\.app/);
  expect(() =>
    parseDeviceOptions({
      ...browserstack,
      target: { provider: 'browserstack', name: 'Google Pixel 8', app: 'bs://a' },
    }),
  ).toThrow(/use\.target\.osVersion/);
  expect(() =>
    parseDeviceOptions({ ...minimal, target: { provider: 'browserstack', app: 'bs://a' } }),
  ).toThrow(/use\.target\.name.+BrowserStack/s);
  expect(() =>
    parseDeviceOptions({ ...minimal, target: { provider: 'aws-device-farm', deviceArn: 'arn:d' } }),
  ).toThrow(/use\.target\.projectArn/);
  expect(() =>
    parseDeviceOptions({
      ...minimal,
      target: { provider: 'aws-device-farm', projectArn: 'arn:p' },
    }),
  ).toThrow(/use\.target\.deviceArn/);
  expect(() => parseDeviceOptions({ ...minimal, target: { provider: 'limrun' } })).toThrow(
    /use\.target\.install/,
  );
  expect(() =>
    parseDeviceOptions({
      ...browserstack,
      target: { ...browserstack.target, orientation: 'sideways' },
    }),
  ).toThrow(/use\.target\.orientation/);
});

test('a named network profile and a custom network cannot both be set', () => {
  expect(() =>
    parseDeviceOptions({
      ...browserstack,
      target: { ...browserstack.target, networkProfile: '4g-lte', customNetwork: '1000 1000 50 0' },
    }),
  ).toThrow(/use\.target\.networkProfile/);
});

test('a target that picks its own device rejects a name, and says what names it instead', () => {
  expect(() =>
    parseDeviceOptions({
      ...minimal,
      target: {
        provider: 'aws-device-farm',
        name: 'arn:device',
        projectArn: 'arn:p',
        deviceArn: 'arn:d',
      },
    }),
  ).toThrow(/use\.target\.name.+target\.deviceArn/s);
  expect(() =>
    parseDeviceOptions({
      ...minimal,
      target: { provider: 'limrun', name: 'whatever', install: './app.app' },
    }),
  ).toThrow(/use\.target\.name.+Limrun/s);
});

test('one BrowserStack device name serves every worker, because each opens its own hosted session', () => {
  const single = parseDeviceOptions(browserstack);
  expect(deviceNameForSlot(single, 0)).toBe('Google Pixel 8');
  expect(deviceNameForSlot(single, 1)).toBe('Google Pixel 8');
  expect(deviceNameForSlot(single, 2)).toBe('Google Pixel 8');

  const pool = parseDeviceOptions({
    ...browserstack,
    target: { ...browserstack.target, name: ['Google Pixel 8', 'Samsung Galaxy S23'] },
  });
  expect(deviceNameForSlot(pool, 0)).toBe('Google Pixel 8');
  expect(deviceNameForSlot(pool, 1)).toBe('Samsung Galaxy S23');
  expect(() => deviceNameForSlot(pool, 2)).toThrow(/worker slot 2/);
});

test('a target that picks its own device names none for any slot', () => {
  const aws = parseDeviceOptions({
    ...minimal,
    target: { provider: 'aws-device-farm', projectArn: 'arn:p', deviceArn: 'arn:d' },
  });
  const limrun = parseDeviceOptions({
    ...minimal,
    target: { provider: 'limrun', install: './app.app' },
  });
  expect(deviceNameForSlot(aws, 3)).toBe(null);
  expect(deviceNameForSlot(limrun, 3)).toBe(null);
});
