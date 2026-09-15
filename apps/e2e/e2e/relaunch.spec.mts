import { expect, test } from 'touchpress/playwright';

test('a test can leave the app signed in on the profile', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByTestId('email').fill('rob@example.com');
  await device.getByTestId('password').fill('hunter2', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();

  await expect(device.getByTestId('profile-name')).toBeVisible();
});

test('the next test still starts signed out', async ({ device }) => {
  await expect(device.getByText('Welcome')).toBeVisible();
  await expect(device.getByTestId('greeting')).not.toBeVisible();
});
