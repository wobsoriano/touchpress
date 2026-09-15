import { expect, test } from 'touchpress/playwright';

test('the signed-out home screen looks the way it did', async ({ device }) => {
  await expect(device).toHaveScreenshot('home.png');
});

test('the sign-in button looks the way it did', async ({ device }) => {
  await expect(device.getByRole('button', { name: 'Sign in' })).toHaveScreenshot('sign-in.png');
});
