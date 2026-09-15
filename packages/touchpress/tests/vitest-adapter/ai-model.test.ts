import { driver, expect, opens, test as base } from './harness.ts';

/** Structurally an AI SDK model. `provide` could never carry a provider instance, so this is the spec-side path. */
const model = { specificationVersion: 'v4', provider: 'fake', modelId: 'fake-model' };

const test = base.extend({ aiModel: model });

test('overriding aiModel by value delivers the object and inherits the open session', async ({
  device,
  aiModel,
}) => {
  expect(aiModel).toBe(model);
  expect(device.options.app).toBe('com.example.app');
  expect(opens()).toBeGreaterThan(1);
  expect(driver.calls.filter((call) => call === 'close touchpress-vitest-adapter-0').length).toBe(
    1,
  );
  await Promise.resolve();
});

test('a second file still relaunches per test on the one session', async () => {
  const before = opens();
  expect(before).toBeGreaterThan(2);
  await Promise.resolve();
});
