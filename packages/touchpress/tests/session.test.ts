import { expect, test } from 'vite-plus/test';
import { createDevice } from '../src/core/device.ts';
import { parseDeviceOptions, type TouchpressOptions } from '../src/core/config.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { silentSink } from '../src/core/report.ts';
import type { RawSnapshot } from '../src/core/screen.ts';
import { openSession } from '../src/core/session.ts';
import { createFakeDriver, createRecordingSink, type FakeDriver } from './fake-driver.ts';

/** What the fixtures hand the parser: touchpress's options plus Playwright's own `actionTimeout`. */
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

test('openSession reclaims a leftover of its own name, opens, and holds for the ready gate', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  expect(session.name).toBe('touchpress-ios-0');
  expect(driver.calls).toEqual([
    'close touchpress-ios-0',
    'open com.wobsoriano.awesometodo relaunch=true',
    'capture',
  ]);
  expect(session.state().phase).toBe('ready');
});

test('launchUrl rides on the launch and on every relaunch', async () => {
  const launchUrl = 'com.example.app://expo-development-client/?url=http://localhost:8081';
  const driver = createFakeDriver();
  const session = await open(driver, { launchUrl });
  await session.relaunch(silentSink);
  expect(driver.calls.filter((call) => call.startsWith('open'))).toEqual([
    `open com.wobsoriano.awesometodo relaunch=true url=${launchUrl}`,
    `open com.wobsoriano.awesometodo relaunch=true url=${launchUrl}`,
  ]);
});

test('a device held by one of our own leftovers is reclaimed and the open retried once', async () => {
  const driver = createFakeDriver();
  driver.openOutcomes.push({
    kind: 'device-busy',
    owner: 'touchpress-ios-1',
    detail: `in use by session "touchpress-ios-1"`,
  });
  await open(driver);
  expect(driver.calls).toContain('close touchpress-ios-1');
  expect(driver.calls.filter((call) => call.startsWith('open')).length).toBe(2);
});

test('a device held by a foreign session names the owner and the release command', async () => {
  const driver = createFakeDriver();
  driver.openOutcomes.push({
    kind: 'device-busy',
    owner: 'lex',
    detail: `in use by session "lex"`,
  });
  const error = await open(driver).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('device-in-use');
  expect(error.message).toContain(`session "lex"`);
  expect(error.message).toContain('agent-device close --session lex');
  expect(error.message).toContain("onDeviceInUse to 'reclaim'");
});

test('onDeviceInUse reclaim takes over a foreign session instead of failing', async () => {
  const driver = createFakeDriver();
  driver.openOutcomes.push({ kind: 'device-busy', owner: 'lex', detail: 'in use' });
  await open(driver, { onDeviceInUse: 'reclaim' });
  expect(driver.calls).toContain('close lex');
});

test('a session bound to another device is closed by name and reopened once', async () => {
  const driver = createFakeDriver();
  driver.openOutcomes.push({
    kind: 'session-rebound',
    boundTo: 'android device emulator-5554',
    detail: 'already bound',
  });
  await open(driver);
  expect(driver.calls.filter((call) => call === 'close touchpress-ios-0').length).toBe(2);
});

test('a bundle that never loads fails with the ready locator and the screen listing', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const error = await open(driver, { readyWhen: { text: 'Fresh start' } }).catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('not-ready');
  expect(error.message).toContain("readyWhen: getByText('Fresh start')");
  expect(error.message).toContain(`@e35 [button] "Explore"`);
});

test('close is idempotent and reaches closed even when the driver call fails', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  driver.close = () => Promise.reject(new Error('daemon gone'));
  await expect(session.close('requested')).rejects.toThrow('daemon gone');
  expect(session.state().phase).toBe('closed');
  await session.close('worker-exit');
});

test('a tap resolves against a fresh screen and dispatches a generation-pinned ref', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  await app.getByRole('button', { name: 'Explore' }).tap();
  expect(driver.calls.at(-1)).toMatch(/^tap @e30~s776575 settle=/);
});

test('an ambiguous locator fails an action at once with every match listed', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const session = await open(driver, { readyWhen: { text: 'Expo documentation' } });
  const app = createDevice(session, silentSink);
  const error = await app
    .getByText('Explore')
    .tap()
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('strict-mode');
  expect(error.message).toContain(`@e12 [text] "Explore"`);
  expect(error.message).toContain(`@e35 [button] "Explore"`);
  expect(error.message).toContain('.nth(n)');
});

