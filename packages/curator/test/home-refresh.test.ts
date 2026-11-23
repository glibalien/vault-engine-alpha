import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { upsertVerdict } from '../src/db/reconcile.js';
import { CurationQueue } from '../src/queue.js';
import type { CoreDeps } from '../src/core.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import { executeHomeRefresh, recoverHomeRefreshes, readHomeRefreshStatus } from '../src/home-refresh.js';
import { admitHomeRefresh, transitionHomeRefresh, getHomeRefresh } from '../src/db/home-refresh.js';
import { digest, previewHomeRefresh } from '../src/home-refresh-preview.js';
import { BudgetExhaustedError, CuratorShutdownError } from '../src/budget.js';
import { pageOutputFrame } from './page-output-fixtures.js';
import type { HomeRefreshRequest } from '../src/home-refresh-types.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type OpenAI from 'openai';
import { EngineError } from '../src/engine.js';
import { localDate } from '../src/date-line.js';

const mocked = vi.hoisted(() => ({ memories: [] as unknown[], prepareInputs: [] as Array<Record<string, any>> }));
vi.mock('../src/home-evidence.js', async importOriginal => ({
  labelProjectMemories: (await importOriginal<typeof import('../src/home-evidence.js')>()).labelProjectMemories,
  projectMemories: async () => mocked.memories, prepareHomeEvidence: async (input: Record<string, any>) => (mocked.prepareInputs.push(input), {
  text: '', nodes: [], provenance: new EvidenceCollector({}), homeBudget: {
    generatedAt: new Date('2026-09-20T00:00:00Z'), model: 'model', maxTokens: 4000, system: 'sys',
    limits: { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 },
  },
}) }));
const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); mocked.memories = []; mocked.prepareInputs.length = 0; });
/** Two memories that disagree, with the observations a tracked build reads them with (#474 idea 4). */
const disagreeing = [40, 55].map((n, index) => ({ id: index + 2, source: 'curator', scope: 'vault', node_id: null, content: `Headcount is ${n}.`,
  category: 'fact', created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', evidence_kind: 'note',
  provenance_observation: { source: { kind: 'memory', namespace: 'vault', native_id: String(index + 2) }, authority: 'engine',
    observed_at: '2026-11-07T00:00:00.000Z', native_version: 1, content_hash: `m${index}`, hash_semantics: 'engine_content_hash',
    observation_projection: 'memory-token-v1', observation_digest: `memory-digest-${index}` } }));
