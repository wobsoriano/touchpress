import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Device, Locator } from './device.ts';
import type { ProbeResult } from './probe.ts';
import type { Query } from './query.ts';
import type { ActionSink } from './report.ts';
import { resolve, type Screen } from './screen.ts';
import {
  compareScreenshot,
  cropScreenshot,
  relativeTo,
  sizeOf,
  toPixelBox,
  type Comparison,
  type PixelBox,
} from './screenshot.ts';
import { sleep } from './session.ts';

const POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.01;
const DEFAULT_THRESHOLD = 0.2;

export type ScreenshotOptions = {
  timeout?: number;
  /** The share of the image allowed to differ. @default 0.01 */
  maxDiffPixelRatio?: number;
  /** pixelmatch's per-pixel colour distance, 0 to 1. Smaller is stricter. @default 0.2 */
  threshold?: number;
  /** Painted opaque black in both images, for anything that legitimately changes between runs. */
  mask?: Locator[];
};

/**
 * What to do the first time an assertion runs against a name with no committed
 * PNG. The question is whether a file the run just invented may turn the run
 * green, and whether the tree is touched at all.
 *
 * - `write-and-pass` writes the baseline and passes. The "record it" mode.
 * - `write-and-fail` writes the baseline and fails at once, so the author
 *   reviews and commits it before a second run can go green.
 * - `fail` leaves the tree alone and attaches the capture as evidence, for a
 *   runner whose CI mode must not write.
 */
export type MissingBaselineRule = 'write-and-pass' | 'write-and-fail' | 'fail';

/**
 * What to do when a baseline exists and the capture disagrees with it.
 *
 * - `overwrite-and-pass` accepts the new pixels as the truth. The "update" mode.
 * - `fail` keeps capturing until the deadline, then fails with expected, actual
 *   and diff attached.
 */
export type MismatchRule = 'overwrite-and-pass' | 'fail';

/**
 * A runner's snapshot setting as two independent axes. Playwright's four modes
 * and Vitest's three are seven points in the same space, and the loop reads
 * the axes rather than the mode, so core never learns which runner it serves.
 */
export type BaselinePolicy = {
  readonly onMissing: MissingBaselineRule;
  readonly onMismatch: MismatchRule;
};

export type ScreenshotRequest = {
  /** A locator is cropped out of the device's own capture, so image and rects share one snapshot. */
  readonly target: Device | Locator;
  /** The resolved path of the committed PNG. The adapter names it, so core mints nothing. */
  readonly baseline: string;
  readonly options: ScreenshotOptions;
  /** True when the caller wrote `.not`. */
  readonly negate: boolean;
  readonly timeoutMs: number;
  readonly policy: BaselinePolicy;
  readonly sink: ActionSink;
};

/** A locator that is not on screen yet is retried, the way every other matcher retries. */
type Attempt =
  | { readonly kind: 'unresolved'; readonly detail: string }
  | { readonly kind: 'captured'; readonly png: Buffer; readonly mask: readonly PixelBox[] };

/**
 * Returns the `ProbeResult` every other matcher returns, so an adapter has one
 * mapping to its runner's matcher result for all eight. Never throws for a
 * failed expectation. A broken session still throws, the way `probe` does.
 *
 * A locator's crop and every mask are resolved off one snapshot taken next to
 * the image. Rects from two snapshots would index into the image at two
 * different scroll positions, which crops the wrong thing rather than failing.
 */