test('first picks one node out of the same ambiguous locator', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const session = await open(driver, { readyWhen: { text: 'Expo documentation' } });
  const app = createDevice(session, silentSink);
  await app.getByText('Explore').first().tap();
  expect(driver.calls.at(-1)).toMatch(/^tap @e12~s355823 settle=/);
});

test('a stale ref re-captures and retries once, then reports', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);

  driver.staleRefs = 1;
  await app.getByRole('button', { name: 'Home' }).tap();
  expect(driver.calls.filter((call) => call.startsWith('tap')).length).toBe(2);

  driver.staleRefs = 2;
  const error = await app
    .getByRole('button', { name: 'Home' })
    .tap()
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.message).toContain('the screen changed before the action reached it');
});

test('an action waits for its target and then reports what was on screen', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  const started = Date.now();
  const error = await app
    .getByText('Sign out')
    .tap()
    .catch((thrown: unknown) => thrown);
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('not-found');
  expect(error.message).toContain(`@e14 [text] "GET STARTED"`);
});

test('count reports distinct matches after absorption', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const session = await open(driver, { readyWhen: { text: 'Expo documentation' } });
  const app = createDevice(session, silentSink);
  expect(await app.getByText('Explore').count()).toBe(2);
  expect(await app.getByText('Sign out').count()).toBe(0);
});

test('every command runs on one queue, so a snapshot never lands inside another action', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  driver.calls.length = 0;
  await Promise.all([
    app.getByRole('button', { name: 'Home' }).tap(),
    app.screen(),
    app.getByRole('button', { name: 'Explore' }).tap(),
  ]);
  expect(driver.calls.map((call) => call.replace(/ settle=\d+$/, ''))).toEqual([
    'capture',
    'tap @e29~s776575',
    'capture',
    'capture',
    'tap @e30~s776575',
  ]);
});

test('a rejected command does not wedge the queue', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  await app
    .getByText('Sign out')
    .tap()
    .catch(() => undefined);
  await app.getByRole('button', { name: 'Home' }).tap();
  expect(driver.calls.at(-1)).toMatch(/^tap @e29~s776575 settle=/);
});

test('a device that goes away breaks the session and every later call names the root cause', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  driver.capture = () =>
    Promise.reject(
      new TouchpressError({
        kind: 'driver',
        command: 'snapshot',
        failure: { kind: 'device-missing', detail: 'simulator shut down' },
      }),
    );

  await expect(session.screen()).rejects.toThrow('no matching device is booted');
  expect(session.state().phase).toBe('broken');
  expect(session.failure()?.kind).toBe('device-missing');
  await expect(session.screen()).rejects.toThrow('no matching device is booted');
});

test('a readyWhen that matches twice still counts as ready', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const session = await open(driver, { readyWhen: { text: 'Explore' } });
  expect(session.state().phase).toBe('ready');
});

test('a ready gate that times out reports what it actually waited', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const error = await open(driver, {
    readyWhen: { text: 'Fresh start' },
    launchTimeout: 500,
  }).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError) || error.info.kind !== 'not-ready') return;
  expect(error.info.timeoutMs).toBeLessThanOrEqual(600);
  expect(error.info.timeoutMs).toBeGreaterThan(0);
});

test('waiting for a target and settling after it share one action budget', async () => {
  const driver = createFakeDriver({ screens: ['explore', 'explore', 'home'] });
  const session = await open(driver, {
    readyWhen: { text: 'Expo documentation' },
    actionTimeout: 4000,
    settleQuietMs: 100,
  });
  const app = createDevice(session, silentSink);
  await app.getByRole('text', { name: 'Fresh start' }).tap();
  const settle = /settle=(\d+)/.exec(driver.calls.at(-1) ?? '');
  expect(Number(settle?.[1])).toBeLessThan(3900);
});

