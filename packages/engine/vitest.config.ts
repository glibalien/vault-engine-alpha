import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/perf/**',
      // Real-model tests run through `npm run test:model` and fail closed when prerequisites are missing.
      'tests/**/*.model.test.ts',
      // Git worktrees live under .claude/worktrees/; without this, a root
      // `vitest run` discovers their nested test copies (double-running the
      // suite and slipping the excluded perf tests past `tests/perf/**`).
      '**/.claude/**',
    ],
  },
});