export async function assertScreenshot(request: ScreenshotRequest): Promise<ProbeResult> {
  const { target, baseline, options, negate, policy, sink } = request;
  const timeout = request.timeoutMs;
  const maxDiffPixelRatio = options.maxDiffPixelRatio ?? DEFAULT_MAX_DIFF_PIXEL_RATIO;
  const expected = `${negate ? 'not ' : ''}at most ${percent(maxDiffPixelRatio)} of pixels to differ`;
  const label = 'query' in target ? target.description : 'the whole device';
  const deadline = Date.now() + timeout;

  let captures = 0;
  let attempt = await capture(target, sink, options.mask ?? []);
  for (;;) {
    captures += 1;
    if (attempt.kind === 'captured') {
      if (!existsSync(baseline)) {
        return missingBaseline({
          expected,
          label,
          baseline,
          negate,
          rule: policy.onMissing,
          png: attempt.png,
          sink,
        });
      }
      const comparison = compareScreenshot(readFileSync(baseline), attempt.png, {
        threshold: options.threshold ?? DEFAULT_THRESHOLD,
        maxDiffPixelRatio,
        mask: attempt.mask,
      });
      const matched = comparison.kind === 'match';
      if (matched !== negate) {
        return { pass: matched, expected, actual: received(comparison), message: '' };
      }
      if (!negate && policy.onMismatch === 'overwrite-and-pass') {
        write(baseline, attempt.png);
        return { pass: true, expected, actual: received(comparison), message: '' };
      }
      if (Date.now() >= deadline) {
        await attachAll(sink, baseline, attempt.png, comparison);
        return fail(negate, expected, received(comparison), [
          `Expected ${negate ? 'not.' : ''}toHaveScreenshot but it never ${negate ? 'differed' : 'matched'}.`,
          ``,
          `Target: ${label}`,
          `Baseline: ${baseline}`,
          `Expected: ${expected}`,
          `Received: ${received(comparison)}`,
          timeoutLine(timeout, captures),
          ``,
          `expected.png, actual.png and diff.png are attached to this test in the HTML report.`,
        ]);
      }
    } else if (Date.now() >= deadline) {
      return fail(negate, expected, null, [
        `Expected ${negate ? 'not.' : ''}toHaveScreenshot but the locator never resolved.`,
        ``,
        `Target: ${label}`,
        `Received: ${attempt.detail}`,
        timeoutLine(timeout, captures),
      ]);
    }
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    attempt = await capture(target, sink, options.mask ?? []);
  }
}

/**
 * The scale is derived rather than asked for. A tree reports rects in whatever
 * units its platform uses, so the image width over the widest rect on screen,
 * which is the window, is what one unit is worth in pixels. It comes out at 1 on
 * both devices this is tested against, because agent-device writes the iOS
 * simulator's image at point resolution and the Android tree already reports
 * pixels. Deriving it keeps a device writing a 2x or 3x image from cropping the
 * wrong region.
 */
async function capture(
  target: Device | Locator,
  sink: ActionSink,
  masks: readonly Locator[],
): Promise<Attempt> {
  const device = 'query' in target ? target.device : target;
  const screen = await device.screen();
  const path = await device.screenshot({ path: sink.outputPath('toHaveScreenshot-actual.png') });
  const full = readFileSync(path);
  const scale = scaleOf(screen, sizeOf(full).width);

  const region = 'query' in target ? regionOf(screen, target.query, scale) : null;
  if (typeof region === 'string') return { kind: 'unresolved', detail: region };

  const boxes = masks.flatMap((mask) => boxesOf(screen, mask.query, scale));
  if (region === null) return { kind: 'captured', png: full, mask: boxes };
  return {
    kind: 'captured',
    png: cropScreenshot(full, region),
    mask: boxes.map((box) => relativeTo(box, region)),
  };
}

/** The crop for a locator, or why it could not be taken. */
function regionOf(screen: Screen, query: Query, scale: number): PixelBox | string {
  const resolution = resolve(screen, query);
  switch (resolution.outcome) {
    case 'none':
      return 'no node matched';
    case 'many':
      return `${String(resolution.nodes.length)} nodes matched, which is ambiguous. Narrow the locator or use .first() / .nth(n).`;
    case 'one': {
      const rect = resolution.node.rect;
      if (rect === null)
        return `${resolution.node.ref} reports no rect, so there is nothing to crop`;
      return toPixelBox(rect, scale);
    }
    default: {
      const never: never = resolution;
      throw new Error(`unhandled resolution ${JSON.stringify(never)}`);
    }
  }
}

