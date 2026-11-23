import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // `obsidian` is a runtime-only module (no installable package); point it at a
    // stub so tests importing 'obsidian'-dependent modules can load. esbuild
    // externalizes the real module for the plugin build.
    alias: {
      obsidian: fileURLToPath(new URL('./test/__stubs__/obsidian.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
