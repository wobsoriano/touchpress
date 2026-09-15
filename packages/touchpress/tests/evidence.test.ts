import { expect, test } from 'vite-plus/test';
import { evidenceWanted } from '../src/core/evidence.ts';

test('evidence is captured on an unexpected outcome, always, or never, by policy', () => {
  expect(evidenceWanted('on-failure', true)).toBe(true);
  expect(evidenceWanted('on-failure', false)).toBe(false);
  expect(evidenceWanted('always', false)).toBe(true);
  expect(evidenceWanted('always', true)).toBe(true);
  expect(evidenceWanted('off', true)).toBe(false);
  expect(evidenceWanted('off', false)).toBe(false);
});
