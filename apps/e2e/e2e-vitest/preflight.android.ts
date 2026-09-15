import { android } from './devices';
import { checkDevice } from './preflight';

export function setup(): Promise<void> {
  return checkDevice(android);
}
