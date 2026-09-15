/**
 * `defineConfig` is not re-exported. A config imports it from `@playwright/test`
 * and parameterizes it with `TouchpressOptions`, which keeps this package from
 * wrapping something it adds nothing to.
 */

import type { AiDevice } from './ai/device.ts';
import type { AiOptions } from './ai/options.ts';
import type { TouchpressOptions as CoreOptions } from './core/config.ts';
import type { Device as CoreDevice } from './core/device.ts';

export { setupTest, test } from './playwright/fixtures.ts';

export { expect } from './playwright/expect.ts';
export type { ScreenshotOptions } from './core/screenshot-assertion.ts';

export { TouchpressError } from './core/errors.ts';
export type { ErrorInfo, ExpectedValue } from './core/errors.ts';

export { preflight } from './preflight.ts';
export type { PreflightDevice, PreflightReport } from './preflight.ts';

/**
 * `Device` and `TouchpressOptions` carry the AI surface here and only here.
 * `touchpress/core` exports the runner-independent pair without it, because
 * nothing under `core/` may name an AI SDK type.
 */
export type TouchpressOptions = CoreOptions & AiOptions;
export type Device = CoreDevice & AiDevice;

export type { AiModel, AiOptions } from './ai/options.ts';
export type { ActOptions, AiDevice, ExtractOptions, ExtractSchema } from './ai/device.ts';

export type { ReadyQuery } from './core/config.ts';
export type { BackOptions, FilterOptions, Keyboard, Locator, TypeOptions } from './core/device.ts';
export type { Filter, Query, Role, TextMatch } from './core/query.ts';
export type { Platform, Rect, Screen, ScreenNode } from './core/screen.ts';
