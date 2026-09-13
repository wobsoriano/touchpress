import { expect, test } from 'vite-plus/test';
import { parseDeviceOptions, type TouchpressOptions } from '../src/core/config.ts';
import { createDevice } from '../src/core/device.ts';
import { silentSink } from '../src/core/report.ts';
import { openSession } from '../src/core/session.ts';
import { createFakeDriver, createRecordingSink, type FakeDriver } from './fake-driver.ts';

type ParseInput = Partial<TouchpressOptions> & { actionTimeout?: number };

const options: ParseInput = {
  platform: 'ios',
  app: 'com.wobsoriano.awesometodo',
  deviceName: 'iPhone 17 Pro Max',
  readyWhen: { text: 'GET STARTED' },
  launchTimeout: 1000,
  actionTimeout: 600,
};

function open(driver: FakeDriver, overrides?: ParseInput) {
  return openSession({
    options: parseDeviceOptions({ ...options, ...overrides }),
    slot: 0,
    scope: 'ios',
    sink: silentSink,
    createDriver: () => driver,
  });
}

test('goBack presses the app control on iOS and the platform gesture on Android', async () => {
  const apple = createFakeDriver();
  const appleApp = createDevice(await open(apple), silentSink);
  await appleApp.goBack();
  expect(apple.calls).toContain('back in-app');

  const android = createFakeDriver({ screens: ['android-home'] });
  const androidApp = createDevice(
    await open(android, { platform: 'android', readyWhen: { text: 'Welcome' } }),
    silentSink,
  );
  await androidApp.goBack();
  expect(android.calls).toContain('back system');
});

test('an explicit goBack mode overrides the platform default and is reported', async () => {
  const driver = createFakeDriver();
  const sink = createRecordingSink();
  const app = createDevice(await open(driver), sink);

  await app.goBack({ mode: 'system' });

  expect(driver.calls).toContain('back system');
  expect(sink.steps).toEqual([{ title: 'back (system)', depth: 0, boxed: false }]);
});

test('keyboard.type sends the text and reports it', async () => {
  const driver = createFakeDriver();
  const sink = createRecordingSink();
  const app = createDevice(await open(driver), sink);

  await app.keyboard.type('123456');

  expect(driver.calls).toContain('type 123456');
  expect(sink.steps).toEqual([{ title: 'type "123456"', depth: 0, boxed: false }]);
});

test('a secret keyboard.type reports a character count and never the text', async () => {
  const driver = createFakeDriver();
  const sink = createRecordingSink();
  const app = createDevice(await open(driver), sink);

  await app.keyboard.type('hunter2', { secret: true });

  expect(sink.steps).toEqual([{ title: 'type 7 characters', depth: 0, boxed: false }]);
});

test('clearState clears the app and relaunches without touching the keychain', async () => {
  const driver = createFakeDriver();
  const app = createDevice(await open(driver), silentSink);
  const sink = createRecordingSink();
  const reported = createDevice(await open(createFakeDriver()), sink);

  await app.clearState();
  await reported.clearState();

  expect(driver.calls).toEqual([
    'close touchpress-ios-0',
    'open com.wobsoriano.awesometodo relaunch=true',
    'capture',
    'clearAppState com.wobsoriano.awesometodo',
    'open com.wobsoriano.awesometodo relaunch=true',
    'capture',
  ]);
  expect(driver.calls).not.toContain('resetKeychain');
  expect(sink.steps).toEqual([
    { title: 'clear state of com.wobsoriano.awesometodo', depth: 0, boxed: false },
    { title: 'relaunch com.wobsoriano.awesometodo', depth: 1, boxed: false },
  ]);
});

test('clearKeychain resets the keychain as one step and relaunches nothing', async () => {
  const driver = createFakeDriver();
  const sink = createRecordingSink();
  const app = createDevice(await open(driver), sink);
  const before = driver.calls.length;

  await app.clearKeychain();

  expect(driver.calls.slice(before)).toEqual(['resetKeychain']);
  expect(sink.steps).toEqual([{ title: 'clear keychain', depth: 0, boxed: false }]);
});

test('clearKeychain on Android notes that there was nothing to reset', async () => {
  const driver = createFakeDriver({ screens: ['android-home'] });
  const notes: string[] = [];
  const sink = {
    ...createRecordingSink(),
    note: (key: string, value: string) => notes.push(`${key}: ${value}`),
  };
  const app = createDevice(
    await open(driver, { platform: 'android', readyWhen: { text: 'Welcome' } }),
    sink,
  );

  await app.clearKeychain();

  expect(driver.calls).toContain('resetKeychain');
  expect(notes).toEqual([
    'keychain: nothing to reset on Android, clearing state covers the keystore',
  ]);
});

test('clearKeychain on macOS notes that there was nothing to reset', async () => {
  const driver = createFakeDriver({ screens: ['macos-config-missing'] });
  const notes: string[] = [];
  const sink = {
    ...createRecordingSink(),
    note: (key: string, value: string) => notes.push(`${key}: ${value}`),
  };
  const app = createDevice(
    await open(driver, { platform: 'macos', readyWhen: { text: 'Clerk is not configured' } }),
    sink,
  );

  await app.clearKeychain();

  expect(driver.calls).toContain('resetKeychain');
  expect(notes).toEqual([
    'keychain: nothing to reset on macOS, touchpress never touches the login keychain',
  ]);
});
