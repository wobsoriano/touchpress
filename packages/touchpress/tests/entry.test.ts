import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';

const root = fileURLToPath(new URL('../src/', import.meta.url));

const STATEMENT = /\b(import|export)\s+(type\s+)?(\*|\{[^}]*\}|[\w$]+)?\s*from\s+'([^']+)'/g;

type Follow = (
  keyword: string,
  typeOnly: string | undefined,
  clause: string | undefined,
) => boolean;

function walk(entry: string, follow: Follow): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    const source = readFileSync(path, 'utf8');
    seen.set(path, source);
    for (const [, keyword, typeOnly, clause, specifier] of source.matchAll(STATEMENT)) {
      if (specifier === undefined || !specifier.startsWith('.')) continue;
      if (keyword !== undefined && follow(keyword, typeOnly, clause)) {
        visit(resolve(dirname(path), specifier));
      }
    }
  };
  visit(entry);
  return seen;
}

/** Every relative module the entry loads at all, value and type alike. */
function reachable(entry: string): Map<string, string> {
  return walk(entry, () => true);
}

/**
 * The relative modules whose types can land in an entry's declaration file:
 * anything reached through `import type`, an inline `type` specifier, or a
 * re-export. A value-only import is left alone, because the declaration
 * bundler drops what no exported type refers to.
 */
function typeReachable(entry: string): Map<string, string> {
  return walk(
    entry,
    (keyword, typeOnly, clause) =>
      typeOnly !== undefined || keyword === 'export' || (clause ?? '').includes('type '),
  );
}

/** Modules in `sources` with a static `from '<specifier>'`, relative to `src/`. */
function importersOf(sources: Map<string, string>, specifier: string): string[] {
  return [...sources]
    .filter(([, source]) => source.includes(`from '${specifier}'`))
    .map(([path]) => relative(root, path));
}

type EntryRule = {
  readonly entry: string;
  /** Not loaded at runtime, and therefore not in the declarations either. */
  readonly forbidden: readonly string[];
  /** Loaded at runtime, but never named by the declarations. */
  readonly typeForbidden: readonly string[];
};

/**
 * The whole boundary in one place. `core` reaching neither `agent-device` nor
 * a runner is what lets a third adapter be built on it, and the root reaching
 * no runner is what lets a config import types without installing one.
 */
const ENTRIES: readonly EntryRule[] = [
  { entry: 'index.ts', forbidden: ['@playwright/test', 'vitest'], typeForbidden: ['ai'] },
  {
    entry: 'core/index.ts',
    forbidden: ['@playwright/test', 'vitest', 'agent-device', 'ai'],
    typeForbidden: [],
  },
  { entry: 'playwright/index.ts', forbidden: ['vitest'], typeForbidden: ['ai'] },
  { entry: 'vitest/index.ts', forbidden: ['@playwright/test'], typeForbidden: ['ai'] },
];

for (const rule of ENTRIES) {
  for (const specifier of rule.forbidden) {
    test(`${rule.entry} reaches no module that imports ${specifier}`, () => {
      expect(importersOf(reachable(resolve(root, rule.entry)), specifier)).toEqual([]);
    });
  }
  for (const specifier of rule.typeForbidden) {
    test(`${rule.entry}'s types reach no module that imports ${specifier}`, () => {
      expect(importersOf(typeReachable(resolve(root, rule.entry)), specifier)).toEqual([]);
    });
  }
}

/** `pack.entry` in vite.config.ts is what gets published, so a packed entry with no rule fails here. */
test('every packed entry has a boundary rule', () => {
  const config = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
  const packed = [...(/entry:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '').matchAll(/'src\/([^']+)'/g)]
    .map(([, entry]) => entry)
    .sort();
  expect(packed.length).toBeGreaterThan(0);
  expect(ENTRIES.map((rule) => rule.entry).sort()).toEqual(packed);
});
