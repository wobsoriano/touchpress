import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createTest } from '../../src/vitest/fixtures.ts';
import { createFakeDriver } from '../fake-driver.ts';

export { expect } from '../../src/vitest/index.ts';

/**
 * One driver for the whole worker. Both spec files import this module, and
 * under `isolate: false` the module registry survives the file boundary, so a
 * second `open` on this driver would mean the adapter reopened the session.
 */
export const driver = createFakeDriver();
driver.png = solid();

export const outputDir = mkdtempSync(join(tmpdir(), 'touchpress-vitest-adapter-'));

/** The real fixtures over the fake driver. Options arrive by value here where a config would `provide` them. */
export const test = createTest(() => driver).extend({
  platform: 'ios',
  app: 'com.example.app',
  readyWhen: { text: 'GET STARTED' },
  settleQuietMs: 20,
  actionTimeout: 500,
  expectTimeout: 400,
  outputDir,
});

export function opens(): number {
  return driver.calls.filter((call) => call.startsWith('open ')).length;
}

export function screenshots(): string[] {
  return driver.calls
    .filter((call) => call.startsWith('screenshot '))
    .map((call) => call.slice('screenshot '.length));
}

/** A white image the size of the home fixture's window, so a crop lands at scale 1. */
function solid(): Buffer {
  const image = new PNG({ width: 440, height: 956 });
  image.data.fill(255);
  return PNG.sync.write(image);
}
