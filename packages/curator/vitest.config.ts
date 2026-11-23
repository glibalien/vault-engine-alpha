import { defineConfig } from 'vitest/config';

// Pin test discovery to the TypeScript sources under test/. Without this,
// vitest's default glob also matches compiled `dist/test/*.test.js` left by a
// stray `tsc` emit, running every suite twice (and risking stale assertions).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
