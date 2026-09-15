import { PNG } from 'pngjs';
import { createTest } from '../../src/playwright/fixtures.ts';
import { expect } from '../../src/playwright/index.ts';
import { defineContract } from '../adapter-contract.ts';
import { createFakeDriver } from '../fake-driver.ts';

const driver = createFakeDriver();
const image = new PNG({ width: 440, height: 956 });
image.data.fill(255);
driver.png = PNG.sync.write(image);

const test = createTest(() => driver);

function opens(): number {
  return driver.calls.filter((call) => call.startsWith('open ')).length;
}

test('the first test opens the session once and skips the relaunch', async ({ device }) => {
  expect(opens()).toBe(1);
  expect(device.options.expectTimeout).toBe(7000);
  expect(device.options.actionTimeout).toBe(500);
});

test('the second test relaunches on the way in', async () => {
  expect(opens()).toBe(2);
});

defineContract({ test, expect });

test('a failing body captures evidence', async ({ device }) => {
  await expect(device.getByText('Sign out')).toBeVisible({ timeout: 100 });
});

test.fail('an expected failure attaches nothing', async ({ device }) => {
  await expect(device.getByText('Sign out')).toBeVisible({ timeout: 100 });
});

test('a named screenshot is written under the project on the first run', async ({ device }) => {
  await expect(device.getByRole('button', { name: 'Explore' })).toHaveScreenshot('explore.png');
});
