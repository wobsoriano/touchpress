/**
 * `touchpress`, the vocabulary. Runner-free.
 *
 * What a config file or a page-object module names without naming a runner:
 * the types, `TouchpressError`, and `preflight`. `test` and `expect` name a
 * runner, so they live on `touchpress/playwright` and `touchpress/vitest`, and
 * there is no alias back. `touchpress/core` is the kit an adapter is built
 * from, and is deliberately larger and lower-level than this.
 */

import type { AiDevice } from './ai/device.ts';
import type { AiOptions } from './ai/options.ts';
import type { TouchpressOptions as CoreOptions } from './core/config.ts';
import type { Device as CoreDevice } from './core/device.ts';

/**
 * `Device` and `TouchpressOptions` carry the AI surface here and on the two
 * adapter entries. `touchpress/core` exports the runner-independent pair
 * without it, because nothing under `core/` may name an AI SDK type.
 */
export type TouchpressOptions = CoreOptions & AiOptions;
export type Device = CoreDevice & AiDevice;

export { TouchpressError } from './core/errors.ts';
export type { ErrorInfo, ExpectedValue } from './core/errors.ts';

export { preflight } from './preflight.ts';
export type { PreflightDevice, PreflightReport } from './preflight.ts';

export type { ScreenshotOptions } from './core/screenshot-assertion.ts';

export type { AiModel, AiOptions } from './ai/options.ts';
export type { ActOptions, AiDevice, ExtractOptions, ExtractSchema } from './ai/device.ts';

export type { ReadyQuery } from './core/config.ts';
export type { BackOptions, FilterOptions, Keyboard, Locator, TypeOptions } from './core/device.ts';
export type { Filter, Query, Role, TextMatch } from './core/query.ts';
export type { Platform, Rect, Screen, ScreenNode } from './core/screen.ts';