test('fill dispatches again when the keyboard under-delivers, and reports the text that landed', async () => {
  const driver = createFakeDriver();
  driver.fillOutcomes.push('r@example.com', 'rob@exa');
  // A short quiet period so three confirmed attempts fit the action budget.
  const session = await open(driver, { settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  await app.getByRole('button', { name: 'Explore' }).fill('rob@example.com');

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(3);
});

test('fill refills when the field reverts during the settle wait', async () => {
  const driver = createFakeDriver();
  // The first fill lands, reads back correct, then reverts partway through the settle
  // wait the way a controlled component's own render does. The second fill holds.
  driver.revertingFills = 1;
  driver.revertTo = 'rob';
  driver.revertAfterMs = 40;
  const session = await open(driver, { actionTimeout: 4000, settleQuietMs: 200 });
  const app = createDevice(session, silentSink);

  await app.getByRole('button', { name: 'Explore' }).fill('rob@example.com');

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(2);
});

test('fill stops rather than starting an attempt it cannot afford to confirm', async () => {
  const driver = createFakeDriver();
  driver.revertingFills = 10;
  driver.revertTo = 'rob';
  driver.revertAfterMs = 10;
  // One attempt plus its 500ms confirmation fits in 800ms. A second does not, and
  // starting one anyway would sleep another full quiet period past the deadline.
  const session = await open(driver, { actionTimeout: 800, settleQuietMs: 500 });
  const app = createDevice(session, silentSink);

  const started = Date.now();
  const error = await app
    .getByRole('button', { name: 'Explore' })
    .fill('rob@example.com')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain(`Actual value: "rob"`);
  expect(Date.now() - started).toBeLessThan(900);
});

test('a fill that never lands names the locator, both values, and the attempts', async () => {
  const driver = createFakeDriver();
  driver.fillOutcomes.push(...Array<string>(50).fill('r@example.com'));
  // Room for more than three attempts.
  const session = await open(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('button', { name: 'Explore' })
    .fill('rob@example.com')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain(`Expected value: "rob@example.com"`);
  expect(error.message).toContain(`Actual value: "r@example.com"`);
  expect(error.message).toMatch(/after \d+ attempts/);
  if (error.info.kind !== 'fill-unconfirmed') return;
  expect(error.info.attempts).toBeGreaterThan(1);
});

test('a fill confirms against the node it wrote when the write changes the label it matched on', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  driver.contentsBecomeLabel = true;
  const session = await open(driver, {
    platform: 'android',
    deviceName: 'Pixel 9',
    readyWhen: { text: 'Sign in' },
  });
  const app = createDevice(session, silentSink);

  await app.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
});

test('a fill whose label follows its contents still re-dispatches and still reports what landed', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  driver.contentsBecomeLabel = true;
  driver.fillOutcomes.push(...Array<string>(50).fill('r@example.com'));
  const session = await open(driver, {
    actionTimeout: 4000,
    settleQuietMs: 20,
    platform: 'android',
    deviceName: 'Pixel 9',
    readyWhen: { text: 'Sign in' },
  });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field', { name: 'Email' })
    .fill('rob@example.com')
    .catch((thrown: unknown) => thrown);

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBeGreaterThan(1);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain(`Locator: getByRole('text-field', { name: 'Email' })`);
  expect(error.message).toContain(`Actual value: "r@example.com"`);
});

type RawNode = RawSnapshot['nodes'][number];

/** A flat tree in document order, so an inserted node shifts every index after it the way a real capture does. */
function snapshot(nodes: readonly Omit<RawNode, 'index'>[]): RawSnapshot {
  return { nodes: nodes.map((node, index) => ({ ...node, index })) };
}

const SHARED_ID = 'auth.start.identifier';
const EMAIL = 'rob@example.com';

/** SwiftUI copies one identifier onto the placeholder, the field, and the button under it. */
const emailForm: readonly Omit<RawNode, 'index'>[] = [
  { ref: 'e1', type: 'Window' },
  { ref: 'e2', type: 'StaticText', label: 'Enter your email', identifier: SHARED_ID },
  { ref: 'e3', type: 'TextField', identifier: SHARED_ID },
  { ref: 'e4', type: 'Button', label: 'Continue', identifier: SHARED_ID },
];

const keyboard: readonly Omit<RawNode, 'index'>[] = [
  { ref: 'k1', type: 'Window' },
  { ref: 'k2', type: 'Other', label: 'Keyboard' },
  { ref: 'k3', type: 'Other', label: 'Keys' },
];

test('a fill finds its field again after the keyboard shifts every index under a shared identifier', async () => {
  const before = snapshot(emailForm);
  const after = snapshot([...keyboard, ...emailForm]);
  const driver = createFakeDriver({ screens: [before, before, after] });
  const session = await open(driver, {
    readyWhen: { text: 'Continue' },
    actionTimeout: 1000,
    settleQuietMs: 20,
  });
  const app = createDevice(session, silentSink);

  await app.getByRole('text-field').fill(EMAIL);

  expect(driver.calls.filter((call) => call.startsWith('fill'))).toEqual([`fill @e3 ${EMAIL}`]);
});

test('a fill whose field is gone after the write fails rather than writing to what took its index', async () => {
  const before = snapshot(emailForm);
  // The keyboard came up and the form advanced, so the Continue button now sits at the index the field had.
  const after = snapshot([
    { ref: 'k1', type: 'Window' },
    { ref: 'e1', type: 'Window' },
    { ref: 'e4', type: 'Button', label: 'Continue', identifier: SHARED_ID },
  ]);
  const driver = createFakeDriver({ screens: [before, before, after] });
  // Room for a second attempt, so the test proves none is made rather than that none fits.
  const session = await open(driver, {
    readyWhen: { text: 'Continue' },
    actionTimeout: 1000,
    settleQuietMs: 20,
  });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field')
    .fill(EMAIL)
    .catch((thrown: unknown) => thrown);

  expect(driver.calls.filter((call) => call.startsWith('fill'))).toEqual([`fill @e3 ${EMAIL}`]);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain('the field no longer resolved after the write');
});

test('a fill confirms on one dispatch when an Android field shares its identifier with its label', async () => {
  const login = snapshot([
    { ref: 'a1', type: 'android.widget.FrameLayout' },
    { ref: 'a2', type: 'android.widget.TextView', label: 'Email', identifier: 'login.email' },
    { ref: 'a3', type: 'android.widget.EditText', label: 'Email', identifier: 'login.email' },
    { ref: 'a4', type: 'android.widget.Button', label: 'Sign in' },
  ]);
  const driver = createFakeDriver({ screens: [login] });
  driver.contentsBecomeLabel = true;
  const session = await open(driver, {
    platform: 'android',
    deviceName: 'Pixel 9',
    readyWhen: { text: 'Sign in' },
  });
  const app = createDevice(session, silentSink);

  await app.getByRole('text-field', { name: 'Email' }).fill(EMAIL);

  expect(driver.calls.filter((call) => call.startsWith('fill'))).toEqual([`fill @a3 ${EMAIL}`]);
});

/** One bullet per character, which is the whole of what an iOS SecureTextField reports. */
function mask(length: number): string {
  return '•'.repeat(length);
}

const SECRET = 's3cr3t-p4ssw0rd';

function openLogin(driver: FakeDriver, overrides?: ParseInput) {
  return open(driver, { readyWhen: { text: 'Sign in' }, ...overrides });
}

test('a fill of a secure field confirms against the mask it reads back', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length)));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  await app.getByRole('secure-text-field').fill(SECRET);

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
});

