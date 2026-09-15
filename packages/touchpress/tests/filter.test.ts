import { expect, test } from 'vite-plus/test';
import { parseDeviceOptions } from '../src/core/config.ts';
import { createDevice } from '../src/core/device.ts';
import { describeQuery, textMatch, type Query } from '../src/core/query.ts';
import { silentSink } from '../src/core/report.ts';
import { resolve, type Resolution } from '../src/core/screen.ts';
import { openSession } from '../src/core/session.ts';
import { createFakeDriver } from './fake-driver.ts';
import { loadScreen } from './fixtures.ts';

const home = loadScreen('home');
const androidHome = loadScreen('android-home');

/** A single-element list is always outcome `one`, because `many` needs two. */
function refs(resolution: Resolution): readonly string[] {
  switch (resolution.outcome) {
    case 'one':
      return [resolution.node.ref];
    case 'many':
      return resolution.nodes.map((node) => node.ref);
    case 'none':
      return [];
    default: {
      const never: never = resolution;
      throw new Error(`unhandled resolution ${JSON.stringify(never)}`);
    }
  }
}

function containers(filters: Query['filters']): Query {
  return { role: 'other', filters };
}

test('a hasText filter collapses a chain of containers to the innermost one holding the text', () => {
  // @e3, @e4 and @e5 all hold "Dev tools" and carry different names of their own.
  expect(refs(resolve(home, { role: 'other' })).length).toBeGreaterThan(1);
  expect(refs(resolve(home, containers([{ hasText: textMatch('Dev tools') }])))).toEqual(['@e5']);
});

test('hasText matches the candidate itself but has needs a strict descendant', () => {
  const own: Query = { role: 'text', filters: [{ hasText: textMatch('Dev tools') }] };
  const inside: Query = {
    role: 'text',
    filters: [{ has: { role: 'text', name: textMatch('Dev tools') } }],
  };
  expect(refs(resolve(home, own))).toEqual(['@e19']);
  expect(refs(resolve(home, inside))).toEqual([]);
});

test('a regex hasText narrows the same chain', () => {
  expect(
    refs(resolve(home, containers([{ hasText: { kind: 'regex', value: /^Dev tools$/ } }]))),
  ).toEqual(['@e5']);
});

test('hasNotText drops a candidate whose subtree carries the text, not only its own name', () => {
  const query: Query = { role: 'button', filters: [{ hasNotText: textMatch('Home') }] };
  expect(refs(resolve(home, { role: 'button' }))).toEqual(['@e29', '@e30']);
  expect(refs(resolve(home, query))).toEqual(['@e30']);

  // @e5 is named "Live from the cloud" and holds the "Dev tools" text a level down.
  expect(refs(resolve(home, { role: 'other' }))).toContain('@e5');
  expect(refs(resolve(home, containers([{ hasNotText: textMatch('Dev tools') }])))).not.toContain(
    '@e5',
  );
});

test('has keeps the containers holding a descendant match and drops the hint card', () => {
  // @e5 is the hint card. It holds the "Dev tools" text but no button.
  expect(refs(resolve(home, containers([{ has: { role: 'button' } }])))).toEqual([
    '@e3',
    '@e25',
    '@e27',
  ]);
});

test('hasNot is the inverse of has', () => {
  const withImage = containers([{ has: { role: 'image' } }]);
  expect(refs(resolve(home, withImage))).toEqual(['@e4', '@e5', '@e8', '@e11']);
  expect(
    refs(resolve(home, containers([{ has: { role: 'image' }, hasNot: { role: 'text' } }]))),
  ).toEqual(['@e8', '@e11']);
});

test('a second filter narrows the same way a second field in the first one would', () => {
  const chained = containers([{ has: { role: 'image' } }, { hasNot: { role: 'text' } }]);
  const combined = containers([{ has: { role: 'image' }, hasNot: { role: 'text' } }]);
  expect(refs(resolve(home, containers([{ has: { role: 'image' } }])))).toEqual([
    '@e4',
    '@e5',
    '@e8',
    '@e11',
  ]);
  expect(refs(resolve(home, chained))).toEqual(refs(resolve(home, combined)));
  expect(refs(resolve(home, chained))).toEqual(['@e8', '@e11']);
});

