import { expect, test } from 'vite-plus/test';
import { pickCallerFrame } from '../src/playwright/caller.ts';

const packageDir = '/repo/packages/touchpress';

test('the first frame outside touchpress, node_modules, and node internals is the spec', () => {
  const stack = [
    'Error',
    `    at Object.step (${packageDir}/dist/preflight-D1aux7ic.mjs:815:20)`,
    `    at async Device.tap (${packageDir}/dist/index.mjs:120:9)`,
    '    at TestInfoImpl._runAsStep (/repo/node_modules/playwright/lib/worker/testInfo.js:44:7)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at /repo/specs/login.spec.ts:42:7',
  ].join('\n');
  expect(pickCallerFrame(stack, packageDir)).toEqual({
    file: '/repo/specs/login.spec.ts',
    line: 42,
    column: 7,
  });
});

test('a stack of nothing but internal frames has no caller to report', () => {
  const stack = [
    'Error',
    `    at Object.step (${packageDir}/dist/index.mjs:1:1)`,
    '    at node:internal/process/task_queues:95:5',
    '    at <anonymous>',
  ].join('\n');
  expect(pickCallerFrame(stack, packageDir)).toBeUndefined();
});

test('both the named and the bare frame forms parse', () => {
  const named = 'Error\n    at Object.<anonymous> (/repo/specs/a.spec.ts:3:11)';
  expect(pickCallerFrame(named, packageDir)).toEqual({
    file: '/repo/specs/a.spec.ts',
    line: 3,
    column: 11,
  });

  const bare = 'Error\n    at /repo/specs/b.spec.ts:9:2';
  expect(pickCallerFrame(bare, packageDir)).toEqual({
    file: '/repo/specs/b.spec.ts',
    line: 9,
    column: 2,
  });

  const constructed = 'Error\n    at new Page (/repo/specs/c.spec.ts:5:4)';
  expect(pickCallerFrame(constructed, packageDir)).toEqual({
    file: '/repo/specs/c.spec.ts',
    line: 5,
    column: 4,
  });
});

test('a file URL frame reports a filesystem path, and is matched against the package as one', () => {
  const stack = [
    'Error',
    `    at Device.tap (file://${packageDir}/dist/index.mjs:815:20)`,
    '    at async file:///repo/specs/login.spec.ts:12:3',
  ].join('\n');
  expect(pickCallerFrame(stack, packageDir)).toEqual({
    file: '/repo/specs/login.spec.ts',
    line: 12,
    column: 3,
  });
});

test('a sibling directory sharing the package prefix is still the caller', () => {
  const stack = `Error\n    at run (${packageDir}-other/x.ts:7:1)`;
  expect(pickCallerFrame(stack, packageDir)).toEqual({
    file: `${packageDir}-other/x.ts`,
    line: 7,
    column: 1,
  });
});
