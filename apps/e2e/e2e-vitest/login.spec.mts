import { expect, test } from 'touchpress/vitest';

test('the wrong password is rejected without leaving the login screen', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByRole('text-field', { name: 'Email' }).fill('rob@example.com');
  await device.getByTestId('password').fill('wrong', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();

  await expect(device.getByTestId('error')).toHaveText('Wrong email or password', { exact: true });
  await expect(device.getByTestId('profile-name')).not.toBeVisible();
});

test('the right credentials land on the profile after the sign-in wait', async ({ device }) => {
  await device.getByTestId('sign-in-link').tap();
  await device.getByRole('text-field').first().fill('rob@example.com');
  await expect(device.getByRole('text-field').first()).toHaveValue('rob@example.com');

  await device.getByTestId('password').fill('hunter2', { secret: true });
  await device.getByRole('button', { name: 'Sign in' }).tap();

  await expect(device.getByTestId('signing-in')).toBeVisible();
  await expect(device.getByRole('button', { name: 'Sign in' })).not.toBeEnabled();

  await expect(device.getByRole('text', { name: 'Rob', exact: true })).toHaveText('Rob', {
    exact: true,
  });
  await expect(device.getByTestId('profile-email')).toHaveText('rob@example.com', { exact: true });
});
