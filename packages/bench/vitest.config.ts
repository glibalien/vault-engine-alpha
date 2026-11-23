import { defineConfig } from 'vitest/config';

// Test files live under src/ next to the source they cover, matching the
// house pattern in @vault/contract's vitest.config.ts. bench has no "build"
// script today (its CLI runs via tsx, no dist/ needed for normal use), but a
// manual `tsc -p tsconfig.json` (no --noEmit) would still emit dist/*.test.js
// per tsconfig.json's outDir. The explicit dist exclude keeps that scenario
// from double-collecting suites, same bug Task 1 hit in @vault/contract.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
