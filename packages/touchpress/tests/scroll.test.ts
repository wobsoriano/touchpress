import { expect, test } from 'vite-plus/test';
import { createDevice } from '../src/core/device.ts';
import { parseDeviceOptions, type TouchpressOptions } from '../src/core/config.ts';
import { TouchpressError } from '../src/core/errors.ts';
import { textMatch, type Query } from '../src/core/query.ts';
import { silentSink } from '../src/core/report.ts';
import { renderScreen } from '../src/core/screen.ts';
import { directionToward } from '../src/core/scroll.ts';
import { openSession } from '../src/core/session.ts';
import { createFakeDriver, createRecordingSink, type FakeDriver } from './fake-driver.ts';
import { loadScreen } from './fixtures.ts';

const byTestId = (testId: string): Query => ({ testId: textMatch(testId, true) });

const iosTop = loadScreen('ios-list');
const iosRaw = loadScreen('ios-list-raw');
const iosBottom = loadScreen('ios-list-scrolled');
const androidTop = loadScreen('android-list');
const androidRaw = loadScreen('android-list-raw');
const androidBottom = loadScreen('android-list-scrolled');

test('the iOS raw tree carries the rows the default tree scrolled away', () => {
  expect(iosTop.nodes.length).toBe(58);
  expect(iosRaw.nodes.length).toBe(115);
  expect(resolvedRef(iosTop, byTestId('row-30'))).toBe(null);
  expect(resolvedRef(iosRaw, byTestId('row-30'))).toBe('@e80');
  expect(resolvedRef(iosRaw, byTestId('list-done'))).toBe('@e102');
});

test('the Android raw tree stops at the window, so it carries no more rows than the default one', () => {
  expect(androidRaw.nodes.length).toBeGreaterThan(androidTop.nodes.length);
  expect(resolvedRef(androidTop, byTestId('row-30'))).toBe(null);
  expect(resolvedRef(androidRaw, byTestId('row-30'))).toBe(null);
  expect(resolvedRef(androidRaw, byTestId('list-done'))).toBe(null);
});

test('a rect below its scroll container points down', () => {
  expect(directionToward(iosTop, iosRaw, byTestId('list-done'))).toBe('down');
  expect(directionToward(iosTop, iosRaw, byTestId('row-30'))).toBe('down');
});

test('a target the raw tree never carries falls back to the container hint', () => {
  expect(directionToward(androidTop, androidRaw, byTestId('list-done'))).toBe('down');
  expect(directionToward(iosTop, null, byTestId('list-done'))).toBe('down');
});

test('a container at its end points back the way it came, which is what ends a search', () => {
  expect(directionToward(iosBottom, iosBottom, byTestId('row-99'))).toBe('up');
  expect(directionToward(androidBottom, androidBottom, byTestId('row-99'))).toBe('up');
});

test('a screen holding nothing out of view points nowhere', () => {
  const home = loadScreen('home');
  expect(directionToward(home, home, byTestId('nope'))).toBe(null);
});

test('the screen listing says which way a container is holding content', () => {
  expect(renderScreen(iosTop)).toContain('@e5 [scroll-area] "Row 1" [more below]');
  expect(renderScreen(iosBottom)).toContain('[more above]');
  expect(renderScreen(iosTop)).not.toContain('[more above]');
  expect(renderScreen(loadScreen('home'))).not.toContain('[more ');
});

/** What the fixtures hand the parser: touchpress's options plus Playwright's own `actionTimeout`. */
type ParseInput = Partial<TouchpressOptions> & { actionTimeout?: number };

const options: ParseInput = {
  platform: 'ios',
  app: 'dev.touchpress.e2e',
  target: { name: 'iPhone 17 Pro Max' },
  readyWhen: { testId: 'list' },
  launchTimeout: 1000,
  actionTimeout: 2000,
};

function openList(driver: FakeDriver, overrides?: ParseInput) {
  return openSession({
    options: parseDeviceOptions({ ...options, ...overrides }),
    slot: 0,
    scope: 'ios',
    sink: silentSink,
    createDriver: () => driver,
  });
}

function listDriver(): FakeDriver {
  return createFakeDriver({
    screens: ['ios-list'],
    rawScreens: ['ios-list-raw'],
    onScroll: ['ios-list-scrolled'],
  });
}

