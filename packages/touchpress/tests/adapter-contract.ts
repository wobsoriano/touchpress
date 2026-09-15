import assert from 'node:assert/strict';
import type { AiDevice } from '../src/ai/device.ts';
import type { Device, Locator } from '../src/core/device.ts';

/** The slice of an adapter's `expect` the contract needs, so both adapters' own types satisfy it. */
export type ContractAssertion = {
  toBeVisible(options?: { timeout?: number }): Promise<void>;
  toBeEnabled(options?: { timeout?: number }): Promise<void>;
  toHaveText(
    expected: string | RegExp,
    options?: { timeout?: number; exact?: boolean },
  ): Promise<void>;
  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void>;
  readonly not: ContractAssertion;
};

export type Contract = {
  readonly test: (
    name: string,
    body: (context: { device: Device & AiDevice }) => Promise<void>,
  ) => void;
  readonly expect: (locator: Locator) => ContractAssertion;
};

/**
 * The scenarios both adapters register, so one body proves the two agree on
 * what a matcher does, what a failure says, and what `.not` waits for. Plain
 * values are checked with `node:assert`, which keeps the `expect` the contract
 * needs down to the locator surface.
 */
export function defineContract({ test, expect }: Contract): void {
  test('a node on screen passes toBeVisible, toBeEnabled and toHaveText', async ({ device }) => {
    const explore = device.getByRole('button', { name: 'Explore' });
    await expect(explore).toBeVisible();
    await expect(explore).toBeEnabled();
    await expect(explore).toHaveText('Explore', { exact: true });
    await expect(device.getByRole('button')).toHaveCount(2);
  });

  test('a node not on screen passes not.toBeVisible and toHaveCount(0)', async ({ device }) => {
    await expect(device.getByText('Sign out')).not.toBeVisible();
    await expect(device.getByText('Sign out')).toHaveCount(0);
  });

  test('a matcher that never holds rejects with the probe message', async ({ device }) => {
    const error = await expect(device.getByText('Sign out'))
      .toBeVisible({ timeout: 100 })
      .catch((thrown: unknown) => thrown);
    assert.ok(error instanceof Error);
    assert.match(error.message, /Expected toBeVisible but it never held\./);
    assert.match(error.message, /Locator: getByText\('Sign out'\)/);
    assert.match(error.message, /Received: no node matched/);
    assert.match(error.message, /Timeout: 100ms/);
    assert.match(error.message, /@e14 \[text\] "GET STARTED"/);
  });

  test('.not on a node that stays on screen waits the budget and names the negation', async ({
    device,
  }) => {
    const error = await expect(device.getByRole('button', { name: 'Explore' }))
      .not.toBeVisible({ timeout: 100 })
      .catch((thrown: unknown) => thrown);
    assert.ok(error instanceof Error);
    assert.match(error.message, /Expected not\.toBeVisible but it never held\./);
    assert.match(error.message, /Expected: not visible/);
  });

  test('the device carries the resolved options a spec may read', async ({ device }) => {
    assert.equal(device.options.platform, 'ios');
    assert.equal(device.options.app, 'com.example.app');
    await Promise.resolve();
  });
}
