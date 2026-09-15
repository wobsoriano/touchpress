import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: { singleQuote: true, semi: true },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  run: {
    cache: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Playwright specs live in e2e/ and tests/playwright-adapter/ and are run by
          // `playwright test`, not vitest. The Vitest adapter harness has its own project.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/e2e/**',
            '**/tests/playwright-adapter/**',
            '**/tests/vitest-adapter/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'vitest-adapter',
          include: ['packages/touchpress/tests/vitest-adapter/*.test.ts'],
          // One fake device per worker, and a worker whose module registry survives the file
          // boundary, which is how a real device project runs and what the harness proves.
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          // Vitest runs projects with different worker counts in separate groups.
          sequence: { groupOrder: 1 },
          retry: 1,
          attachmentsDir: join(tmpdir(), 'touchpress-vitest-attachments'),
        },
      },
    ],
  },
});