test('a secure field masking fewer characters than were typed keeps retrying and then fails', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length - 3)));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('secure-text-field')
    .fill(SECRET)
    .catch((thrown: unknown) => thrown);

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBeGreaterThan(1);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  if (error.info.kind !== 'fill-unconfirmed') return;
  expect(error.info.attempts).toBeGreaterThan(1);
});

test('a secure field that never lands reports how much was typed and never the text', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length - 3)));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('secure-text-field')
    .fill(SECRET)
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.message).toContain(`Expected value: ${String(SECRET.length)} characters`);
  expect(error.message).not.toContain(SECRET);
  if (error.info.kind !== 'fill-unconfirmed') return;
  expect(error.info.expected).toEqual({ kind: 'masked', length: SECRET.length });
});

test('a mask of the right length made of different characters is not a landed write', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  // The placeholder an empty iOS secure field reports. It is the length of the
  // text below, so only its distinct characters separate it from a real mask.
  driver.fillOutcomes.push(...Array<string>(50).fill('Password'));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('secure-text-field')
    .fill('hunter22')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
});

test('a readable field next to a secure one still fails on a short mask and names its exact value', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask('rob@example.com'.length - 3)));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field')
    .fill('rob@example.com')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain(`Expected value: "rob@example.com"`);
});

