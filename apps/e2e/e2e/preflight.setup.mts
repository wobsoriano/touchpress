import { preflight, setupTest } from 'touchpress';

// `setupTest` carries touchpress's options and none of its fixtures. Touchpress's `test` would open a
// device session through its auto `device` fixture, before preflight has checked the device.
setupTest(
  'the project names a booted device',
  async ({ platform, app, readyWhen, target, sessionPrefix }) => {
    const report = await preflight({ platform, app, readyWhen, target, sessionPrefix });
    if (report.ok) return;
    throw new Error(report.problems.join('\n'));
  },
);