/** A mask hides a region rather than picking one node, so ambiguity is not an error here. */
function boxesOf(screen: Screen, query: Query, scale: number): PixelBox[] {
  const resolution = resolve(screen, query);
  const nodes =
    resolution.outcome === 'one'
      ? [resolution.node]
      : resolution.outcome === 'many'
        ? resolution.nodes
        : [];
  return nodes.flatMap((node) => (node.rect === null ? [] : [toPixelBox(node.rect, scale)]));
}

function scaleOf(screen: Screen, imageWidth: number): number {
  const widest = Math.max(0, ...screen.nodes.map((node) => node.rect?.width ?? 0));
  return widest > 0 ? imageWidth / widest : 1;
}

async function missingBaseline(input: {
  readonly expected: string;
  readonly label: string;
  readonly baseline: string;
  readonly negate: boolean;
  readonly rule: MissingBaselineRule;
  readonly png: Buffer;
  readonly sink: ActionSink;
}): Promise<ProbeResult> {
  const { expected, baseline, negate, rule, png, sink } = input;
  if (negate) {
    return fail(negate, expected, null, [
      `Expected not.toHaveScreenshot, but there is no baseline to differ from.`,
      ``,
      `Target: ${input.label}`,
      `Baseline: ${baseline}`,
      ``,
      `Write one with a passing toHaveScreenshot first.`,
    ]);
  }
  switch (rule) {
    case 'write-and-pass':
      write(baseline, png);
      return { pass: true, expected, actual: null, message: '' };
    case 'write-and-fail':
      write(baseline, png);
      return fail(negate, expected, null, [
        `A snapshot doesn't exist at ${baseline}, writing actual.`,
      ]);
    case 'fail': {
      const actualPath = sink.outputPath('actual.png');
      writeFileSync(actualPath, png);
      await sink.attach({ name: 'actual.png', path: actualPath, contentType: 'image/png' });
      return fail(negate, expected, null, [
        `A snapshot doesn't exist at ${baseline}, and this run may not write one.`,
        ``,
        `actual.png is attached to this test. Run in a mode that writes baselines, then commit the file.`,
      ]);
    }
    default: {
      const never: never = rule;
      throw new Error(`unhandled missing baseline rule ${JSON.stringify(never)}`);
    }
  }
}

async function attachAll(
  sink: ActionSink,
  baseline: string,
  actual: Buffer,
  comparison: Comparison,
): Promise<void> {
  await sink.attach({ name: 'expected.png', path: baseline, contentType: 'image/png' });
  const actualPath = sink.outputPath('actual.png');
  writeFileSync(actualPath, actual);
  await sink.attach({ name: 'actual.png', path: actualPath, contentType: 'image/png' });
  if (comparison.kind !== 'mismatch') return;
  const diffPath = sink.outputPath('diff.png');
  writeFileSync(diffPath, comparison.diff);
  await sink.attach({ name: 'diff.png', path: diffPath, contentType: 'image/png' });
}

function received(comparison: Comparison): string {
  switch (comparison.kind) {
    case 'match':
    case 'mismatch':
      return `${percent(comparison.ratio)} of pixels differ`;
    case 'size-mismatch':
      return `the screenshot is ${size(comparison.actual)} and the baseline is ${size(comparison.expected)}`;
    default: {
      const never: never = comparison;
      throw new Error(`unhandled comparison ${JSON.stringify(never)}`);
    }
  }
}

function size(value: { readonly width: number; readonly height: number }): string {
  return `${String(value.width)}x${String(value.height)}`;
}

function percent(ratio: number): string {
  const shown = ratio * 100;
  return `${shown < 0.1 && shown > 0 ? shown.toFixed(3) : String(Math.round(shown * 100) / 100)}%`;
}

function timeoutLine(timeout: number, captures: number): string {
  return `Timeout: ${String(timeout)}ms (${String(captures)} capture${captures === 1 ? '' : 's'})`;
}

/** The value that fails the assertion whether or not the caller wrote `.not`, the way `probe` reports one. */
function fail(
  negate: boolean,
  expected: string,
  actual: string | null,
  lines: readonly string[],
): ProbeResult {
  return { pass: negate, expected, actual, message: lines.join('\n') };
}

function write(path: string, png: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
}