const keepBoth = (db: Database.Database) => upsertVerdict(db, { idA: 2, idB: 3, updatedAtA: 'a', updatedAtB: 'b', verdict: 'kept_both', adjudicatedAt: 't' });
async function fixture(options: { noUsage?: boolean; invalidOutput?: boolean; invalidSections?: boolean; memories?: boolean; conflicts?: boolean } = {}) {
  const db = new Database(':memory:'); dbs.push(db); runMigrations(db);
  const events: string[] = [];
  const target = { select: 'refresh_target', eligible: true, reasons: [], vault_namespace: 'vault',
    output_revision_id: 'output', project_id: 'project', project_title: 'Project', home_node_id: 'home',
    home_title: 'Home', home_path: 'Home.md', home_version: 2, topology_hash: 'topology' };
  let attempt: any = null;
  let loseReply = false;
  const createdMemories: Array<Record<string, unknown>> = [];
  const receipt = { output_revision_id: 'new-output', replaces_output_revision_id: 'output' };
  const engine = {
    inspectProvenance: async (r: any) => r.select === 'status' ? { select: 'status', capability_version: 1,
      vault_namespace: 'vault', inspection_features: ['selective_home_refresh_v1'], limits: {} }
      : r.select === 'refresh_target' ? target : { select: 'attempt', attempt },
    projectEvidence: async () => ({ project: { id: 'project', title: 'Project', status: 'active' },
      evidence_hash: 'new-evidence', existing_wiki: { home_id: 'home', catalog_valid: true, topology_hash: 'topology', subpages: [] } }),
    prepareProvenance: async (r: any) => {
      events.push(r.dry_run ? 'preflight' : 'prepare');
      if (r.dry_run) return { dry_run: true, bundle_digest: 'bundle' };
      attempt = { derivation_id: 'derivation', bundle_digest: 'bundle', state: 'prepared',
        availability: 'retained', lease_expires_at: '2099-01-01T00:00:00Z', output: null };
      return attempt;
    },
    transitionProvenance: async () => { events.push('mark-sent'); return attempt; },
    createMemory: async (args: Record<string, unknown>) => { events.push('memory'); createdMemories.push(args); return { id: 1 }; },
    stageProvenanceResult: async () => { events.push('stage'); attempt.state = 'result_staged'; return {}; },
    wikiReconcile: async (r: any) => {
      events.push(r.dry_run ? 'preview-write' : 'commit');
      expect(r.pages).toEqual([]);
      expect(r.home_refresh.expected_output_revision_id).toBe('output');
      if (!r.dry_run) { attempt.state = 'committed'; attempt.output = receipt; if (loseReply) throw new Error('lost reply'); }
      return { data: { provenance_receipt: receipt }, warnings: [] };
    },
  };
  const providerCall = vi.fn(async () => {
    events.push('model');
    return { choices: [{ message: { content: options.invalidOutput ? 'not JSON' : options.invalidSections ? '{}' : JSON.stringify({ now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log',
      ...(options.memories ? { memories: [{ content: 'The owner reviews this project on Mondays.', category: 'fact' }] } : {}) }) }, finish_reason: 'stop' }],
      ...(options.noUsage ? {} : { usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  });
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create: providerCall } } } as unknown as OpenAI,
    { provider: 'openrouter', fireworksExtensions: false });
  const deps = { db, queue: new CurationQueue(), engine, llm,
    config: { projectHomeProvenanceEnabled: true, model: 'model', modelProviders: { model: 'openrouter' }, homeMaxTokens: 4000, wikiHomeMaxTokens: 0, wikiHomeReasoningEffort: 'inherit',
      memoryWriteEnabled: options.memories === true, memoryWriteCap: 3 },
  } as unknown as CoreDeps;
  if (options.conflicts) keepBoth(db);
  const preview = await previewHomeRefresh(deps, 'output');
  const req: HomeRefreshRequest = { request_id: randomUUID(), confirm_paid: true, guard: preview.guard! };
  const drain = () => deps.queue.enqueue('test-drain', async () => {});
  return { db, deps, req, drain, target, events, providerCall, createdMemories, setLostReply: () => { loseReply = true; } };
}
it('admits immediately, coalesces requests, calls one model, and replays a committed request', async () => {
  const f = await fixture();
  expect((await executeHomeRefresh(f.deps, f.req)).phase).toBe('queued');
  expect((await executeHomeRefresh(f.deps, f.req)).request_id).toBe(f.req.request_id);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
  expect(f.events).toEqual(['preflight', 'prepare', 'mark-sent', 'model', 'stage', 'preview-write', 'commit']);
  f.target.eligible = false;
  expect((await executeHomeRefresh(f.deps, f.req)).phase).toBe('committed');
  expect(getHomeRefresh(f.db, f.req.request_id)?.stage_json).toBeNull();
});
it("keeps the refresh's memory proposals once the home is committed, scoped to the home (#299)", async () => {
  const f = await fixture({ memories: true });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.events.slice(-2)).toEqual(['commit', 'memory']);
  expect(f.createdMemories).toEqual([expect.objectContaining({ source: 'curator', scope: 'node', node_id: 'home',
    content: 'The owner reviews this project on Mondays.', evidence: expect.objectContaining({ kind: 'curation-run', hash: 'new-evidence' }) })]);
});

