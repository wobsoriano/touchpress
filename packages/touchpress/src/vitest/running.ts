import type { Device, Locator } from '../core/device.ts';
import type { TestIdentity } from './paths.ts';
import type { VitestSink } from './sink.ts';

/**
 * What a matcher needs from the test that built its target and cannot reach
 * through `this`, which under Vitest has no `annotate` and no output
 * directory. The `device` fixture binds this per test and clears it after.
 */
export type RunningTest = {
  readonly sink: VitestSink;
  readonly test: TestIdentity;
  /** Unnamed screenshots in one test are numbered from 1, so two never share a baseline. */
  screenshots: number;
  /**
   * Attaches the trail and the screen evidence, once. Called at the failure
   * site, while the body is still running, because Vitest closes a test's
   * annotations the moment its body ends.
   */
  failed(): Promise<void>;
};

const running = new WeakMap<Device, RunningTest>();

export function bindRunning(device: Device, entry: RunningTest): void {
  running.set(device, entry);
}

export function unbindRunning(device: Device): void {
  running.delete(device);
}

/** Undefined for a device no fixture built, such as one a script created from `touchpress/core`. */
export function runningOf(target: Device | Locator): RunningTest | undefined {
  return running.get('query' in target ? target.device : target);
}

export function runningFor(target: Device | Locator): RunningTest {
  const entry = runningOf(target);
  if (entry === undefined) {
    throw new Error(
      'toHaveScreenshot needs the device fixture of the running test. Pass the `device` fixture or a locator made from it.',
    );
  }
  return entry;
}