test('scrollIntoView scrolls until the default tree resolves the locator', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const app = createDevice(session, silentSink);

  await app.getByTestId('row-30').scrollIntoView();

  expect(driver.calls.filter((call) => call.startsWith('scroll'))).toEqual(['scroll down']);
  expect(driver.calls).toContain('capture raw');
  expect(await app.getByTestId('row-30').count()).toBe(1);
});

test('scrollIntoView costs one capture and no scroll when the target is already there', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const app = createDevice(session, silentSink);
  driver.calls.length = 0;

  await app.getByTestId('row-1').scrollIntoView();

  expect(driver.calls).toEqual(['capture']);
});

test('scrollIntoView reports the scroll it took as a nested step', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const sink = createRecordingSink();
  const app = createDevice(session, sink);

  await app.getByTestId('row-30').scrollIntoView();

  expect(sink.steps).toEqual([
    { title: `scrollIntoView getByTestId('row-30')`, depth: 0, boxed: false },
    { title: 'scroll down', depth: 1, boxed: false },
  ]);
});

test('a tap scrolls to its target on its own and dispatches against the screen it landed on', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const app = createDevice(session, silentSink);

  await app.getByTestId('list-done').tap();

  expect(driver.calls).toContain('scroll down');
  expect(driver.calls.at(-1)).toMatch(/^tap @e53~s\d+ settle=/);
});

test('a tap that has to scroll on Android gets its direction from the container alone', async () => {
  const driver = createFakeDriver({
    screens: ['android-list'],
    rawScreens: ['android-list-raw'],
    onScroll: ['android-list-scrolled'],
  });
  const session = await openList(driver, { platform: 'android', target: { name: 'Expo API 36' } });
  const app = createDevice(session, silentSink);

  await app.getByTestId('list-done').tap();

  expect(driver.calls).toContain('scroll down');
  expect(driver.calls.at(-1)).toMatch(/^tap @e43~s\d+ settle=/);
});

test('a search never reverses, so a target that is not there fails at the end of the list', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const app = createDevice(session, silentSink);

  const error = await app
    .getByTestId('row-99')
    .scrollIntoView()
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError) || error.info.kind !== 'not-found') return;
  expect(error.info.scrolled).toEqual({ steps: 1, direction: 'down' });
  expect(error.message).toContain('Scrolled: 1 step down');
  expect(driver.calls.filter((call) => call === 'scroll down').length).toBe(1);
});

test('a list that never runs out is stopped by the step cap rather than by the clock', async () => {
  // Every scroll leaves the same screen, which keeps saying there is more below.
  const driver = createFakeDriver({ screens: ['ios-list'], rawScreens: ['ios-list-raw'] });
  const session = await openList(driver, { actionTimeout: 60_000 });
  const app = createDevice(session, silentSink);

  const started = Date.now();
  const error = await app
    .getByTestId('row-99')
    .scrollIntoView()
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError) || error.info.kind !== 'not-found') return;
  expect(error.info.scrolled).toEqual({ steps: 20, direction: 'down' });
  expect(Date.now() - started).toBeLessThan(2000);
});

test('scrollIntoView refuses an ambiguous locator instead of scrolling', async () => {
  const driver = listDriver();
  const session = await openList(driver);
  const app = createDevice(session, silentSink);

  const error = await app
    .getByRole('text')
    .scrollIntoView()
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError)) return;
  expect(error.info.kind).toBe('strict-mode');
  expect(driver.calls).not.toContain('scroll down');
});

test('an action that never scrolled says nothing about scrolling', async () => {
  const driver = createFakeDriver();
  const session = await openList(driver, { readyWhen: { text: 'GET STARTED' } });
  const app = createDevice(session, silentSink);

  const error = await app
    .getByTestId('nope')
    .tap()
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(TouchpressError);
  if (!(error instanceof TouchpressError) || error.info.kind !== 'not-found') return;
  expect(error.info.scrolled).toBe(null);
  expect(error.message).not.toContain('Scrolled:');
});

function resolvedRef(screen: ReturnType<typeof loadScreen>, query: Query): string | null {
  const node = screen.nodes.find((candidate) => candidate.testId === query.testId?.value);
  return node?.ref ?? null;
}
