import { expect, test } from 'vite-plus/test';
import type { TouchpressOptions } from '../src/core/config.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { preflight } from '../src/preflight.ts';
import { createFakeDriver } from './fake-driver.ts';

const options: Partial<TouchpressOptions> = {
  platform: 'ios',
  app: 'com.wobsoriano.awesometodo',
  readyWhen: { text: 'GET STARTED' },
};

test('an unset device name passes on whatever is booted, and names the one it found', async () => {
  const driver = createFakeDriver();
  const report = await preflight(options, driver);
  expect(report).toEqual({
    ok: true,
    device: { name: 'iPhone 17 Pro Max', id: '2A141E2F-5FD1-4F16-86FB-E9A5835F2166' },
  });
});

test('a named device that is booted passes', async () => {
  const driver = createFakeDriver();
  const report = await preflight({ ...options, deviceName: 'iPhone 17 Pro Max' }, driver);
  expect(report.ok).toBe(true);
  if (!report.ok) return;
  expect(report.device.name).toBe('iPhone 17 Pro Max');
});

test('a named device that is not booted names it, what is booted, and the way out', async () => {
  const driver = createFakeDriver();
  driver.devices.push({ id: 'B2', name: 'iPad Pro 13-inch', booted: true });
  const report = await preflight({ ...options, deviceName: 'iPhone 16' }, driver);
  expect(report.ok).toBe(false);
  if (report.ok) return;
  expect(report.problems).toEqual([
    "No booted ios device is named 'iPhone 16'. Booted right now: 'iPhone 17 Pro Max', 'iPad Pro 13-inch'. Set use.deviceName to one of those or boot 'iPhone 16'.",
  ]);
});

test('nothing booted at all says so, and says how to boot one', async () => {
  const driver = createFakeDriver();
  driver.devices = [{ id: 'A1', name: 'iPhone 17 Pro Max', booted: false }];
  expect(await preflight(options, driver)).toEqual({
    ok: false,
    problems: ['No ios device is booted. Boot one with `agent-device device boot --platform ios`.'],
  });
  expect(await preflight({ ...options, deviceName: 'iPhone 17 Pro Max' }, driver)).toEqual({
    ok: false,
    problems: [
      "No booted ios device is named 'iPhone 17 Pro Max', because no ios device is booted at all. Boot 'iPhone 17 Pro Max'.",
    ],
  });
});

test('a pool reports one problem per missing name and passes on the first', async () => {
  const driver = createFakeDriver();
  const missing = await preflight({ ...options, deviceName: ['one', 'two'] }, driver);
  expect(missing.ok).toBe(false);
  if (missing.ok) return;
  expect(missing.problems.length).toBe(2);
  expect(missing.problems[0]).toContain("is named 'one'");
  expect(missing.problems[1]).toContain("is named 'two'");

  driver.devices = [
    { id: 'A1', name: 'one', booted: true },
    { id: 'A2', name: 'two', booted: true },
  ];
  expect(await preflight({ ...options, deviceName: ['one', 'two'] }, driver)).toEqual({
    ok: true,
    device: { name: 'one', id: 'A1' },
  });
});

test('a driver that cannot list reports the failure and points at the daemon', async () => {
  const driver = {
    ...createFakeDriver(),
    listDevices: () =>
      Promise.reject(
        new TouchpressError({
          kind: 'driver',
          command: 'listDevices',
          failure: { kind: 'device-missing', detail: 'daemon not running' },
        }),
      ),
  };
  expect(await preflight(options, driver)).toEqual({
    ok: false,
    problems: [
      'Could not list ios devices: no matching device is booted (daemon not running). Check that the agent-device daemon is reachable.',
    ],
  });
});

test('a malformed config throws rather than reporting a problem', async () => {
  const driver = createFakeDriver();
  await expect(preflight({ ...options, app: '' }, driver)).rejects.toThrow(/use\.app/);
});

const bsCredentials = { BROWSERSTACK_USERNAME: 'rob', BROWSERSTACK_ACCESS_KEY: 'key' };

