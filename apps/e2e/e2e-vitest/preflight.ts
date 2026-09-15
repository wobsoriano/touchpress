import { preflight } from 'touchpress';
import { app, readyWhen } from './devices';

/** Vitest has no setup project, so each project's `globalSetup` asks the same question a Playwright setup project does. */
export async function checkDevice(device: {
  readonly platform: 'ios' | 'android';
  readonly deviceName: string;
}): Promise<void> {
  const report = await preflight({ ...device, app, readyWhen });
  if (report.ok) return;
  throw new Error(report.problems.join('\n'));
}
