import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionSink, EvidenceFile } from '../core/report.ts';
import { testOutputDir, type TestIdentity } from './paths.ts';

export type Attachment =
  | { readonly path: string; readonly contentType: string }
  | { readonly body: string; readonly contentType: string };

/** The one member of Vitest's test context the sink uses. Structural, so a fake in the unit suite is one line. */
export type AnnotatingContext = {
  annotate(message: string, type: string, attachment?: Attachment): Promise<unknown>;
};

/** One line of the action trail. `depth` is nesting, so `clearState` shows its relaunch one level in. */
export type TrailLine = {
  readonly depth: number;
  readonly title: string;
  readonly outcome: 'ok' | 'threw';
  readonly durationMs: number;
};

export type VitestSink = ActionSink & {
  /** The action trail as text, or null when nothing ran. Attached as `steps.txt` when a test ends unexpectedly. */
  trail(): string | null;
  /** Awaits every annotation `note` fired. `note` is synchronous by contract and `annotate` is not. */
  settle(): Promise<void>;
};

/**
 * `ActionSink` over Vitest's test context.
 *
 * `step` is buffered rather than annotated live. Vitest's default reporter
 * prints annotations for passing tests too, so a forty-action test would print
 * forty lines on green. The trail is attached once, under the failure, which
 * is where Playwright's step tree effectively lands as well. `{ box: true }`
 * is ignored because every trail entry is already one line.
 *
 * `attach` and `note` are `annotate` calls. A `{ path }` attachment is copied
 * into Vitest's attachments directory, a `{ body }` one stays inline. Both only
 * work while the test body runs, which is why a failing step reports through
 * `onFailure` at once instead of leaving it to a teardown.
 */
export function createVitestSink(input: {
  readonly context: AnnotatingContext;
  readonly test: TestIdentity;
  readonly outputDir: string;
  /** Runs when a top-level step rejects, while the body is still running. Unset means nothing to do. */
  readonly onFailure?: () => Promise<void>;
}): VitestSink {
  const { context, test, outputDir, onFailure } = input;
  const lines: TrailLine[] = [];
  const pending: Promise<unknown>[] = [];
  let depth = 0;
  let dir: string | null = null;

  return {
    step: async (title, body) => {
      const at = depth;
      const index = lines.push({ depth: at, title, outcome: 'ok', durationMs: 0 }) - 1;
      const started = Date.now();
      const finish = (outcome: TrailLine['outcome']): void => {
        lines[index] = { depth: at, title, outcome, durationMs: Date.now() - started };
      };
      depth += 1;
      try {
        const result = await body();
        finish('ok');
        return result;
      } catch (error) {
        finish('threw');
        if (at === 0) await onFailure?.();
        throw error;
      } finally {
        depth -= 1;
      }
    },
    attach: async (file: EvidenceFile) => {
      await context.annotate(
        file.name,
        'attachment',
        'path' in file
          ? { path: file.path, contentType: file.contentType }
          : { body: file.body, contentType: file.contentType },
      );
    },
    note: (key, value) => {
      pending.push(context.annotate(value, key));
    },
    outputPath: (fileName) => {
      if (dir === null) {
        dir = testOutputDir(outputDir, test);
        mkdirSync(dir, { recursive: true });
      }
      return join(dir, fileName);
    },
    trail: () => (lines.length === 0 ? null : renderTrail(lines)),
    settle: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

export function renderTrail(lines: readonly TrailLine[]): string {
  return lines
    .map(
      (line) =>
        `${'  '.repeat(line.depth)}${line.title}${line.outcome === 'threw' ? ' (threw)' : ''}  ${String(line.durationMs)}ms`,
    )
    .join('\n');
}
