import { defineConfig } from 'vitest/config';

// Pin discovery to the TypeScript tests so a stray `tsc` emit into dist/ is never
// collected as a second copy of the suite.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