test('an inner query keeps its own filters and drops its own index', () => {
  const query = containers([{ has: containers([{ hasText: textMatch('Welcome') }]) }]);
  expect(refs(resolve(androidHome, query))).toEqual(['@e20']);

  const indexed = containers([{ has: { role: 'button', index: 99 } }]);
  expect(refs(resolve(home, indexed))).toEqual(
    refs(resolve(home, containers([{ has: { role: 'button' } }]))),
  );
});

test('an Android tree of unnamed containers narrows to one row', () => {
  // Every React Native View reports android.view.ViewGroup, so @e10 through @e21 are all `other`.
  expect(refs(resolve(androidHome, containers([{ hasText: textMatch('Welcome') }])))).toEqual([
    '@e21',
  ]);
  expect(refs(resolve(androidHome, containers([{ has: { role: 'button' } }])))).toEqual(['@e21']);
});

test('a miss on a hasText filter names the text the author was reaching for', () => {
  const resolution = resolve(home, containers([{ hasText: textMatch('Dev tolls') }]));
  expect(resolution.outcome).toBe('none');
  if (resolution.outcome !== 'none') return;
  expect(resolution.nearest.map((node) => node.name)).toEqual(['Dev tools']);
});

test('describeQuery renders the chain between the factory call and the index suffix', () => {
  expect(describeQuery(containers([{ hasText: textMatch('Dev tools') }]))).toBe(
    "getByRole('other').filter({ hasText: 'Dev tools' })",
  );
  expect(describeQuery({ ...containers([{ has: { role: 'button' } }]), index: 0 })).toBe(
    "getByRole('other').filter({ has: getByRole('button') }).first()",
  );
  expect(
    describeQuery({
      ...containers([
        { hasText: textMatch('Tab'), hasNotText: textMatch('Home') },
        { hasNot: { role: 'image' } },
      ]),
      index: 2,
    }),
  ).toBe(
    "getByRole('other').filter({ hasText: 'Tab', hasNotText: 'Home' }).filter({ hasNot: getByRole('image') }).nth(2)",
  );
  expect(
    describeQuery({ name: textMatch(/^Dev/), filters: [{ hasText: textMatch('tools') }] }),
  ).toBe("getByText(/^Dev/).filter({ hasText: 'tools' })");
  expect(
    describeQuery({ role: 'button', selected: true, filters: [{ hasText: textMatch('Home') }] }),
  ).toBe("locator({ role: 'button', selected: true }).filter({ hasText: 'Home' })");
  expect(
    describeQuery(containers([{ has: containers([{ hasText: textMatch('Sign in') }]) }])),
  ).toBe("getByRole('other').filter({ has: getByRole('other').filter({ hasText: 'Sign in' }) })");
});

test('locator.filter appends to the query and leaves the locator it came from alone', async () => {
  const session = await openSession({
    options: parseDeviceOptions({
      platform: 'ios',
      app: 'com.wobsoriano.awesometodo',
      target: { name: 'iPhone 17 Pro Max' },
      readyWhen: { text: 'GET STARTED' },
      launchTimeout: 1000,
      actionTimeout: 600,
    }),
    slot: 0,
    scope: 'ios',
    sink: silentSink,
    createDriver: () => createFakeDriver(),
  });
  const device = createDevice(session, silentSink);

  const all = device.getByRole('other');
  const holdingText = all.filter({ hasText: 'Dev tools' });
  const holdingButton = all.filter({ has: device.getByRole('button') });

  expect(all.query.filters).toBeUndefined();
  expect(holdingText.description).toBe("getByRole('other').filter({ hasText: 'Dev tools' })");
  expect(holdingButton.description).toBe("getByRole('other').filter({ has: getByRole('button') })");
  expect(holdingText.filter({ hasNot: device.getByRole('image') }).description).toBe(
    "getByRole('other').filter({ hasText: 'Dev tools' }).filter({ hasNot: getByRole('image') })",
  );
  expect(await holdingText.count()).toBe(1);
  expect(await holdingButton.count()).toBe(3);

  await session.close('requested');
});
