import { expect, test } from 'touchpress/vitest';

test('a row far down the list is scrolled into view', async ({ device }) => {
  await device.getByTestId('list-link').tap();

  const row = device.getByTestId('row-30');
  await expect(row).not.toBeVisible();
  await row.scrollIntoView();

  await expect(row).toBeVisible();
});

test('a tap reaches a button below the fold without being told to scroll', async ({ device }) => {
  await device.getByTestId('list-link').tap();

  await device.getByTestId('list-done').tap();

  await expect(device.getByTestId('home')).toBeVisible();
});