it('rechecks the target inside the queue before any paid work', async () => {
  const f = await fixture();
  let release!: () => void;
  void f.deps.queue.enqueue('scheduled', () => new Promise<void>(resolve => { release = resolve; }));
  await executeHomeRefresh(f.deps, f.req);
  f.target.home_version++;
  release(); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('allows the same UUID after a transient readiness failure before admission', async () => {
  const f = await fixture();
  vi.spyOn(f.deps.engine, 'inspectProvenance').mockRejectedValueOnce(Error('offline'));
  await expect(executeHomeRefresh(f.deps, f.req)).rejects.toThrow('READINESS_UNAVAILABLE');
  expect(getHomeRefresh(f.db, f.req.request_id)).toBeNull();
  expect(f.providerCall).not.toHaveBeenCalled();
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it('recovers queued readiness failure instead of permanently conflicting the request', async () => {
  const f = await fixture();
  let release!: () => void;
  void f.deps.queue.enqueue('hold', () => new Promise<void>(resolve => { release = resolve; }));
  await executeHomeRefresh(f.deps, f.req);
  const inspect = f.deps.engine.inspectProvenance.bind(f.deps.engine);
  let offline = true;
  vi.spyOn(f.deps.engine, 'inspectProvenance').mockImplementation(async input => {
    if (offline && input.select === 'refresh_target') { offline = false; throw Error('offline'); }
    return inspect(input);
  });
  release(); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('awaiting_recovery');
  expect(f.providerCall).not.toHaveBeenCalled();
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it('keeps a definitive guard change immediately before dispatch terminal', async () => {
  const f = await fixture();
  const prepare = f.deps.engine.prepareProvenance.bind(f.deps.engine);
  vi.spyOn(f.deps.engine, 'prepareProvenance').mockImplementation(async input => {
    const result = await prepare(input);
    if (!input.dry_run) f.target.home_version++;
    return result;
  });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it.each(['cap', 'effort', 'provider'] as const)('blocks a changed home %s policy at the final dispatch guard', async change => {
  const f = await fixture();
  const prepare = f.deps.engine.prepareProvenance.bind(f.deps.engine);
  vi.spyOn(f.deps.engine, 'prepareProvenance').mockImplementation(async input => {
    const result = await prepare(input);
    if (!input.dry_run) {
      if (change === 'cap') f.deps.config.wikiHomeMaxTokens = 16000;
      if (change === 'effort') f.deps.config.wikiHomeReasoningEffort = 'low';
      if (change === 'provider') vi.spyOn(f.deps.llm, 'configurationFor').mockReturnValue({ provider: 'fireworks', reasoningEffort: null });
    }
    return result;
  });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('resolves a coalesced UUID after a lost admission reply and a now-stale preview', async () => {
  const f = await fixture();
  let release!: () => void;
  void f.deps.queue.enqueue('hold', () => new Promise<void>(resolve => { release = resolve; }));
  await executeHomeRefresh(f.deps, f.req);
  const b = { ...f.req, request_id: randomUUID() };
  expect((await executeHomeRefresh(f.deps, b)).request_id).toBe(f.req.request_id);
  release(); await f.drain();
  f.target.eligible = false;
  expect((await executeHomeRefresh(f.deps, b)).phase).toBe('committed');
  expect(readHomeRefreshStatus(f.deps, b.request_id).request_id).toBe(f.req.request_id);
  await expect(executeHomeRefresh(f.deps, { ...b, guard: { ...b.guard, home_version: 8 } })).rejects.toThrow('REQUEST_CONFLICT');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it('recovers a lost commit reply from the authoritative receipt without another model call', async () => {
  const f = await fixture(); f.setLostReply();
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
  expect(f.events.filter(e => e === 'commit')).toHaveLength(1);
});
it('never dispatches automatically after an interrupted dispatch intent', async () => {
  const f = await fixture(); admitHomeRefresh(f.db, f.req);
  transitionHomeRefresh(f.db, f.req.request_id, 'queued', { phase: 'dispatch_intent' });
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('uncertain');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('terminates an oversized staged result instead of replaying it on every recovery tick', async () => {
  const f = await fixture();
  const stage = vi.spyOn(f.deps.engine, 'stageProvenanceResult').mockRejectedValue(
    new EngineError('INVALID_PARAMS', 'PROVENANCE_LIMIT', { reason: 'PROVENANCE_LIMIT' }));
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('failed');
  expect(getHomeRefresh(f.db, f.req.request_id)?.stage_json).toBeNull();
  recoverHomeRefreshes(f.deps); await f.drain();
  expect(stage).toHaveBeenCalledTimes(1);
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it('releases a definitively conflicted staged attempt using its current expected state', async () => {
  const f = await fixture();
  vi.spyOn(f.deps.engine, 'wikiReconcile').mockRejectedValue(new EngineError('STALE_NODE', 'changed'));
  const transition = vi.spyOn(f.deps.engine, 'transitionProvenance');
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(transition).toHaveBeenCalledWith({ derivation_id: 'derivation', action: 'fail', expected_state: 'result_staged' });
});
it('honors a committed receipt instead of failing the Engine attempt during terminal cleanup', async () => {
  const f = await fixture();
  const reconcile = f.deps.engine.wikiReconcile.bind(f.deps.engine);
  vi.spyOn(f.deps.engine, 'wikiReconcile').mockImplementation(async input => {
    const result = await reconcile(input);
    if (!input.dry_run) throw new EngineError('CONFLICT', 'reply replaced after commit');
    return result;
  });
  const transition = vi.spyOn(f.deps.engine, 'transitionProvenance');
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'committed', output: { output_revision_id: 'new-output' } });
  expect(transition.mock.calls.map(([input]) => input.action)).toEqual(['mark-sent']);
});
it('leaves an unreachable cleanup attempt to its lease without hiding the definitive local conflict', async () => {
  const f = await fixture();
  vi.spyOn(f.deps.engine, 'wikiReconcile').mockImplementation(async () => {
    vi.spyOn(f.deps.engine, 'inspectProvenance').mockRejectedValue(Error('offline'));
    throw new EngineError('STALE_NODE', 'changed');
  });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(getHomeRefresh(f.db, f.req.request_id)?.publication_json).toBeNull();
});

it('validates the actual execution settings snapshot, even when settings change back during reload', async () => {
  const f = await fixture();
  let release!: () => void;
  void f.deps.queue.enqueue('scheduled', () => new Promise<void>(resolve => { release = resolve; }));
  await executeHomeRefresh(f.deps, f.req);
  let reloads = 0;
  f.deps.refreshDeps = async () => ({ ...f.deps, config: { ...f.deps.config, homeMaxTokens: ++reloads === 1 ? 999 : 4000 } });
  release(); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('conflict');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('keeps missing provider usage unknown rather than reporting zero billed tokens', async () => {
  const f = await fixture({ noUsage: true });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).usage).toBeNull();
});
it('retains known billed usage when provider output fails validation', async () => {
  const f = await fixture({ invalidOutput: true });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).usage).toMatchObject({ input: 10, output: 2 });
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it.each([true, false])('preserves usage availability through home section validation (missing=%s)', async noUsage => {
  const f = await fixture({ noUsage, invalidSections: true });
  await executeHomeRefresh(f.deps, f.req); await f.drain();
  const usage = readHomeRefreshStatus(f.deps, f.req.request_id).usage;
  if (noUsage) expect(usage).toBeNull();
  else expect(usage).toMatchObject({ input: 10, output: 2 });
});

/** A client whose daily budget refuses every call before it's sent, as the real guard does. */
const refusingBudget = (client: any): any => Object.create(client, {
  structuredCall: { value: async () => { throw new BudgetExhaustedError('Daily wiki budget is spent: $3.00 of $3.00.'); } },
  withConfiguration: { value: (configuration: any) => refusingBudget(client.withConfiguration(configuration)) },
});
async function pageFixture(options: { budgetRefused?: boolean; logNote?: string | null; sources?: string[]; conflicts?: boolean;
  /** The page's current text, and the rule check's rulings in order (#474 idea 4). */
  pageBody?: string; rulings?: Array<Array<{ rule: number; words: string }>> } = {}) {
  const db = new Database(':memory:'); dbs.push(db); runMigrations(db);
  const events: string[] = [];
  const lookups: Array<Record<string, unknown>> = [];
  const writes: any[] = [];
  const target = { select: 'refresh_target', eligible: true, reasons: [], vault_namespace: 'vault', target_kind: 'page',
    output_revision_id: 'output', project_id: 'project', project_title: 'Project', home_node_id: 'home', home_title: 'Home', home_path: 'Home.md',
    home_version: 2, topology_hash: 'topology', page_node_id: 'page', page_title: 'Project — Decisions', page_path: 'Wikis/Decisions.md', page_version: 3 };
  const scope = { v: 1, subject: 'Project', facet: 'Decisions' };
  const subpages = [
    { id: 'page', title: 'Project — Decisions', version: 3, wiki_scope: scope, wiki_kind: 'workstream', wiki_origin: 'requested', wiki_pinned: true, wiki_state: 'active' },
    { id: 'other', title: 'Project — Risks', version: 1, wiki_scope: { ...scope, facet: 'Risks' }, wiki_kind: 'freeform', wiki_origin: 'automatic', wiki_pinned: false, wiki_state: 'active' },
  ];
  const observation = (id: string) => ({ source: { kind: 'node', namespace: 'vault', native_id: id }, authority: 'engine', observed_at: '2026-11-07T00:00:00.000Z',
    native_version: 1, content_hash: 'hash-' + id, hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2', observation_digest: 'digest-' + id });
  const node = (id: string, body: string) => ({ id, title: id, types: ['note'], fields: {}, body, version: 1, metadata: { content_hash: 'hash-' + id }, provenance_observation: observation(id) });
  let attempt: any = null;
  const preparedKeys: string[] = [];
  const receipt = { output_revision_id: 'new-output', output_node_id: 'page', replaces_output_revision_id: 'output' };
  const engine = {
    inspectProvenance: async (r: any) => {
      if (r.select === 'status') return { select: 'status', capability_version: 1, vault_namespace: 'vault',
        inspection_features: ['selective_home_refresh_v1', 'selective_page_refresh_v1'], capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'],
        limits: { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 } };
      if (r.select === 'refresh_target') return target;
      if (r.select === 'output') return { select: 'output', inputs: (options.sources ?? ['prior', 'deleted', 'home', 'other']).map(id => ({ source: { kind: 'node', namespace: 'vault', native_id: id } }))
        .concat([{ source: { kind: 'memory', namespace: 'vault', native_id: 'memory' } }]), next_cursor: null };
      lookups.push(r);
      return { select: 'attempt', attempt };
    },
    projectEvidence: async () => ({ project: { id: 'project', title: 'Project', status: 'active', file_path: 'Project.md' }, evidence_hash: 'new-evidence', notes: [], tasks: {},
      existing_wiki: { home_id: 'home', catalog_valid: true, topology_hash: 'topology', subpages } }),
    semanticRelated: async () => [{ id: 'prior', title: 'prior' }, { id: 'related', title: 'related' }, { id: 'page', title: 'page' }],
    getNode: async (id: string) => {
      if (id === 'deleted') throw new EngineError('NOT_FOUND', 'gone');
      if (id === 'page') return { ...node('page', options.pageBody ?? 'Current page text.'), types: ['wiki'] };
      return node(id, id === 'prior' ? 'Prior source body.' : 'Related source body.');
    },
    listMemories: async () => ({ memories: [], total: 0 }),
    prepareProvenance: async (r: any) => {
      events.push('prepare'); preparedKeys.push(r.attempt_key);
      attempt = { derivation_id: preparedKeys.length === 1 ? 'derivation' : `derivation-${preparedKeys.length}`, bundle_digest: 'bundle', state: 'prepared', availability: 'retained', lease_expires_at: '2099-01-01T00:00:00Z', output: null, flow: r.flow };
      return attempt;
    },
    transitionProvenance: async (r: any) => { events.push(r.action); if (r.action === 'fail') attempt.state = 'failed'; return attempt; },
    stageProvenanceResult: async () => { events.push('stage'); attempt.state = 'result_staged'; return {}; },
    wikiReconcile: async (r: any) => {
      events.push(r.dry_run ? 'preview-write' : 'commit'); writes.push(r);
      if (!r.dry_run) { attempt.state = 'committed'; attempt.output = receipt; }
      return { data: { provenance_receipt: receipt }, warnings: [] };
    },
  };
  const note = options.logNote === undefined ? 'Rebuilt the decisions.' : options.logNote;
  const rulings = [...(options.rulings ?? [])];
  const providerCall = vi.fn(async (payload: any) => {
    if (payload.response_format?.json_schema?.name === 'emit_rule_check') {
      events.push('check');
      return { choices: [{ message: { content: JSON.stringify({ broken: rulings.shift() ?? [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
    }
    events.push('model');
    return { choices: [{ message: { content: pageOutputFrame({ body: '## Decisions\n\nRebuilt page text.\n', ...(note === null ? {} : { log_note: note }) }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } };
  });
  let llm: any = new OpenAiCompatLlmClient({ chat: { completions: { create: providerCall } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  if (options.budgetRefused) llm = refusingBudget(llm);
  const deps = { db, queue: new CurationQueue(), engine, llm,
    config: { projectHomeProvenanceEnabled: true, model: 'model', wikiPageModel: 'page-model', modelProviders: { model: 'openrouter', 'page-model': 'openrouter' },
      homeMaxTokens: 4000, wikiHomeMaxTokens: 0, wikiPageMaxTokens: 2000, wikiHomeReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit',
      bodyCharCap: null, semanticGapFillLimit: 5, curatorPagePrompt: 'Page system.' },
  } as unknown as CoreDeps;
  if (options.conflicts) keepBoth(db);
  const preview = await previewHomeRefresh(deps, 'output');
  expect(preview.eligible, JSON.stringify(preview)).toBe(true);
  const req: HomeRefreshRequest = { request_id: randomUUID(), confirm_paid: true, guard: preview.guard! };
  return { db, deps, req, target, subpages, events, lookups, writes, providerCall, preparedKeys, drain: () => deps.queue.enqueue('test-drain', async () => {}) };
}
it('rebuilds one sub-page with one model call and no planner, publishing only that page', async () => {
  const f = await pageFixture();
  expect((await executeHomeRefresh(f.deps, f.req)).message).toMatch(/rebuild this page/);
  await f.drain();
  const status = readHomeRefreshStatus(f.deps, f.req.request_id);
  expect(status, JSON.stringify(status)).toMatchObject({ phase: 'committed', message: expect.stringMatching(/Page rebuilt/), usage: { input: 10, output: 2 } });
  expect(f.providerCall).toHaveBeenCalledTimes(1);
  expect(f.events).toEqual(['prepare', 'mark-sent', 'model', 'stage', 'preview-write', 'commit']);
  const write = f.writes.at(-1);
  expect(write).toMatchObject({ project: 'Project', project_id: 'project', provenance_mode: 'project-subpage-v1', reconcile_key: 'wiki-reconcile:provenance-v1:derivation', dry_run: false,
    page_refresh: { page_node_id: 'page', expected_output_revision_id: 'output', expected_topology_hash: 'topology' },
    home: { sections: [], evidence_hash: 'new-evidence' } });
  expect(write.home.provenance).toBeUndefined();
  expect(write.pages).toHaveLength(1);
  expect(write.pages[0]).toMatchObject({ op: 'upsert', target: { mode: 'existing', node_id: 'page', expected_version: 3 },
    scope: { facet: 'Decisions' }, kind: 'workstream', origin: 'requested', pinned: true,
    provenance: { derivation_id: 'derivation', bundle_digest: 'bundle' } });
});
it('reads what the page\'s current build read, plus what\'s related now, on the page model', async () => {
  const f = await pageFixture();
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const payload = f.providerCall.mock.calls[0]![0] as any;
  expect(payload.model).toBe('page-model');
  expect(payload.messages[0].content).toContain('Page system.');
  const user = JSON.parse(payload.messages.at(-1).content);
  expect(user).toMatchObject({ action: 'refresh', title: 'Project — Decisions', kind: 'workstream', current_target: { id: 'page' } });
  expect(user.evidence).toContain('Prior source body.');
  expect(user.evidence).toContain('Related source body.');
  // The same note once, a deleted one skipped, and no wiki page as a source.
  expect(user.evidence.match(/### \[prior\]/g)).toHaveLength(1);
  expect(user.evidence).not.toMatch(/### \[(deleted|home|other|page)\]/);
});
it('keeps equal same-day log notes apart, as the home does', async () => {
  const f = await pageFixture();
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const log = f.writes.at(-1).pages[0].sections.find((section: any) => section.name === 'Log');
  expect(log.content).toBe(`Rebuilt the decisions.\n<!-- page-refresh-request:${f.req.request_id} -->`);
  expect(f.writes.at(-1).pages[0].sections.find((section: any) => section.name === 'Summary').content).toBe('## Decisions\n\nRebuilt page text.');
});
it('writes no log section when the model gives no note', async () => {
  const f = await pageFixture({ logNote: null });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.writes.at(-1).pages[0].sections.map((section: any) => section.name)).toEqual(['Summary']);
});
it('binds the digest to the form Engine stores, trimmed and sorted by section name', async () => {
  const f = await pageFixture();
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const page = f.writes.at(-1).pages[0];
  expect(page.sections.map((section: { name: string }) => section.name)).toEqual(['Log', 'Summary']);
  expect(page.sections.every((section: { content: string }) => section.content === section.content.trim())).toBe(true);
  expect(page.provenance.contribution_digest).toBe(digest(page.sections));
});
it('looks a page\'s attempt up under the page flow when recovering', async () => {
  const f = await pageFixture();
  const row = admitHomeRefresh(f.db, f.req);
  transitionHomeRefresh(f.db, row.request_id, 'queued', { phase: 'dispatch_intent' });
  recoverHomeRefreshes(f.deps);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('uncertain');
  expect(f.lookups.length).toBeGreaterThan(0);
  expect(f.lookups.every(lookup => lookup.flow === 'project-subpage-v1')).toBe(true);
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('coalesces a repeat for the same page, but not another page or the home', async () => {
  const f = await pageFixture();
  const first = admitHomeRefresh(f.db, f.req);
  const repeat = admitHomeRefresh(f.db, { ...f.req, request_id: randomUUID() });
  expect(repeat.request_id).toBe(first.request_id);
  const other = admitHomeRefresh(f.db, { ...f.req, request_id: randomUUID(), guard: { ...f.req.guard, page_node_id: 'other', page_version: 1 } });
  expect(other.request_id).not.toBe(first.request_id);
  const { page_node_id: _page, page_version: _version, ...homeGuard } = f.req.guard;
  const home = admitHomeRefresh(f.db, { ...f.req, request_id: randomUUID(), guard: homeGuard });
  expect(home.request_id).not.toBe(first.request_id);
  expect(home.message).toMatch(/rebuild this home/);
});
it.each([
  ['the page moved on', (f: any) => { f.subpages[0].version = 4; }],
  ['the page went dormant', (f: any) => { f.subpages[0].wiki_state = 'dormant'; }],
  ['the page was removed', (f: any) => { f.subpages.shift(); }],
])('stops before any paid call when %s', async (_label, change) => {
  const f = await pageFixture();
  change(f);
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'conflict', message: expect.stringMatching(/The page or confirmed settings changed/) });
  expect(f.providerCall).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('a changed preview stops admission, so the owner is asked again', async () => {
  const f = await pageFixture();
  f.target.page_version = 4;
  await expect(executeHomeRefresh(f.deps, f.req)).rejects.toThrow('GUARD_CONFLICT');
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('says so when the daily budget refuses a page, and doesn\'t wait to spend later', async () => {
  const f = await pageFixture({ budgetRefused: true });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const status = readHomeRefreshStatus(f.deps, f.req.request_id);
  expect(status).toMatchObject({ phase: 'failed', message: expect.stringMatching(/Daily wiki budget is spent.*Nothing was rebuilt/) });
  expect(f.providerCall).not.toHaveBeenCalled();
  recoverHomeRefreshes(f.deps);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('failed');
});
it('leaves a page rebuild refused by shutdown for recovery, which finishes it after the restart (#405)', async () => {
  const f = await pageFixture();
  const live = f.deps.llm;
  f.deps.llm = Object.create(live, {
    structuredCall: { value: async () => { throw new CuratorShutdownError(); } },
    withConfiguration: { value: function (this: any) { return this; } },
  });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const stopped = readHomeRefreshStatus(f.deps, f.req.request_id);
  expect(['queued', 'preparing']).toContain(stopped.phase);
  expect(f.providerCall).not.toHaveBeenCalled();
  f.deps.llm = live; // the restarted server admits calls again
  recoverHomeRefreshes(f.deps);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
  expect(f.providerCall).toHaveBeenCalledTimes(1);
});
it('says so when the daily budget refuses a home too', async () => {
  const f = await fixture();
  f.deps.llm = refusingBudget(f.deps.llm);
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'failed', message: expect.stringMatching(/Daily wiki budget is spent.*Nothing was rebuilt/) });
  expect(f.providerCall).not.toHaveBeenCalled();
});
it('ends the request when Engine refuses the capture, rather than retrying it for ever', async () => {
  const f = await pageFixture();
  f.deps.engine.prepareProvenance = (async () => { throw new EngineError('INVALID_PARAMS', 'too large', { reason: 'PROVENANCE_LIMIT' }); }) as never;
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'failed', message: expect.stringMatching(/rejected this capture/) });
  expect(f.providerCall).not.toHaveBeenCalled();
  recoverHomeRefreshes(f.deps);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('failed');
});
it('keeps a page change right before dispatch a conflict, with no paid call', async () => {
  const f = await pageFixture();
  const prepare = f.deps.engine.prepareProvenance.bind(f.deps.engine);
  f.deps.engine.prepareProvenance = (async (request: never) => { Object.assign(f.target, { page_version: 4 }); return prepare(request); }) as never;
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'conflict', message: expect.stringMatching(/The page or confirmed settings changed/) });
  expect(f.providerCall).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});
it('ends the request on a lost connection at capture, with no paid call', async () => {
  const f = await pageFixture();
  f.deps.engine.prepareProvenance = (async () => { throw new Error('socket hang up'); }) as never;
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  expect(readHomeRefreshStatus(f.deps, f.req.request_id)).toMatchObject({ phase: 'failed', message: expect.not.stringContaining('socket') });
  expect(f.providerCall).not.toHaveBeenCalled();
});

it('gives a refreshed home the memory pairs nothing has settled, as a full build does (#474 idea 4)', async () => {
  const f = await fixture({ conflicts: true });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const readConflicts = mocked.prepareInputs.at(-1)?.readConflicts as (ids: number[]) => unknown;
  expect(readConflicts([2, 3, 9])).toEqual([[2, 3]]);
});

it('shows a rebuilt page the memory pairs nothing has settled, as a full build does (#474 idea 4)', async () => {
  mocked.memories = disagreeing;
  const f = await pageFixture({ conflicts: true });
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const user = JSON.parse((f.providerCall.mock.calls[0]![0] as any).messages.at(-1).content);
  expect(user.evidence).toContain('## UNSETTLED CONFLICTS');
  // A midnight-UTC date is that day in any zone (#706).
  const day = '2026-11-02';
  expect(user.evidence).toContain(`- "Headcount is 40." (${day}, from a note) vs "Headcount is 55." (${day}, from a note)`);
});

it('dates and sources a rebuilt page\'s memory lines, newest first, as a full build does', async () => {
  // One memory drawn from a note the rebuild reads (so it is named), one from a chat, a day apart.
  mocked.memories = [
    { ...disagreeing[0], valid_at: '2026-10-05T12:00:00Z', evidence_node_id: 'prior' },
    { ...disagreeing[1], valid_at: '2026-10-20T12:00:00Z', evidence_kind: 'conversation' },
  ];
  const f = await pageFixture();
  await executeHomeRefresh(f.deps, f.req);
  await f.drain();
  const evidence = JSON.parse((f.providerCall.mock.calls[0]![0] as any).messages.at(-1).content).evidence as string;
  expect(evidence).toContain('newest first, each with the day it became true and where it came from');
  const newer = evidence.indexOf(`- [fact] ${localDate(Date.parse('2026-10-20T12:00:00Z'))}, from a chat: Headcount is 55.`);
  const older = evidence.indexOf(`- [fact] ${localDate(Date.parse('2026-10-05T12:00:00Z'))}, from "prior": Headcount is 40.`);
  expect(newer).toBeGreaterThan(-1);
  expect(older).toBeGreaterThan(newer);
});


describe('a rebuilt page with rules on what to say (#474 idea 4)', () => {
  // The page carries memory 2 as a rule; the build sees memory 2, so the rule stays and is checked.
  const ruled = '## Decisions\n\nCurrent page text.\n\n## Rules on what to say\n\n- Headcount is 40. <!-- memory:2 -->';
  const published = (f: Awaited<ReturnType<typeof pageFixture>>) => JSON.stringify(f.writes.at(-1)?.pages[0]?.sections);

  it('checks the draft and publishes it with the rules', async () => {
    mocked.memories = disagreeing;
    const f = await pageFixture({ pageBody: ruled, rulings: [[]] });
    await executeHomeRefresh(f.deps, f.req);
    await f.drain();
    expect(readHomeRefreshStatus(f.deps, f.req.request_id).phase).toBe('committed');
    expect(f.events).toEqual(['prepare', 'mark-sent', 'model', 'check', 'stage', 'preview-write', 'commit']);
    expect(published(f)).toContain('Headcount is 40. <!-- memory:2 -->');
  });

  it('writes the page once more under a fresh attempt when the draft breaks a rule, failing the first attempt', async () => {
    mocked.memories = disagreeing;
    const f = await pageFixture({ pageBody: ruled, rulings: [[{ rule: 1, words: 'Rebuilt page text.' }], []] });
    await executeHomeRefresh(f.deps, f.req);
    await f.drain();
    const status = readHomeRefreshStatus(f.deps, f.req.request_id);
    expect(status.phase, JSON.stringify(status)).toBe('committed');
    expect(f.events).toEqual(['prepare', 'mark-sent', 'model', 'check', 'fail', 'prepare', 'mark-sent', 'model', 'check', 'stage', 'preview-write', 'commit']);
    expect(f.preparedKeys).toHaveLength(2);
    expect(f.preparedKeys[1]).not.toBe(f.preparedKeys[0]);
    // The second draft was told which rule it broke.
    expect((f.providerCall.mock.calls[2]![0] as any).messages[0].content).toContain('broke these rules');
  });

  it('ends the request without publishing, the old page kept, when the second draft breaks a rule too', async () => {
    mocked.memories = disagreeing;
    const f = await pageFixture({ pageBody: ruled, rulings: [[{ rule: 1, words: 'x' }], [{ rule: 1, words: 'y' }]] });
    await executeHomeRefresh(f.deps, f.req);
    await f.drain();
    const status = readHomeRefreshStatus(f.deps, f.req.request_id);
    expect(status).toMatchObject({ phase: 'failed', message: expect.stringMatching(/^The page wasn't published and is unchanged: both drafts broke a rule on what to say \(memory 2/) });
    expect(f.events.filter(event => event === 'commit')).toEqual([]);
    expect(f.events.filter(event => event === 'model')).toHaveLength(2);
  });
});

