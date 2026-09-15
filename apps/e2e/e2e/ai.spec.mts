import { expect, test } from 'touchpress/playwright';
import { z } from 'zod';

test.skip(!process.env['AI_MODEL'], 'set AI_MODEL and ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY');

test('a model signs in and a deterministic assertion decides the test', async ({ device }) => {
  test.setTimeout(180_000);

  const summary = await device.act(
    'Sign in with the email rob@example.com and the password hunter2, then go back to the home screen',
  );
  expect(summary).not.toBe('');

  await expect(device.getByTestId('greeting')).toHaveText('Hi, Rob', { exact: true });

  const answer = await device.extract(
    'Is a user signed in on this screen?',
    z.object({ signedIn: z.boolean(), reason: z.string() }),
  );
  expect(answer.signedIn).toBe(true);
});
