import type { ReadyQuery } from 'touchpress';

/**
 * What the config provides and what each project's global setup checks, in one
 * place so the two cannot name different devices. The names are overridable
 * because CI boots whatever model its runner image carries, which is not the
 * one on a developer's machine. Preflight turns a mismatch into one readable
 * failure.
 */
export const app = 'dev.touchpress.e2e';
export const readyWhen: ReadyQuery = { testId: 'home' };

export const ios = {
  platform: 'ios',
  deviceName: process.env['TOUCHPRESS_IOS_DEVICE'] ?? 'iPhone 17 Pro Max',
} as const;

export const android = {
  platform: 'android',
  deviceName: process.env['TOUCHPRESS_ANDROID_DEVICE'] ?? 'Expo API 36',
} as const;
