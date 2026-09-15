import { expect, test } from 'touchpress/playwright';

test('the signed-out home screen offers a way in', async ({ device }) => {
  await expect(device.getByRole('text', { name: 'Welcome' })).toHaveText('Welcome', {
    exact: true,
  });
  await expect(device.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await expect(device.getByTestId('greeting')).not.toBeVisible();
});
