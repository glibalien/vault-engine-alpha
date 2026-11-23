// vite.ui.config.ts
//
// Dedicated Vite config used only by `npm run build:ui` to produce the
// self-contained HTML bundle for the query-nodes MCP App UI. The MCP server
// itself does NOT use Vite; this config exists only to bundle the iframe.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

const isDev = process.env.NODE_ENV === "development";
const uiRoot = fileURLToPath(new URL("./src/mcp/ui/query-nodes", import.meta.url));
const uiEntry = fileURLToPath(new URL("./src/mcp/ui/query-nodes/index.html", import.meta.url));
const uiOutDir = fileURLToPath(new URL("./dist/mcp/ui/query-nodes", import.meta.url));

export default defineConfig({
  // Treat the UI source dir as Vite's project root so module resolution
  // and the input filename stay simple (just "index.html").
  root: uiRoot,
  // Vite's tsconfig discovery finds packages/engine/tsconfig.json (no `jsx`
  // field), not tsconfig.ui.json — without this override esbuild compiles JSX
  // classic-mode and the bundle crashes at render with "React is not defined".
  esbuild: { jsx: "automatic" },
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDev ? "inline" : undefined,
    cssMinify: !isDev,
    minify: !isDev,
    rollupOptions: { input: uiEntry },
    // Relative to `root`. Lands at <repo>/packages/engine/dist/mcp/ui/query-nodes/index.html.
    outDir: uiOutDir,
    emptyOutDir: false,
  },
});
