// Every spec in e2e/ has a twin in e2e-vitest/ that differs only in the import line, so the two
// runners are proven against the same tests. Run from anywhere: node apps/e2e/scripts/spec-parity.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const playwrightDir = join(root, 'e2e');
const vitestDir = join(root, 'e2e-vitest');

/** Files allowed to differ beyond the import line, each with the reason a reader should check still holds. */
const allowed = new Map([
  [
    'ai.spec.mts',
    'Vitest takes the per-test timeout as a third argument, gates with test.skipIf, and builds the provider instance through test.extend because provide cannot carry it.',
  ],
]);

const specs = (dir) => readdirSync(dir).filter((name) => name.endsWith('.spec.mts'));
const normalize = (text) =>
  text.replace(
    /^(import .* from ')touchpress\/(playwright|vitest)(';)$/gm,
    '$1touchpress/<runner>$3',
  );

let drift = 0;
const playwrightSpecs = specs(playwrightDir);
const vitestSpecs = new Set(specs(vitestDir));

for (const name of playwrightSpecs) {
  if (!vitestSpecs.has(name)) {
    console.error(`missing: e2e-vitest/${name} has no twin of e2e/${name}`);
    drift += 1;
    continue;
  }
  vitestSpecs.delete(name);
  if (allowed.has(name)) continue;
  const left = normalize(readFileSync(join(playwrightDir, name), 'utf8')).split('\n');
  const right = normalize(readFileSync(join(vitestDir, name), 'utf8')).split('\n');
  const hunk = diff(left, right);
  if (hunk === null) continue;
  console.error(`--- e2e/${name}\n+++ e2e-vitest/${name}\n${hunk}`);
  drift += 1;
}
for (const name of vitestSpecs) {
  console.error(`extra: e2e-vitest/${name} has no twin in e2e/`);
  drift += 1;
}
for (const name of allowed.keys()) {
  if (!playwrightSpecs.includes(name)) {
    console.error(`stale allowlist entry: e2e/${name} no longer exists`);
    drift += 1;
  }
}

if (drift > 0) {
  console.error(`\n${String(drift)} spec(s) drifted between e2e/ and e2e-vitest/.`);
  process.exit(1);
}
console.log(
  `${String(playwrightSpecs.length)} specs in parity, ${String(allowed.size)} allowed to differ.`,
);

/** Null when the two agree, otherwise every line of both with `-`, `+` and ` ` prefixes, from a plain LCS. */
function diff(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let changed = false;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(`+${right[j]}`);
      j += 1;
      changed = true;
    } else {
      lines.push(`-${left[i]}`);
      i += 1;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : null;
}
