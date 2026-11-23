import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyzerRunner, DiscoverReport } from '../src/analyzer.js';
import type { EngineCall } from '../src/engine-client.js';
import type { CheckResult } from '../src/preflight.js';
import type { InstallState } from '../src/state.js';
import { verifyInstall, type VerifyDeps } from '../src/verify.js';
import { fakeEngineTools, realFilesystemHost, removeTrees } from './helpers.js';

afterEach(removeTrees);

const PLAN = {
  data_dir: '/data',
  repo_root: '/repo',
  services: { user: 'tester', node_path: '/opt/node', engine_port: 3334, curator_port: 3335 },
  vault: { path: '/notes', analyzer_exclusions: ['Settings'] },
  structure: { types: [{ name: 'project' }, { name: 'note' }] },
  providers: [{ provider: 'anthropic' }],
  models: {
    vision_provider: 'off',
    roles: [
      { setting: 'curator.model', model: 'Claude Sonnet 4.6', off: null },
      { setting: 'curator.wikiPageModel', model: null, off: null },
      { setting: 'engine.memoryConsolidationModel', model: 'GLM 5.2', off: null },
      { setting: 'engine.visionModel', model: null, off: 'image vision is off' },
    ],
    models: [],
  },
  curator: { daily_budget_cents: 100, sweep_at: '05:00', tz: 'UTC', wiki_mode: 'live' },
} as unknown as InstallState['plan'];

/** An Engine that installed the plan: its types, Curator's model, and two notes. */
function engine() {
  const tools = fakeEngineTools([{ file_path: 'A.md' }, { file_path: 'B.md' }, { file_path: 'Settings/Engine.md' }]);
  tools.schemas.set('project', { default_directory: null, claims: [] });
  tools.schemas.set('note', { default_directory: null, claims: [] });
  tools.settings.set('curator', { model: '[[Claude Sonnet 4.6]]' });
  tools.settings.set('engine', { memoryConsolidationModel: '[[GLM 5.2]]' });
  tools.catalog.push({ title: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', enabled: true });
  return tools;
}

function deps(
  tools: ReturnType<typeof engine>,
  input: { markdown?: number; answering?: boolean; curator?: unknown; curatorEnv?: string } = {},
): VerifyDeps {
  const analyzer: AnalyzerRunner = {
    discover: async () => ({ inventory: { markdown_files: input.markdown ?? 2 } }) as unknown as DiscoverReport,
    analyze: async () => { throw new Error('not used'); },
  };
  const curator = input.curator ?? { daily_budget: { cap_usd: 1 }, server: { next_sweep_at: '2026-10-27T05:00:00.000Z', wiki_reconciliation_mode: 'live' } };
  return {
    host: realFilesystemHost({
      httpStatus: async () => (input.answering ?? true) ? 200 : 0,
      run: async () => ({ code: 0, stdout: `Authorization: Bearer ${'d'.repeat(64)}`, stderr: '' }),
      readText: async path => path === '/data/curator.env' ? input.curatorEnv ?? 'ENGINE_TOKEN=x\nANTHROPIC_API_KEY=sk-ant\n' : null,
    }),
    analyzer,
    engine: async () => tools.call,
    connectCurator: () => (async (tool: string) => tool === 'curator-status' ? curator : { ok: true }) as unknown as EngineCall,
  };
}

const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map(entry => [entry.id, [entry.status, entry.detail]]));

describe('verifyInstall', () => {
  it('passes a healthy installation, listing roles that are off', async () => {
    const checks = await verifyInstall(deps(engine()), PLAN);

    expect(checks.map(entry => entry.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(byId(checks)).toMatchObject({
      notes: ['pass', 'all 2 Markdown files in scope'],
      models: ['pass', '2 model settings resolve to enabled, priced models with keys; off: engine.visionModel'],
      curator: ['pass', 'next sweep 2026-10-27T05:00:00.000Z; daily cap $1.00; wiki mode live'],
    });
  });

  it('stops at Engine when it does not answer', async () => {
    expect(await verifyInstall(deps(engine(), { answering: false }), PLAN)).toEqual([
      { id: 'engine', status: 'fail', title: 'Engine', detail: 'does not answer at http://localhost:3334/mcp; is vault-engine.service running?' },
    ]);
  });

  it('fails a missing type, a model setting that does not resolve, and a broken database', async () => {
    const tools = engine();
    tools.schemas.delete('note');
    tools.settings.set('curator', { model: '[[Kimi K2.6]]' });
    const call = tools.call;
    tools.call = async (tool, args, options) => tool === 'vault-doctor'
      ? { integrity: { ok: false, messages: ['row 3 missing from index'] } } as never
      : call(tool, args, options);

    const checks = byId(await verifyInstall(deps(tools), PLAN));

    expect(checks.types).toEqual(['fail', 'Engine lacks note']);
    expect(checks.models).toEqual(['fail', 'curator.model is "[[Kimi K2.6]]", not [[Claude Sonnet 4.6]]']);
    expect(checks.doctor).toEqual(['fail', 'the integrity check failed: row 3 missing from index']);
  });

  it('fails a model whose provider has no key where its caller reads keys', async () => {
    // Engine says it has no OpenRouter key; curator.env has no Anthropic key.
    const tools = engine();
    tools.engineKeys.openrouter = false;

    const checks = byId(await verifyInstall(deps(tools, { curatorEnv: 'ENGINE_TOKEN=x\nANTHROPIC_API_KEY=\n' }), PLAN));

    expect(checks.models).toEqual(['fail', 'curator.model: no anthropic key for Curator; engine.memoryConsolidationModel: no openrouter key for Engine']);
  });

  it('warns while notes or search are catching up', async () => {
    const tools = engine();
    const call = tools.call;
    tools.call = async (tool, args, options) => {
      const result = await call(tool, args, options) as Record<string, unknown>;
      return (tool === 'vault-stats'
        ? { ...result, search_index: { status: 'indexing', nodes_total: 3, nodes_indexed: 1, pending: 2, terminal_failures: 0 } }
        : result) as never;
    };

    const checks = byId(await verifyInstall(deps(tools, { markdown: 3 }), PLAN));

    expect(checks.notes?.[0]).toBe('warn');
    expect(checks.notes?.[1]).toContain('Engine has 2 notes in scope; the folder has 3 Markdown files.');
    expect(checks.search).toEqual(['warn', 'still embedding: 1 of 3 notes embedded, 2 queued. It finishes in the background.']);
  });

  it('fails Curator when it does not read the approved settings', async () => {
    const checks = byId(await verifyInstall(
      deps(engine(), { curator: { daily_budget: { cap_usd: 1 }, server: { next_sweep_at: null, wiki_reconciliation_mode: 'off' } } }),
      PLAN,
    ));

    expect(checks.curator).toEqual(['fail', 'does not read the approved settings (cap $1.00, wiki mode off); it may not reach Engine']);
  });
});