test('a cloud target is checked without ever listing devices', async () => {
  const driver = createFakeDriver();
  const report = await preflight(
    {
      ...options,
      deviceName: 'Google Pixel 8',
      cloud: { provider: 'browserstack', app: 'bs://abc', osVersion: '14.0' },
    },
    driver,
    bsCredentials,
  );
  expect(report).toEqual({
    ok: true,
    device: { name: 'Google Pixel 8', id: 'Google Pixel 8' },
  });
  expect(driver.calls).toEqual([]);
});

test('each BrowserStack variable agent-device needs is one named problem', async () => {
  const cloud = { provider: 'browserstack', app: 'bs://abc', osVersion: '14.0' } as const;
  const report = await preflight(
    { ...options, deviceName: 'Google Pixel 8', cloud },
    createFakeDriver(),
    {},
  );
  expect(report.ok).toBe(false);
  if (report.ok) return;
  expect(report.problems.length).toBe(2);
  expect(report.problems[0]).toContain('BROWSERSTACK_USERNAME');
  expect(report.problems[1]).toContain('BROWSERSTACK_ACCESS_KEY');

  const partial = await preflight(
    { ...options, deviceName: 'Google Pixel 8', cloud },
    createFakeDriver(),
    { BROWSERSTACK_USERNAME: 'rob' },
  );
  expect(partial.ok).toBe(false);
  if (partial.ok) return;
  expect(partial.problems).toEqual([expect.stringContaining('BROWSERSTACK_ACCESS_KEY')]);
});

test('a BrowserStack pool is reported by the device its first worker gets', async () => {
  const report = await preflight(
    {
      ...options,
      deviceName: ['Google Pixel 8', 'Samsung Galaxy S23'],
      cloud: { provider: 'browserstack', app: 'bs://abc', osVersion: '14.0' },
    },
    createFakeDriver(),
    bsCredentials,
  );
  expect(report).toEqual({ ok: true, device: { name: 'Google Pixel 8', id: 'Google Pixel 8' } });
});

const aws = {
  provider: 'aws-device-farm',
  projectArn: 'arn:aws:devicefarm:project',
  deviceArn: 'arn:aws:devicefarm:device',
} as const;

test('AWS needs a region, and cloud.region satisfies it without the environment', async () => {
  const driver = createFakeDriver();
  const missing = await preflight({ ...options, cloud: aws }, driver, {});
  expect(missing).toEqual({
    ok: false,
    problems: [
      'No AWS region is set. Set use.cloud.region, or AWS_REGION or AWS_DEFAULT_REGION in the environment.',
    ],
  });

  const configured = await preflight(
    { ...options, cloud: { ...aws, region: 'eu-west-1' } },
    driver,
    {},
  );
  expect(configured).toEqual({
    ok: true,
    device: { name: aws.deviceArn, id: aws.deviceArn },
  });
  expect(driver.calls).toEqual([]);
});

test('AWS_REGION and AWS_DEFAULT_REGION each satisfy the region check', async () => {
  const fromRegion = await preflight({ ...options, cloud: aws }, createFakeDriver(), {
    AWS_REGION: 'us-east-1',
  });
  expect(fromRegion.ok).toBe(true);
  const fromDefault = await preflight({ ...options, cloud: aws }, createFakeDriver(), {
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  expect(fromDefault.ok).toBe(true);
});

test('an empty region variable is unset, so the next one still answers', async () => {
  const report = await preflight({ ...options, cloud: aws }, createFakeDriver(), {
    AWS_REGION: '',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  expect(report.ok).toBe(true);
});

test('Limrun needs its key and reports the fresh instance it will allocate', async () => {
  const cloud = { provider: 'limrun', install: './app.app' } as const;
  const driver = createFakeDriver();
  expect(await preflight({ ...options, cloud }, driver, {})).toEqual({
    ok: false,
    problems: [expect.stringContaining('LIMRUN_API_KEY')],
  });
  expect(await preflight({ ...options, cloud }, driver, { LIMRUN_API_KEY: 'k' })).toEqual({
    ok: true,
    device: { name: 'limrun ios', id: 'limrun' },
  });
  expect(driver.calls).toEqual([]);
});