function openAndroidLogin(driver: FakeDriver) {
  driver.contentsBecomeLabel = true;
  return open(driver, {
    platform: 'android',
    deviceName: 'Pixel 9',
    readyWhen: { text: 'Sign in' },
    actionTimeout: 4000,
    settleQuietMs: 20,
  });
}

test('an Android password field confirms on the mask it reads back', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length)));
  const session = await openAndroidLogin(driver);
  const app = createDevice(session, silentSink);

  await app.getByRole('text-field', { name: 'Password' }).fill(SECRET);

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
});

test('an Android password field masking with any one repeated character confirms, secret or not', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill('*'.repeat(SECRET.length)));
  const session = await openAndroidLogin(driver);
  const app = createDevice(session, silentSink);

  await app.getByRole('text-field', { name: 'Password' }).fill(SECRET, { secret: true });

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
});

test('an Android password field masking fewer characters than were typed keeps retrying and then fails', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length - 3)));
  const session = await openAndroidLogin(driver);
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field', { name: 'Password' })
    .fill(SECRET)
    .catch((thrown: unknown) => thrown);

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBeGreaterThan(1);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).toContain(`Expected value: "${SECRET}"`);
});

test('an Android text field still holding its placeholder is not a landed write', async () => {
  const driver = createFakeDriver({ screens: ['android-login'] });
  // "Password" is as long as the text typed, so only its distinct characters separate it from a mask.
  driver.fillOutcomes.push(...Array<string>(50).fill('Password'));
  const session = await openAndroidLogin(driver);
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field', { name: 'Password' })
    .fill('hunter22')
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
});

test('a fill titles its step with the locator alone and the typed text with a nested step', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const sink = createRecordingSink();
  const app = createDevice(session, sink);

  await app.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');

  expect(sink.steps).toEqual([
    { title: `fill getByRole('text-field', { name: 'Email' })`, depth: 0, boxed: false },
    { title: `type "rob@example.com"`, depth: 1, boxed: true },
  ]);
});

test('a fill whose text carries runs of whitespace confirms against the normalized read-back', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const sink = createRecordingSink();
  const app = createDevice(session, sink);

  await app.getByRole('text-field', { name: 'Email' }).fill('two  words ');

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
  expect(sink.steps[1]?.title).toBe('type "two  words "');
});

test('a fill of a secure field reports how much it typed and never the text', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill(mask(SECRET.length)));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const sink = createRecordingSink();
  const app = createDevice(session, sink);

  await app.getByRole('secure-text-field').fill(SECRET);

  expect(sink.steps[1]?.title).toBe(`type ${String(SECRET.length)} characters`);
  expect(sink.steps.some((step) => step.title.includes(SECRET))).toBe(false);
});

test('a fill marked secret is confirmed on its exact contents and still reported as a length', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const sink = createRecordingSink();
  const app = createDevice(session, sink);

  await app.getByRole('text-field', { name: 'Email' }).fill(SECRET, { secret: true });

  expect(driver.calls.filter((call) => call.startsWith('fill')).length).toBe(1);
  expect(sink.steps).toEqual([
    { title: `fill getByRole('text-field', { name: 'Email' })`, depth: 0, boxed: false },
    { title: `type ${String(SECRET.length)} characters`, depth: 1, boxed: true },
  ]);
  expect(sink.steps.some((step) => step.title.includes(SECRET))).toBe(false);
});

test('a fill marked secret that never lands reports both values as lengths', async () => {
  const driver = createFakeDriver({ screens: ['ios-login'] });
  driver.fillOutcomes.push(...Array<string>(50).fill('s3cr3t'));
  const session = await openLogin(driver, { actionTimeout: 4000, settleQuietMs: 20 });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text-field', { name: 'Email' })
    .fill(SECRET, { secret: true })
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('fill-unconfirmed');
  expect(error.message).not.toContain(SECRET);
  expect(error.message).toContain(`Expected value: ${String(SECRET.length)} characters`);
  expect(error.message).toMatch(/Actual value: 6 characters/);
  if (error.info.kind !== 'fill-unconfirmed') return;
  expect(error.info.expected).toEqual({ kind: 'masked', length: SECRET.length });
  expect(error.info.actual).toEqual({ kind: 'masked', length: 6 });
});

