import { defineConfig } from 'vitest/config';

// Test files live under src/ next to the source they cover. `tsc -p
// tsconfig.json` (the build script, no --noEmit) compiles them into
// dist/*.test.js like any other src file. Without this exclude, vitest's
// default glob picks up both the src/*.test.ts source and the compiled
// dist/*.test.js, running every suite twice.
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**'] } });
