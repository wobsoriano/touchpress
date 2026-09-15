import type { DriverFactory } from '../core/driver.ts';
import { createAgentDeviceDriver, createClient } from './agent-device.ts';

/**
 * The default driver for both adapters and for `preflight`, and the one value
 * in the package that reaches `agent-device` at runtime. It is injected rather
 * than imported by the fixtures so the adapters' own suites can run the real
 * `test` and `expect` against a fake, with no module mocking and no alias.
 */
export const agentDeviceDriver: DriverFactory = (session, selection) =>
  createAgentDeviceDriver(createClient(), session, selection);
