import { basename, dirname, extname, join, resolve } from 'node:path';

/** Just enough of Vitest's `Test` to name a file and a test. Structural, so no runner type crosses this module. */
export type TestIdentity = {
  readonly filepath: string;
  /** `task.file.projectName`, or `''` for an unnamed project, which adds no suffix. */
  readonly projectName: string;
  /** Describe blocks outermost first, then the test name. */
  readonly titlePath: readonly string[];
  /** `task.result.retryCount`, so a retry never writes over the first attempt's evidence. */
  readonly retry: number;
};

/**
 * `<outputDir>/<spec>-<title>[-<project>][-retry<N>]`, the shape of Playwright's
 * own `outputPath` directory, so a results tree reads the same under either
 * runner. Nothing is created here. The sink creates it on first use.
 */
export function testOutputDir(outputDir: string, test: TestIdentity): string {
  const parts = [specSlug(test.filepath), ...test.titlePath.map(slug)];
  if (test.projectName !== '') parts.push(slug(test.projectName));
  if (test.retry > 0) parts.push(`retry${String(test.retry)}`);
  return resolve(outputDir, parts.join('-'));
}

/**
 * `<dir of spec>/<spec file>-snapshots/<name>-<project>-<platform>.png`,
 * byte-identical to Playwright's default `snapshotPathTemplate`, so one
 * committed baseline tree serves both runners when the project names match.
 * `<platform>` is `process.platform`, the way Playwright's suffix is. Which
 * mobile platform ran is the project name's job, as in the Playwright config.
 */
export function baselinePath(name: string, test: TestIdentity): string {
  const extension = extname(name) === '' ? '.png' : extname(name);
  const stem = name.slice(0, name.length - extname(name).length);
  const suffix = test.projectName === '' ? '' : `-${test.projectName}`;
  return join(
    dirname(test.filepath),
    `${basename(test.filepath)}-snapshots`,
    `${stem}${suffix}-${process.platform}${extension}`,
  );
}

/** The describe path and an ordinal, for `toHaveScreenshot()` with no name. Same rule as the Playwright adapter. */
export function defaultName(test: TestIdentity, ordinal: number): string {
  return `${slug(test.titlePath.join(' '))}-${String(ordinal)}.png`;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function specSlug(filepath: string): string {
  return slug(basename(filepath).replace(/\.(spec|test)\.[cm]?[jt]sx?$/, ''));
}
