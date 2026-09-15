/**
 * Outside `core/` on purpose: this is the one function that needs a concrete
 * driver, and no module under `core/` may import `agent-device`.
 */

import { parseDeviceOptions, type DeviceChoice, type TouchpressOptions } from './core/config.ts';
import type { DeviceDriver, DeviceInfo } from './core/driver.ts';
import { describeFailure } from './core/errors.ts';
import type { Platform } from './core/screen.ts';
import { failureOf } from './core/session.ts';
import { agentDeviceDriver } from './driver/index.ts';

export type PreflightDevice = { readonly name: string; readonly id: string };

export type PreflightReport =
  | { readonly ok: true; readonly device: PreflightDevice }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * A device that is not booted is reported as problems rather than thrown, so a
 * runner names every one of them at once. A malformed config still throws, the
 * way it does everywhere else. `driver` is the seam tests inject.
 */
export async function preflight(
  options: Partial<TouchpressOptions>,
  driver?: DeviceDriver,
): Promise<PreflightReport> {
  const resolved = parseDeviceOptions(options);
  const lister =
    driver ??
    agentDeviceDriver(`${resolved.sessionPrefix}-preflight`, {
      platform: resolved.platform,
      name: null,
    });

  let devices: readonly DeviceInfo[];
  try {
    devices = await lister.listDevices();
  } catch (error) {
    return { ok: false, problems: [unreachable(resolved.platform, error)] };
  }

  const booted = devices.filter((device) => device.booted);
  const wanted = namesOf(resolved.device);
  if (wanted.length === 0) {
    const picked = booted[0];
    if (picked === undefined) return { ok: false, problems: [noneBooted(resolved.platform)] };
    return { ok: true, device: { name: picked.name, id: picked.id } };
  }

  const found: DeviceInfo[] = [];
  const problems: string[] = [];
  for (const name of wanted) {
    const match = booted.find((device) => device.name === name);
    if (match === undefined) problems.push(notBooted(resolved.platform, name, booted));
    else found.push(match);
  }
  const picked = found[0];
  if (problems.length > 0 || picked === undefined) return { ok: false, problems };
  return { ok: true, device: { name: picked.name, id: picked.id } };
}

/** The names this choice insists on. Empty means any booted device will do. */
function namesOf(choice: DeviceChoice): readonly string[] {
  switch (choice.kind) {
    case 'first-booted':
      return [];
    case 'named':
      return [choice.name];
    case 'pool':
      return choice.names;
    default: {
      const never: never = choice;
      throw new Error(`unhandled device choice ${JSON.stringify(never)}`);
    }
  }
}

function unreachable(platform: Platform, error: unknown): string {
  const failure = failureOf(error);
  const detail =
    failure === null
      ? error instanceof Error
        ? error.message
        : String(error)
      : describeFailure(failure);
  return `Could not list ${platform} devices: ${detail}. Check that the agent-device daemon is reachable.`;
}

function noneBooted(platform: Platform): string {
  return `No ${platform} device is booted. Boot one with \`agent-device device boot --platform ${platform}\`.`;
}

function notBooted(platform: Platform, name: string, booted: readonly DeviceInfo[]): string {
  if (booted.length === 0) {
    return `No booted ${platform} device is named '${name}', because no ${platform} device is booted at all. Boot '${name}'.`;
  }
  const listing = booted.map((device) => `'${device.name}'`).join(', ');
  return `No booted ${platform} device is named '${name}'. Booted right now: ${listing}. Set use.deviceName to one of those or boot '${name}'.`;
}
