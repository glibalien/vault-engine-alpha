/** @type {import('dependency-cruiser').IConfiguration} */

// Dependency-direction guard for the Vault Engine monorepo.
//
// Three refinements over the original plan's config, each forced by the real
// environment (verified: a realistic engine cross-client import trips
// `engine-no-client-imports`, and the baseline is clean):
//
//  1. depcruise >= 17 (see package.json). The suite is on typescript@6, which
//     dependency-cruiser 16 does NOT support (`>=2.0.0 <6.0.0`) — it silently
//     parses no `.ts` and cruises only the built `dist/` JS. v17 supports TS6.
//  2. `tsConfig: tsconfig.depcruise.json` — a resolution-only config whose
//     `include` spans EVERY package. depcruise only does the ESM `.js`->`.ts`
//     swap for files inside its tsConfig program; the engine's own tsconfig
//     stops at the engine, so a cross-package `.js` import came back
//     `couldNotResolve` and a `to.path` rule (which matches only RESOLVED deps)
//     missed it. The spanning program lets cross-package imports resolve to a
//     real `packages/<pkg>/...` path the rules can see.
//  3. `exclude: dist|docs` — lint SOURCE, not the built `.js` in dist/ or the
//     design `.jsx` under docs/.

module.exports = {
  forbidden: [
    {
      name: 'engine-no-client-imports',
      comment: 'Engine must never import deployable clients; surfaces communicate over MCP.',
      severity: 'error',
      from: { path: '^packages/engine/' },
      to: { path: '^packages/(curator|obsidian-plugin)/' },
    },
    {
      name: 'curator-no-engine-imports',
      comment: 'Curator communicates over MCP and must not import another deployable surface.',
      severity: 'error',
      from: { path: '^packages/curator/' },
      to: { path: '^packages/(engine|obsidian-plugin)/' },
    },
    {
      name: 'contract-is-leaf',
      comment: '@vault/contract must not depend on any other workspace package.',
      severity: 'error',
      from: { path: '^packages/contract/' },
      to: { path: '^packages/(?!contract(?:/|$))' },
    },
    {
      name: 'pricing-is-leaf',
      comment: '@vault/pricing is the shared zero-dep rate table. It must not depend on any other workspace package.',
      severity: 'error',
      from: { path: '^packages/pricing/' },
      to: { path: '^packages/(?!pricing(?:/|$))' },
    },
    {
      name: 'settings-registry-is-leaf',
      comment: '@vault/settings-registry must not depend on any other workspace package.',
      severity: 'error',
      from: { path: '^packages/settings-registry/' },
      to: { path: '^packages/(?!settings-registry(?:/|$))' },
    },
    {
      name: 'llm-is-shared-server-library',
      comment: '@vault/llm is the shared provider-client library for the Node services (Engine and Curator). It may depend on @vault/settings-registry and @vault/pricing only.',
      severity: 'error',
      from: { path: '^packages/llm/' },
      to: { path: '^packages/(?!(?:llm|settings-registry|pricing)(?:/|$))' },
    },
    {
      name: 'obsidian-plugin-is-standalone-client',
      comment: 'The Obsidian plugin (VEfO) must not import from engine/curator. It is a standalone client that consumes @vault/query-core + @vault/viz-ui (Phase 3 shared packages). Clients depend on the engine, never on each other.',
      severity: 'error',
      from: { path: '^packages/obsidian-plugin/' },
      to: { path: '^packages/(engine|curator)/' },
    },
    {
      name: 'chat-core-is-shared-leaf',
      comment: '@vault/chat-core is a shared, host-agnostic package. It must not depend on any other workspace package (engine, curator, or the plugin).',
      severity: 'error',
      from: { path: '^packages/chat-core/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin)/' },
    },
    {
      name: 'query-core-is-shared-leaf',
      comment: '@vault/query-core is a shared, host-agnostic package. It must not depend on any other workspace package (engine, curator, the plugin, or contract).',
      severity: 'error',
      from: { path: '^packages/query-core/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin|contract)/' },
    },
    {
      name: 'viz-ui-is-shared',
      comment: '@vault/viz-ui is a shared, host-agnostic UI package. It may depend on @vault/query-core + react, but not on the engine, curator, the plugin, or contract.',
      severity: 'error',
      from: { path: '^packages/viz-ui/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin|contract)/' },
    },
    {
      name: 'board-core-is-shared',
      comment: '@vault/board-core is a shared, host-agnostic board logic package. It may depend on @vault/viz-ui (type-only VizSpec) + @modelcontextprotocol/sdk, but not on the engine, curator, the plugin, or contract.',
      severity: 'error',
      from: { path: '^packages/board-core/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin|contract)/' },
    },
    {
      name: 'conversation-core-is-shared',
      comment: '@vault/conversation-core is a shared, host-agnostic conversation client package. It may depend on @modelcontextprotocol/sdk, but not on the engine, curator, the plugin, or contract.',
      severity: 'error',
      from: { path: '^packages/conversation-core/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin|contract)/' },
    },
    {
      name: 'chat-ui-is-shared',
      comment: '@vault/chat-ui is a shared, host-agnostic UI package. It may depend on @vault/contract + react + react-markdown, but not on the engine, curator, the plugin, viz-ui, query-core, or chat-core.',
      severity: 'error',
      from: { path: '^packages/chat-ui/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin|viz-ui|query-core|chat-core)/' },
    },
    {
      name: 'installer-uses-shared-contracts-only',
      comment: 'The installer orchestrates Engine and Curator through their CLIs, MCP, env files, and service units. It may import only the zero-dependency shared contracts, never a deployable surface.',
      severity: 'error',
      from: { path: '^packages/installer/' },
      to: { path: '^packages/(?!(?:installer|settings-registry|contract|pricing)(?:/|$))' },
    },
    {
      name: 'nothing-imports-installer',
      severity: 'error',
      comment: 'The installer is an operator tool; no package may depend on it.',
      from: { path: '^packages/(?!installer/)' },
      to: { path: '^packages/installer/' },
    },
    {
      name: 'nothing-imports-bench',
      severity: 'error',
      comment: 'bench is a standalone measurement tool; no package may depend on it',
      from: { path: '^packages/(?!bench/)' },
      to: { path: '^packages/bench/' },
    },
    {
      name: 'bench-is-standalone-tool',
      severity: 'error',
      comment: 'bench talks to the engine only over MCP subprocess, never by import',
      from: { path: '^packages/bench/' },
      to: { path: '^packages/(engine|curator|obsidian-plugin)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Cruise TypeScript SOURCE only. Without this, depcruise also scans the
    // built `dist/` JS (where cross-package imports are plain `.js`->`.js`) and
    // the design `.jsx` under docs/, masking the real src-level import graph.
    exclude: { path: '(^|/)(dist|docs|node_modules)/|^packages/obsidian-plugin/main\\.js$' },
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types'] },
  },
};
