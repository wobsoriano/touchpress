import { anthropic } from '@ai-sdk/anthropic';
import { expect, test as base } from 'touchpress/vitest';
import { z } from 'zod';

// An Anthropic key makes AI_MODEL a bare Anthropic id, and a provider instance cannot ride
// `provide`, so this spec extends the fixture by value. Without a key the config provides the
// gateway id and the base test already carries it.
const modelId = process.env['AI_MODEL'];
const test =
  modelId !== undefined && process.env['ANTHROPIC_API_KEY'] !== undefined
    ? base.extend({ aiModel: anthropic(modelId) })
    : base;

test.skipIf(modelId === undefined)(
  'a model signs in and a deterministic assertion decides the test',
  async ({ device }) => {
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
  },
  180_000,
);