test('a defaulted screenshot numbers its own path and returns what the driver resolved', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);

  expect(await app.screenshot()).toBe('screenshot-1.png');
  expect(await app.screenshot()).toBe('screenshot-2.png');
  expect(driver.calls.filter((call) => call.startsWith('screenshot'))).toEqual([
    'screenshot screenshot-1.png',
    'screenshot screenshot-2.png',
  ]);
});

test('an explicit screenshot path is passed through and does not consume a counter value', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);

  expect(await app.screenshot({ path: 'card.png' })).toBe('card.png');
  expect(await app.screenshot()).toBe('screenshot-1.png');
  expect(driver.calls.filter((call) => call.startsWith('screenshot'))).toEqual([
    'screenshot card.png',
    'screenshot screenshot-1.png',
  ]);
});

test('textContent reads the matched node off exactly one capture', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  driver.calls.length = 0;
  expect(await app.getByText('GET STARTED').textContent()).toBe('GET STARTED');
  expect(driver.calls).toEqual(['capture']);
});

test('textContent is null when the locator matches nothing', async () => {
  const driver = createFakeDriver();
  const session = await open(driver);
  const app = createDevice(session, silentSink);
  expect(await app.getByText('Sign out').textContent()).toBe(null);
});

test('textContent refuses an ambiguous locator and lists every match', async () => {
  const driver = createFakeDriver({ screens: ['explore'] });
  const session = await open(driver, { readyWhen: { text: 'Expo documentation' } });
  const app = createDevice(session, silentSink);
  const error = await app
    .getByText('Explore')
    .textContent()
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('strict-mode');
  expect(error.message).toContain(`@e12 [text] "Explore"`);
  expect(error.message).toContain(`@e35 [button] "Explore"`);
});

test('a Limrun session installs the app on its first open and not on the relaunch', async () => {
  const driver = createFakeDriver();
  const session = await open(driver, {
    deviceName: undefined,
    cloud: { provider: 'limrun', install: './build/app.app' },
  });
  await session.relaunch(silentSink);
  expect(driver.calls.filter((call) => call.startsWith('open'))).toEqual([
    'open com.wobsoriano.awesometodo relaunch=true install=./build/app.app',
    'open com.wobsoriano.awesometodo relaunch=true',
  ]);
});

test('a cloud session records the provider it opened on', async () => {
  const notes: string[] = [];
  const sink = {
    ...silentSink,
    note: (key: string, value: string) => notes.push(`${key} ${value}`),
  };
  await openSession({
    options: parseDeviceOptions({
      ...options,
      deviceName: undefined,
      cloud: { provider: 'limrun', install: './build/app.app' },
    }),
    slot: 0,
    scope: 'ios',
    sink,
    createDriver: () => createFakeDriver(),
  });
  expect(notes).toContain('cloud limrun');
});

test('a cloud session resets no keychain and says why', async () => {
  const notes: string[] = [];
  const sink = {
    ...createRecordingSink(),
    note: (key: string, value: string) => notes.push(`${key} ${value}`),
  };
  const driver = createFakeDriver();
  const session = await open(driver, {
    deviceName: 'Google Pixel 8',
    platform: 'android',
    cloud: { provider: 'browserstack', app: 'bs://abc', osVersion: '14.0' },
  });
  driver.calls.length = 0;

  await session.clearKeychain(sink);

  expect(driver.calls).toEqual(['resetKeychain']);
  expect(notes).toEqual([
    'keychain nothing to reset on Android, clearing state covers the keystore',
  ]);
});

test('an iOS keychain reset on a hosted device is reported as the no-op it is', async () => {
  const notes: string[] = [];
  const sink = {
    ...createRecordingSink(),
    note: (key: string, value: string) => notes.push(`${key} ${value}`),
  };
  const session = await open(createFakeDriver(), {
    deviceName: 'iPhone 15',
    cloud: { provider: 'browserstack', app: 'bs://abc', osVersion: '17' },
  });

  await session.clearKeychain(sink);

  expect(notes).toEqual(['keychain keychain reset needs a local iOS simulator, nothing was reset']);
});
