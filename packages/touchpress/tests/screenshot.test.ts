import { expect, test } from 'vite-plus/test';
import { PNG } from 'pngjs';
import {
  compareScreenshot,
  cropScreenshot,
  relativeTo,
  sizeOf,
  toPixelBox,
  type PixelBox,
} from '../src/core/screenshot.ts';
import { defaultName, playwrightBaseline } from '../src/playwright/baseline.ts';
import type { TestInfo } from '@playwright/test';

type Colour = readonly [number, number, number];

const WHITE: Colour = [255, 255, 255];
const BLACK: Colour = [0, 0, 0];
const RED: Colour = [255, 0, 0];

const defaults = { threshold: 0.2, maxDiffPixelRatio: 0.01, mask: [] };

function solid(width: number, height: number, colour: Colour): Buffer {
  const image = new PNG({ width, height });
  fill(image, { x: 0, y: 0, width, height }, colour);
  return PNG.sync.write(image);
}

function withPatch(width: number, height: number, box: PixelBox, colour: Colour): Buffer {
  const image = PNG.sync.read(solid(width, height, WHITE));
  fill(image, box, colour);
  return PNG.sync.write(image);
}

function fill(image: PNG, box: PixelBox, [red, green, blue]: Colour): void {
  for (let row = box.y; row < box.y + box.height; row += 1) {
    for (let column = box.x; column < box.x + box.width; column += 1) {
      const at = (image.width * row + column) << 2;
      image.data[at] = red;
      image.data[at + 1] = green;
      image.data[at + 2] = blue;
      image.data[at + 3] = 255;
    }
  }
}

