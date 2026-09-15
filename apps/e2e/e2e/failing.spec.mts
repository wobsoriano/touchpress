import { expect, test } from 'touchpress/playwright';

test('a locator that never resolves reports the screen it looked at', async ({ device }) => {
  await expect(device.getByText('Sign out')).toBeVisible({ timeout: 3000 });
});
