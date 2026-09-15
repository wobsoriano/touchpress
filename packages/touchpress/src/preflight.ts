/**
 * Outside `core/` on purpose: this is the one function that needs a concrete
 * driver, and no module under `core/` may import `agent-device`.
 */

import {
  parseDeviceOptions,
  type DeviceChoice,
  type Target,
  type TouchpressOptions,
} from './core/config.ts';
import type { DeviceDriver, DeviceInfo } from './core/driver.ts';
import { describeFailure } from './core/errors.ts';
import type { Platform } from './core/screen.ts';
import { failureOf } from './core/session.ts';
import { createAgentDeviceDriver, createClient } from './driver/agent-device.ts';

export type PreflightDevice = { readonly name: string; readonly id: string };

export type PreflightReport =
  | { readonly ok: true; readonly device: PreflightDevice }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * A device that is not booted is reported as problems rather than thrown, so a
 * runner names every one of them at once. A malformed config still throws, the
 * way it does everywhere else. `driver` and `env` are the seams tests inject.
 */
export async function preflight(
  options: Partial<TouchpressOptions>,
  driver?: DeviceDriver,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreflightReport> {
  const resolved = parseDeviceOptions(options);
  const target = resolved.target;
  if (target.kind !== 'local') return cloudReport(target, resolved.platform, env);

  const lister =
    driver ??
    createAgentDeviceDriver(createClient(target), `${resolved.sessionPrefix}-preflight`, {
      platform: resolved.platform,
      name: null,
      target,
    });

  let devices: readonly DeviceInfo[];
  try {
    devices = await lister.listDevices();
  } catch (error) {
    return { ok: false, problems: [unreachable(resolved.platform, error)] };
  }

  const booted = devices.filter((device) => device.booted);
  const wanted = namesOf(target.device);
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

/**
 * Nothing here reaches the provider. Listing devices against one can allocate the session its
 * lease defers, so the check meant to run before the suite would start the run it is checking.
 * What is left to check is what agent-device will read out of the environment.
 */
function cloudReport(
  target: Exclude<Target, { kind: 'local' }>,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): PreflightReport {
  switch (target.kind) {
    case 'browserstack': {
      const problems = [
        ...missing(env, 'BROWSERSTACK_USERNAME'),
        ...missing(env, 'BROWSERSTACK_ACCESS_KEY'),
      ];
      if (problems.length > 0) return { ok: false, problems };
      const name = target.device.kind === 'named' ? target.device.name : target.device.names[0];
      return { ok: true, device: { name, id: name } };
    }
    case 'aws-device-farm': {
      const region = firstSet(target.region, env['AWS_REGION'], env['AWS_DEFAULT_REGION']);
      // The credentials themselves come from the AWS chain, which resolves profiles and web
      // identity as well as variables, so there is nothing here that could check them.
      if (region === null) {
        return {
          ok: false,
          problems: [
            'No AWS region is set. Set use.target.region, or AWS_REGION or AWS_DEFAULT_REGION in the environment.',
          ],
        };
      }
      return { ok: true, device: { name: target.deviceArn, id: target.deviceArn } };
    }
    case 'limrun': {
      const problems = missing(env, 'LIMRUN_API_KEY');
      if (problems.length > 0) return { ok: false, problems };
      return { ok: true, device: { name: `limrun ${platform}`, id: 'limrun' } };
    }
    default: {
      const never: never = target;
      throw new Error(`unhandled target ${JSON.stringify(never)}`);
    }
  }
}

/** An empty variable is unset, which is what an exported-but-blank one amounts to. */
function firstSet(...values: readonly (string | null | undefined)[]): string | null {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function missing(env: NodeJS.ProcessEnv, variable: string): string[] {
  const value = env[variable];
  if (value !== undefined && value !== '') return [];
  return [
    `${variable} is unset. agent-device reads it from the environment to reach the provider.`,
  ];
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
  return `No booted ${platform} device is named '${name}'. Booted right now: ${listing}. Set use.target.name to one of those or boot '${name}'.`;
}
