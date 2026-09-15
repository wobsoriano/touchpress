import { ios } from './devices';
import { checkDevice } from './preflight';

export function setup(): Promise<void> {
  return checkDevice(ios);
}
