import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseScreen, type Platform, type RawSnapshot, type Screen } from '../src/core/screen.ts';

/** The platform belongs to the capture, so no call site has to remember it. */
const FIXTURE_PLATFORMS = {
  home: 'ios',
  explore: 'ios',
  'ios-login': 'ios',
  'android-home': 'android',
  'android-login': 'android',
  'ios-list': 'ios',
  'ios-list-raw': 'ios',
  'ios-list-scrolled': 'ios',
  'android-list': 'android',
  'android-list-raw': 'android',
  'android-list-scrolled': 'android',
  'macos-config-missing': 'macos',
} satisfies Readonly<Record<string, Platform>>;

export type FixtureName = keyof typeof FIXTURE_PLATFORMS;

/**
 * The fixtures are verbatim `agent-device snapshot --json` output for the
 * sample app, envelope included, so the parser is exercised against the real
 * response shape rather than a hand-written approximation.
 */
export function loadRaw(name: FixtureName): RawSnapshot {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  const envelope: { data: RawSnapshot } = JSON.parse(readFileSync(path, 'utf8'));
  return envelope.data;
}

export function loadScreen(name: FixtureName): Screen {
  return parseScreen(loadRaw(name), FIXTURE_PLATFORMS[name]);
}
