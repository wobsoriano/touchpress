import { expect, test } from 'touchpress/playwright';

test('signing out from the profile returns to the signed-out home', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');
  await device.getByRole('text-field', { name: 'Password' }).fill('hunter2', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();
  await expect(device.getByTestId('profile-email')).toBeVisible();

  await device.getByRole('button', { name: 'Sign out' }).tap();

  await expect(device.getByRole('text', { name: 'Welcome' })).toBeVisible();
  await expect(device.getByTestId('greeting')).not.toBeVisible();
});
