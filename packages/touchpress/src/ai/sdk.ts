import { TouchpressError } from '../core/errors.ts';

/**
 * The AI SDK is an optional peer, so it is imported here and never at module
 * scope. Importing `touchpress` must not require it, because a project that
 * calls neither `act` nor `extract` never installs it.
 */
export async function loadAi(): Promise<typeof import('ai')> {
  try {
    return await import('ai');
  } catch {
    throw new TouchpressError({ kind: 'ai-missing-peer' });
  }
}