function pixelAt(source: Buffer, x: number, y: number): Colour {
  const image = PNG.sync.read(source);
  const at = (image.width * y + x) << 2;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

test('an image compared with itself matches with nothing different', () => {
  const shot = withPatch(100, 100, { x: 10, y: 10, width: 30, height: 30 }, RED);
  const result = compareScreenshot(shot, shot, defaults);
  expect(result.kind).toBe('match');
  if (result.kind !== 'match') return;
  expect(result.ratio).toBe(0);
});

test('a change smaller than the allowed ratio still matches', () => {
  const before = solid(100, 100, WHITE);
  const after = withPatch(100, 100, { x: 40, y: 40, width: 8, height: 8 }, RED);
  const result = compareScreenshot(before, after, defaults);
  expect(result.kind).toBe('match');
  if (result.kind !== 'match') return;
  expect(result.ratio).toBeGreaterThan(0);
  expect(result.ratio).toBeLessThanOrEqual(0.01);
});

test('a change past the allowed ratio fails and hands back a diff of the same size', () => {
  const before = solid(100, 100, WHITE);
  const after = withPatch(100, 100, { x: 20, y: 20, width: 40, height: 40 }, RED);
  const result = compareScreenshot(before, after, defaults);
  expect(result.kind).toBe('mismatch');
  if (result.kind !== 'mismatch') return;
  expect(result.ratio).toBeGreaterThan(0.1);
  expect(sizeOf(result.diff)).toEqual({ width: 100, height: 100 });
});

test('a mask over the change is what makes the same pair match', () => {
  const before = solid(100, 100, WHITE);
  const after = withPatch(100, 100, { x: 20, y: 20, width: 40, height: 40 }, RED);
  const masked = { ...defaults, mask: [{ x: 20, y: 20, width: 40, height: 40 }] };
  expect(compareScreenshot(before, after, defaults).kind).toBe('mismatch');
  expect(compareScreenshot(before, after, masked).kind).toBe('match');
});

test('a mask painted past the edge of the image is clamped rather than throwing', () => {
  const before = solid(20, 20, WHITE);
  const after = solid(20, 20, BLACK);
  const masked = { ...defaults, mask: [{ x: 0, y: 0, width: 500, height: 500 }] };
  expect(compareScreenshot(before, after, masked).kind).toBe('match');
});

test('a mask lying outside the image paints nothing, so a change at the corner still counts', () => {
  const before = solid(20, 20, WHITE);
  const after = withPatch(20, 20, { x: 0, y: 0, width: 5, height: 5 }, RED);
  const outside = { ...defaults, mask: [{ x: -100, y: -100, width: 5, height: 5 }] };
  expect(compareScreenshot(before, after, outside).kind).toBe('mismatch');
});

test('a mask straddling the edge paints only the part that overlaps the image', () => {
  const before = solid(20, 20, WHITE);
  const straddling = { ...defaults, mask: [{ x: -3, y: -3, width: 6, height: 6 }] };
  const inside = withPatch(20, 20, { x: 0, y: 0, width: 3, height: 3 }, RED);
  const past = withPatch(20, 20, { x: 0, y: 0, width: 5, height: 5 }, RED);
  expect(compareScreenshot(before, inside, straddling).kind).toBe('match');
  expect(compareScreenshot(before, past, straddling).kind).toBe('mismatch');
});

test('images of different sizes report both sizes rather than a ratio', () => {
  const result = compareScreenshot(solid(100, 100, WHITE), solid(100, 90, WHITE), defaults);
  expect(result.kind).toBe('size-mismatch');
  if (result.kind !== 'size-mismatch') return;
  expect(result.expected).toEqual({ width: 100, height: 100 });
  expect(result.actual).toEqual({ width: 100, height: 90 });
});

test('the threshold decides whether a slight shade change counts at all', () => {
  const before = solid(40, 40, [200, 200, 200]);
  const after = solid(40, 40, [196, 196, 196]);
  expect(compareScreenshot(before, after, { ...defaults, threshold: 0.2 }).kind).toBe('match');
  expect(compareScreenshot(before, after, { ...defaults, threshold: 0 }).kind).toBe('mismatch');
});

test('a crop cuts the named region out of the image', () => {
  const shot = withPatch(100, 100, { x: 50, y: 50, width: 20, height: 20 }, RED);
  const cut = cropScreenshot(shot, { x: 50, y: 50, width: 20, height: 20 });
  expect(sizeOf(cut)).toEqual({ width: 20, height: 20 });
  expect(pixelAt(cut, 0, 0)).toEqual(RED);
  expect(pixelAt(cut, 19, 19)).toEqual(RED);
});

test('a crop reaching past the image is clamped to what is there', () => {
  const cut = cropScreenshot(solid(40, 40, WHITE), { x: 30, y: 30, width: 40, height: 40 });
  expect(sizeOf(cut)).toEqual({ width: 10, height: 10 });
});

test('a rect scales into pixels and rounds outward so an edge is never cut off', () => {
  expect(toPixelBox({ x: 24, y: 1540, width: 87.67, height: 43.34 }, 3)).toEqual({
    x: 72,
    y: 4620,
    width: 264,
    height: 131,
  });
  expect(toPixelBox({ x: 63, y: 2217, width: 224, height: 120 }, 1)).toEqual({
    x: 63,
    y: 2217,
    width: 224,
    height: 120,
  });
});

test('a mask moves into the coordinates of the crop it is painted on', () => {
  const box = { x: 120, y: 300, width: 40, height: 20 };
  expect(relativeTo(box, { x: 100, y: 250, width: 200, height: 200 })).toEqual({
    x: 20,
    y: 50,
    width: 40,
    height: 20,
  });
});

test('an unnamed baseline carries its describe path, so two blocks sharing a title do not collide', () => {
  const info = (titlePath: string[]): TestInfo =>
    ({ title: titlePath.at(-1), titlePath }) as unknown as TestInfo;
  const outer = defaultName(info(['file.spec.ts', 'outer', 'shot']));
  const inner = defaultName(info(['file.spec.ts', 'inner', 'shot']));
  expect(outer).toBe('outer-shot-1.png');
  expect(inner).toBe('inner-shot-1.png');
});

test("Playwright's four update modes land on the two axes core reads", () => {
  expect(playwrightBaseline('all')).toEqual({
    onMissing: 'write-and-pass',
    onMismatch: 'overwrite-and-pass',
  });
  expect(playwrightBaseline('changed')).toEqual({
    onMissing: 'write-and-fail',
    onMismatch: 'overwrite-and-pass',
  });
  expect(playwrightBaseline('missing')).toEqual({
    onMissing: 'write-and-pass',
    onMismatch: 'fail',
  });
  expect(playwrightBaseline('none')).toEqual({ onMissing: 'write-and-fail', onMismatch: 'fail' });
});
