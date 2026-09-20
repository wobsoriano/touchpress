import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Structurally Playwright's `Location`, without pulling its types into this module. */
export type SourceLocation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
};

const POSITION = /^(.+):(\d+):(\d+)$/;
const FRAME_PREFIX = /^(?:async|new)\s+/;

/**
 * The first frame in `stack` that belongs to whoever called touchpress, which is
 * the line a report should point at. Frames inside `packageDir`, inside any
 * `node_modules`, and Node's own internals are machinery the reader did not
 * write. Returns `undefined` when the stack is nothing but machinery.
 *
 * Pure and separate from `callerLocation` so it can be tested against stacks no
 * test could produce for real.
 */
export function pickCallerFrame(stack: string, packageDir: string): SourceLocation | undefined {
  for (const line of stack.split('\n')) {
    const frame = parseFrame(line);
    if (frame === undefined) continue;
    // The trailing separator keeps a sibling such as `touchpress-other` out of the prefix match.
    if (frame.file.startsWith(packageDir + sep)) continue;
    if (frame.file.split(/[\\/]/).includes('node_modules')) continue;
    return frame;
  }
  return undefined;
}

/**
 * Handles both shapes V8 writes, `at name (/file:1:2)` and a bare `at /file:1:2`,
 * and reads the path off the parentheses rather than off whitespace so a
 * directory with a space in its name still parses.
 */
function parseFrame(line: string): SourceLocation | undefined {
  const text = line.trim();
  if (!text.startsWith('at ')) return undefined;
  const rest = text.slice('at '.length).trim();
  const open = rest.lastIndexOf('(');
  const target =
    open !== -1 && rest.endsWith(')') ? rest.slice(open + 1, -1) : rest.replace(FRAME_PREFIX, '');

  const position = POSITION.exec(target);
  if (position === null) return undefined;
  const [, file, lineNumber, column] = position;
  if (file === undefined || lineNumber === undefined || column === undefined) return undefined;
  if (file.startsWith('node:')) return undefined;
  return {
    file: file.startsWith('file://') ? fileURLToPath(file) : file,
    line: Number(lineNumber),
    column: Number(column),
  };
}

/**
 * Where touchpress's own frames live, resolved once at load. Walking up to a
 * `package.json` covers the built bundles, which sit in `dist` and have no
 * `package.json` of their own, and this file under `src` when the unit tests run
 * it. Matching on the name `touchpress` would not, because the repository
 * directory is called that too and the specs under it are what we are looking
 * for.
 */
function nearestPackageDir(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const PACKAGE_DIR = nearestPackageDir(dirname(fileURLToPath(import.meta.url)));

/** The spec line that reached touchpress, for a report entry to point at. */
export function callerLocation(): SourceLocation | undefined {
  const limit = Error.stackTraceLimit;
  // A device command passes through several touchpress frames on the way here, so the default of
  // 10 can run out before the spec frame.
  Error.stackTraceLimit = 50;
  try {
    const { stack } = new Error();
    return stack === undefined ? undefined : pickCallerFrame(stack, PACKAGE_DIR);
  } finally {
    Error.stackTraceLimit = limit;
  }
}
