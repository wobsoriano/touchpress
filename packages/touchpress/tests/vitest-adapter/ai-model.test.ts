import { beforeAll } from 'vitest';
import { expect, opens, sessionOpens, test as base } from './harness.ts';

/** Structurally an AI SDK model. `provide` could never carry a provider instance, so this is the spec-side path. */
const model = { specificationVersion: 'v4', provider: 'fake', modelId: 'fake-model' };

const test = base.extend({ aiModel: model });

let opensBefore = 0;
beforeAll(() => {
  opensBefore = opens();
});

test('overriding aiModel by value delivers the object on the one session this worker holds', ({
  device,
  aiModel,
}) => {
  expect(aiModel).toBe(model);
  expect(device.options.app).toBe('com.example.app');
  expect(sessionOpens()).toBe(1);
  expect(opens()).toBe(opensBefore + 1);
});

test('a second file still relaunches per test rather than opening a session', () => {
  expect(sessionOpens()).toBe(1);
  expect(opens()).toBe(opensBefore + 2);
});
