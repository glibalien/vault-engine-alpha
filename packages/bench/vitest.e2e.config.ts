import { defineConfig } from 'vitest/config';

// The e2e suite is deliberately NOT part of `npm test`: it spawns real engine
// subprocesses and requires packages/engine/dist to be built. Root `npm test`
// runs `--workspaces --if-present test`, so only a script literally named
// `test` is swept — this config is reached solely through `test:e2e`.
//
// Timeouts are generous because a single test boots the engine twice (once to
// seed the corpus DB, once for the sandbox), each running every migration plus
// a full index.
export default defineConfig({
  test: {
    include: ['test-e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
