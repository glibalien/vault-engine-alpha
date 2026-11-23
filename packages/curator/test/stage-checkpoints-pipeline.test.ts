import { pageOutputFrame } from './page-output-fixtures.js';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import { type Engine, type WikiReconcileInput } from '../src/engine.js';
import { pageNoteStatesOf, runReconciliationPipeline, type BuildStatusHooks, type HomeBudgetContext } from '../src/reconciliation-pipeline.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { runMigrations } from '../src/db/migrate.js';
import { stageCheckpointStore } from '../src/db/stage-checkpoints.js';
import type { Config } from '../src/config.js';
import type { PrepareRequest, StageRequest } from '../src/provenance-types.js';
import type { EngineNode, ExistingWiki, Memory } from '../src/types.js';

const scope = (facet: string) => ({ v: 1 as const, subject: 'Project', facet });
const existingWiki: ExistingWiki = { home_id: null, home: null, topology_hash: 'old', catalog_valid: true, subpages: [] };
const generatedAt = new Date('2026-09-18T12:00:00Z');
type Attempt = { derivation: string; state: 'prepared' | 'result_staged' | 'committed' | 'failed'; lease: number };
type RunOptions = { failHome?: boolean; failPageCall?: number; failWrite?: boolean; evidence?: string;
  tracked?: boolean; dryRun?: boolean; leaseMs?: number; noteStates?: boolean;
  existingWiki?: ExistingWiki; buildStatus?: BuildStatusHooks; homeRead?: EngineNode;
  /** The sources the planner names for each create (#474 idea 3), and more notes to read. */
  plannerEvidenceIds?: Readonly<Record<'first' | 'second', readonly string[]>>; extraNodes?: EngineNode[];
  /** The build's memories, and the ones the planner marks as the first page's rules (#474 idea 4). */
  memories?: Memory[]; firstRuleIds?: number[]; ruleBreaks?: number };

/** Runs the pipeline repeatedly against one Engine, provider and curator DB, as successive attempts would. */
function harness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const warnings: string[] = [];
  const store = stageCheckpointStore(db, 'Project', message => warnings.push(message));
  const attempts = new Map<string, Attempt>();
  let derivations = 0;
  let events: string[] = [];
  let writes: WikiReconcileInput[] = [];
  let options: RunOptions = {};
  let pageCalls = 0;
  let plannerInputs: any[] = [];
  let ruleBreaks = 0;
  let pageInputs: any[] = [];
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: any) => {
    const name = payload.response_format?.json_schema.name;
    const call = name === 'emit_topology_plan' ? 'planner' : name === 'emit_scope_adjudication' ? 'adjudicator'
      : name === 'emit_wiki_sections' ? 'home' : name === 'emit_rule_check' ? 'rules' : 'page';
    events.push(call);
    if (call === 'home' && options.failHome) throw new Error('connection reset');
    if (call === 'page' && options.failPageCall === ++pageCalls) throw new Error('connection reset');
    const user = JSON.parse(payload.messages.at(-1).content);
    if (call === 'planner') plannerInputs.push({ user, schema: payload.response_format?.json_schema.schema, system: payload.messages[0].content });
    if (call === 'page') pageInputs.push(user);
    const ids = (key: 'first' | 'second') => ({ ...(options.plannerEvidenceIds ? { evidence_ids: [...options.plannerEvidenceIds[key]] } : {}),
      ...(key === 'first' && options.firstRuleIds ? { rule_ids: options.firstRuleIds } : {}) });
    const output = call === 'adjudicator' ? { verdicts: user.comparisons.map((pair: any) => ({
      pair_id: pair.pair_id, candidate_plan_key: pair.candidate_plan_key, compared_to: pair.compared_to,
      relation: 'distinct', confidence: 0.95, evidence_ids: [], reason: 'Independent scopes.', narrower: 'none',
    })) } : call === 'planner' ? { reviewed_page_ids: [], actions: [
      { op: 'create', plan_key: 'first', title: 'Project — First', kind: 'workstream', scope: scope('First'), synthesis_brief: 'First.', ...ids('first') },
      { op: 'create', plan_key: 'second', title: 'Project — Second', kind: 'workstream', scope: scope('Second'), synthesis_brief: 'Second.', ...ids('second') },
    ] } : call === 'rules' ? { broken: ruleBreaks-- > 0 ? [{ rule: 1, words: 'headless' }] : [] } : call === 'home' ? { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }
      : { body: `## Summary\n\nPage body ${pageCalls}.` };
    return { choices: [{ message: { content: name ? JSON.stringify(output) : pageOutputFrame(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const engine = {
    inspectProvenance: async (request: { select: string; attempt_key?: string }) => {
      if (request.select === 'status') return { select: 'status', capability_version: 1,
        capture_features: ['project-subpage-v1', 'multi-output-reconcile-v1'], vault_namespace: 'test', limits: {},
        actual_bytes: 0, reserved_bytes: 0, purge_restore_verification: 'unverified' };
      const attempt = request.attempt_key ? attempts.get(request.attempt_key) : undefined;
      return { select: 'attempt', attempt: attempt ? { derivation_id: attempt.derivation, bundle_digest: 'digest', state: attempt.state,
        availability: 'retained', lease_expires_at: new Date(attempt.lease).toISOString(), output: null } : null };
    },
    prepareProvenance: async (request: PrepareRequest) => {
      if (request.dry_run) return { dry_run: true, bundle_digest: 'digest', payload_bytes: 1, reserved_bytes: 2, item_count: 0 };
      const derivation = `derivation-${++derivations}`;
      attempts.set(request.attempt_key, { derivation, state: 'prepared', lease: Date.now() + (options.leaseMs ?? 3_600_000) });
      return { derivation_id: derivation, bundle_digest: 'digest', state: 'prepared', availability: 'retained',
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    },
    transitionProvenance: async (request: { derivation_id: string; action: string }) => {
      const attempt = [...attempts.values()].find(item => item.derivation === request.derivation_id);
      if (attempt && request.action === 'fail') attempt.state = 'failed';
      return {};
    },
    stageProvenanceResult: async (request: StageRequest) => {
      const attempt = [...attempts.values()].find(item => item.derivation === request.derivation_id);
      if (attempt) attempt.state = 'result_staged';
      return { derivation_id: request.derivation_id, bundle_digest: request.bundle_digest, contribution_digest: `contribution-${request.derivation_id}` };
    },
    getNode: async () => { throw new Error('unexpected node read'); },
    wikiReconcile: async (request: WikiReconcileInput) => {
      writes.push(request);
      const committed = request.dry_run !== true;
      if (committed && options.failWrite) throw new Error('PROVENANCE_KEY_CONFLICT');
      const bindings = [request.home.provenance, ...request.pages.flatMap(page => 'provenance' in page ? [page.provenance] : [])]
        .filter((binding): binding is NonNullable<typeof binding> => binding !== undefined);
      if (committed) for (const binding of bindings) {
        const attempt = [...attempts.values()].find(item => item.derivation === binding.derivation_id);
        if (attempt) attempt.state = 'committed';
      }
      const receipts = committed ? bindings.map((binding, index) => ({
        derivation_id: binding.derivation_id, output_revision_id: `output-${index}`, output_node_id: index === 0 ? 'home' : `page-${index}`,
        committed_node_version: 1, committed_at: generatedAt.toISOString(), operation_id: 'operation', reconcile_key: request.reconcile_key,
        request_digest: 'digest',
      })) : undefined;
      return { data: { operation_id: committed ? 'operation' : null, reconcile_key: request.reconcile_key, plan_digest: 'digest', reused: false,
        dry_run: !committed, created: request.pages.filter(page => page.op !== 'retire').map((page, index) => ({
          node_id: committed ? `page-${index + 1}` : `plan:${page.target.mode === 'new' ? page.target.plan_key : ''}`,
          title: page.target.mode === 'new' ? page.target.title : '', file_path: `Page-${index}.md`, version: 1,
        })), updated: [], mappings: [], topology_hash: 'new', warnings: [], preview: { total: 0, items: [], truncated: false },
        home: { node_id: 'home', title: 'Project Wiki', file_path: 'Home.md', version: 1, created: true },
        ...(receipts ? { provenance_receipt: receipts[0], provenance_receipts: receipts } : {}) }, warnings: [] };
    },
  } as unknown as Engine;
  const llm = {
    configurationFor: adapter.configurationFor.bind(adapter),
    withConfiguration() { return this; }, supportsPreparedCapture: true as const,
    previewStructuredCall: adapter.previewStructuredCall.bind(adapter),
    structuredCall: adapter.structuredCall.bind(adapter) };
  const homeBudget: HomeBudgetContext = { generatedAt, model: 'model', system: 'sys', maxTokens: 4000,
    limits: { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 }, omissionCounts: {} };
  const config = { wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit',
    wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'model', homeMaxTokens: 4000, bodyCharCap: null } as Config;

  async function run(next: RunOptions = {}) {
    options = next;
    events = [];
    writes = [];
    pageCalls = 0;
    plannerInputs = [];
    pageInputs = [];
    ruleBreaks = next.ruleBreaks ?? 0;
    const tracked = next.tracked !== false;
    const outcome = await runReconciliationPipeline({ engine, llm, config,
      project: 'Project', rootTitle: 'Project', wikiRootId: 'p', evidenceHash: 'hash', existingWiki: next.existingWiki ?? existingWiki,
      ...(next.buildStatus ? { buildStatus: next.buildStatus } : {}),
      dryRun: next.dryRun ?? false, ...(next.dryRun ? { preview: true } : {}), force: false, checkpoints: store,
      ...(next.noteStates ? { pageNoteStates: new Map() } : {}),
      ...(tracked ? { provenanceRunRef: `run-${Math.random()}` } : {}),
      prepareEvidence: async () => ({ text: next.evidence ?? 'Evidence', nodes: [evidenceNode(), ...(next.extraNodes ?? []), ...(next.homeRead ? [next.homeRead] : [])],
        ...(next.memories ? { memories: next.memories } : {}),
        ...(tracked ? { provenance: new EvidenceCollector({}), homeBudget } : {}) }) });
    return { result: outcome.result, events, writes, plannerInputs, pageInputs };
  }
  const checkpointRow = () => db.prepare('SELECT fingerprint, pages_json FROM wiki_stage_checkpoints WHERE root_title = ?')
    .get('Project') as { fingerprint: string; pages_json: string } | undefined;
  const states = () => [...attempts.values()].map(attempt => `${attempt.derivation}:${attempt.state}`);
  return { run, attempts, states, checkpointRow, warnings };
}

/** An evidence node as Engine returns it with provenance: each read stamps a fresh observation time. */
function evidenceNode(): EngineNode {
  return { id: 'n1', title: 'Note', types: ['note'], fields: {}, body: 'Note body.', version: 3, metadata: { content_hash: 'c3' }, provenance_observation: {
    source: { kind: 'node', namespace: 'vault', native_id: 'n1' }, authority: 'engine',
    observed_at: new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString(), native_version: 3, content_hash: 'c3',
    hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2', observation_digest: 'sha256:n1-v3',
    label: 'Note', path: 'Note.md' } };
}

const boundDerivations = (write: WikiReconcileInput | undefined) =>
  write?.pages.map(page => 'provenance' in page ? page.provenance?.derivation_id : undefined);

it('reuses planning and finished pages after a home failure, publishes once, then clears the checkpoint', async () => {
  const h = harness();
  const first = await h.run({ failHome: true });
  expect(first.result.outcome).toBe('error');
  expect(first.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
  expect(first.writes).toHaveLength(0);
  // Finished pages stay staged for the next attempt; the failed home capture is failed.
  expect(h.states()).toEqual(['derivation-1:result_staged', 'derivation-2:result_staged', 'derivation-3:failed']);
  expect(JSON.parse(h.checkpointRow()!.pages_json)).toHaveLength(2);

  const second = await h.run();
  expect(second.result.outcome).toBe('written');
  expect(second.events).toEqual(['home']);
  expect(boundDerivations(second.writes.at(-1))).toEqual(['derivation-1', 'derivation-2']);
  expect(second.result.detail).toContain('reused checkpointed planning and 2 page(s)');
  expect(second.result.usage).toMatchObject({ input: 10, output: 2 });
  expect(h.checkpointRow()).toBeUndefined();
});

it('resumes at the page that failed', async () => {
  const h = harness();
  const first = await h.run({ failPageCall: 2 });
  expect(first.result.outcome).toBe('error');
  expect(h.states()).toEqual(['derivation-1:result_staged', 'derivation-2:failed']);

  const second = await h.run();
  expect(second.result.outcome).toBe('written');
  expect(second.events).toEqual(['page', 'home']);
  expect(boundDerivations(second.writes.at(-1))).toEqual(['derivation-1', 'derivation-3']);
  expect(second.result.detail).toContain('reused checkpointed planning and 1 page(s)');
});

it('regenerates a page whose staged derivation can no longer be bound', async () => {
  const h = harness();
  await h.run({ failHome: true });
  h.attempts.get([...h.attempts.keys()][0]!)!.state = 'failed';
  const second = await h.run();
  expect(second.result.outcome).toBe('written');
  expect(second.events).toEqual(['page', 'home']);
  expect(boundDerivations(second.writes.at(-1))).toEqual(['derivation-4', 'derivation-2']);
});

it('regenerates pages whose lease would lapse during the run', async () => {
  const h = harness();
  await h.run({ failHome: true, leaseMs: 5 * 60_000 });
  const second = await h.run();
  expect(second.result.outcome).toBe('written');
  expect(second.events).toEqual(['page', 'page', 'home']);
  expect(second.result.detail).toContain('reused checkpointed planning');
  expect(second.result.detail).not.toContain('page(s)');
});

it('plans again when the inputs changed', async () => {
  const h = harness();
  await h.run({ failHome: true });
  const before = h.checkpointRow()!.fingerprint;
  const second = await h.run({ evidence: 'Different evidence', failHome: true });
  expect(second.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
  expect(second.result.detail).not.toContain('reused');
  expect(h.checkpointRow()!.fingerprint).not.toBe(before);
});

it('starts over after a failed write, since the write may involve the reused pages', async () => {
  const h = harness();
  await h.run({ failHome: true });
  const second = await h.run({ failWrite: true });
  expect(second.result.outcome).toBe('error');
  expect(h.checkpointRow()).toBeUndefined();
  const third = await h.run();
  expect(third.result.outcome).toBe('written');
  expect(third.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
});

it('neither reads nor writes checkpoints on a preview', async () => {
  const h = harness();
  const preview = await h.run({ dryRun: true, failHome: true });
  expect(preview.result.outcome).toBe('error');
  expect(h.checkpointRow()).toBeUndefined();
  await h.run({ failHome: true });
  const second = await h.run({ dryRun: true });
  expect(second.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
  expect(h.checkpointRow()).toBeDefined();
});

it('reuses uncaptured pages when provenance is off', async () => {
  const h = harness();
  await h.run({ failHome: true, tracked: false });
  const second = await h.run({ tracked: false });
  expect(second.result.outcome).toBe('written');
  expect(second.events).toEqual(['home']);
  expect(second.result.detail).toContain('reused checkpointed planning and 2 page(s)');
});

it('does not reuse pages across a provenance setting change', async () => {
  const h = harness();
  await h.run({ failHome: true, tracked: false });
  const second = await h.run();
  expect(second.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
});

it('reports what a written project build wrote and read, for the next build to rewrite from (#352)', async () => {
  const h = harness();
  expect((await h.run({ tracked: false })).result.pageNoteStates).toBeUndefined();
  expect((await h.run({ tracked: false, noteStates: true, dryRun: true })).result.pageNoteStates).toBeUndefined();
  const written = await h.run({ tracked: false, noteStates: true });
  expect(written.result.outcome).toBe('written');
  expect(written.result.pageNoteStates).toEqual({ written: ['page-1', 'page-2'], rewritten: [], notes: { n1: 'c3' } });
});

it('records only pages that got a synthesized body, not a keep that repaired its scope (#352)', () => {
  const wiki: ExistingWiki = { home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 't', catalog_valid: true,
    subpages: [{ id: 'kept', title: 'Kept', file_path: 'Kept.md', version: 1, content_hash: 'k', wiki_state: 'active', wiki_kind: 'freeform',
      wiki_origin: 'automatic', wiki_scope: scope('Kept'), wiki_pinned: false }] };
  const states = pageNoteStatesOf([
    { action: 'adopted', node_id: 'kept' }, { action: 'kept', node_id: 'other' }, { action: 'refreshed', node_id: 'r1' },
    { action: 'reactivated', node_id: 'r2' }, { action: 'created', node_id: 'c1' }, { action: 'created', node_id: 'plan:unwritten' },
    { action: 'merged-target', node_id: 'm1' }, { action: 'merged-source', node_id: 'm0' }, { action: 'retired', node_id: 'x' },
  ], 'home', [{ target: { node_id: 'r1' }, rewrite: true, body: 'b', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  [evidenceNode(), { ...evidenceNode(), id: 'kept', metadata: { content_hash: 'own' } }], wiki);
  expect(states).toEqual({ written: ['r1', 'r2', 'c1', 'm1'], rewritten: ['r1'], notes: { n1: 'c3' } });
});

describe('wiki status around a build (#547)', () => {
  const withHome = (version: number): ExistingWiki => ({ ...existingWiki, home_id: 'home',
    home: { id: 'home', version, wiki_evidence_hash: 'old' } });
  const hooks = (status: 'current' | 'paused' = 'current') => {
    const started: string[] = [];
    const buildStatus: BuildStatusHooks = {
      onBuildStart: async (homeId) => { started.push(homeId); },
      homeStatus: status,
    };
    return { started, buildStatus };
  };
  /** The build's read of its own home, as a status stamp at `version` leaves it. */
  const homeRead = (version: number): EngineNode => ({ id: 'home', title: 'Project Wiki', types: ['wiki'],
    fields: { wiki_status: { value: 'building' } }, body: 'Home prose.', version,
    metadata: { content_hash: 'h-building', file_mtime: version * 1000, indexed_at: version * 1000 },
    provenance_observation: { source: { kind: 'node', namespace: 'vault', native_id: 'home' }, authority: 'engine',
      observed_at: new Date().toISOString(), native_version: version, content_hash: 'h-building',
      hash_semantics: 'engine_content_hash', observation_projection: 'node-token-v2', observation_digest: 'sha256:home-building',
      label: 'Project Wiki', path: 'Home.md' } });

  it('stamps building once the build passes its gates, and writes the home against the version it read', async () => {
    const h = harness();
    const { started, buildStatus } = hooks('paused');

    const run = await h.run({ tracked: false, existingWiki: withHome(7), buildStatus });

    expect(run.result.outcome).toBe('written');
    expect(started).toEqual(['home']);
    // The Engine accepts the status-only versions after 7, and refuses one an edit made in between.
    expect(run.writes.map(write => write.home.expected_version)).toEqual([7, 7]);
    expect(run.writes.map(write => write.home.status)).toEqual(['paused', 'paused']);
  });

  it('stamps nothing on a dry run or a preview', async () => {
    const h = harness();
    const { started, buildStatus } = hooks();

    await h.run({ tracked: false, existingWiki: withHome(7), buildStatus, dryRun: true });

    expect(started).toEqual([]);
  });

  it('stamps nothing when the evidence is unchanged', async () => {
    const h = harness();
    const { started, buildStatus } = hooks();
    const unchanged: ExistingWiki = { ...withHome(7), topology_hash: 'old', home: { id: 'home', version: 7, wiki_evidence_hash: 'hash', wiki_topology_hash: 'old' } };

    const run = await h.run({ tracked: false, existingWiki: unchanged, buildStatus });

    expect(run.result.outcome).not.toBe('written');
    expect(started).toEqual([]);
  });

  it('still reuses a failed build\'s stages after status stamps moved the home\'s version', async () => {
    const h = harness();
    // building (8), then failed (9), then the retry's building (10).
    await h.run({ failHome: true, existingWiki: withHome(7), buildStatus: hooks().buildStatus, homeRead: homeRead(8) });

    const second = await h.run({ existingWiki: withHome(9), buildStatus: hooks().buildStatus, homeRead: homeRead(10) });

    expect(second.result.outcome).toBe('written');
    expect(second.events).toEqual(['home']);
    expect(second.writes.at(-1)?.home.expected_version).toBe(9);
  });

  it('plans again when the home\'s read changed beyond its status stamp', async () => {
    const h = harness();
    await h.run({ failHome: true, existingWiki: withHome(7), buildStatus: hooks().buildStatus, homeRead: homeRead(8) });

    const second = await h.run({ existingWiki: withHome(9), buildStatus: hooks().buildStatus,
      homeRead: { ...homeRead(10), body: 'Home prose, edited.' } });

    expect(second.events).toEqual(['planner', 'adjudicator', 'page', 'page', 'home']);
  });
});

describe('the planner names each page\'s sources (#474 idea 3)', () => {
  const note = (id: string, title: string, hash: string, mtime?: number): EngineNode =>
    ({ id, title, types: ['meeting'], fields: {}, body: `${title} body.`, version: 1, metadata: { content_hash: hash, ...(mtime ? { file_mtime: mtime } : {}) } });
  const root = (): EngineNode => ({ id: 'p', title: 'Project', types: ['project'], fields: {}, body: 'Project note body.', version: 1, metadata: { content_hash: 'root' } });

  it('lists the build\'s notes by id for the planner, without the project note', async () => {
    const h = harness();
    const run = await h.run({ tracked: false, extraNodes: [root(), note('n2', 'Kickoff', 'h2', Date.UTC(2026, 10, 3, 15))] });
    const planner = run.plannerInputs[0];
    expect(planner.user.sources).toEqual([
      { id: 'n1', title: 'Note', types: ['note'] },
      { id: 'n2', title: 'Kickoff', types: ['meeting'], modified: expect.stringMatching(/^2026-11-0[34]$/) },
    ]);
    expect(JSON.stringify(planner.schema)).toContain('evidence_ids');
    expect(planner.system).toContain('evidence_ids');
  });

  it('gives each page writer only the notes the planner named, plus the project note', async () => {
    const h = harness();
    const run = await h.run({ tracked: false, noteStates: true, extraNodes: [root(), note('n2', 'Kickoff', 'h2'), note('n3', 'Pricing call', 'h3')],
      plannerEvidenceIds: { first: ['n2'], second: [] } });
    expect(run.result.outcome).toBe('written');
    const [first, second] = run.pageInputs;
    expect(first.evidence).toContain('[p] Project');
    expect(first.evidence).toContain('[n2] Kickoff');
    expect(first.evidence).not.toContain('[n1] Note');
    expect(first.evidence).not.toContain('[n3] Pricing call');
    // Named none: the writer reads every note, as before.
    for (const id of ['n1', 'n2', 'n3']) expect(second.evidence).toContain(`[${id}]`);
    // A page records only the notes it read, so a note it never read is new to it next time.
    expect(run.result.pageNoteStates).toEqual({ written: ['page-1', 'page-2'], rewritten: [],
      notes: { n1: 'c3', p: 'root', n2: 'h2', n3: 'h3' }, pageNotes: { 'page-1': ['p', 'n2'] } });
  });

  it('sends the planner back to fix an id it made up', async () => {
    const h = harness();
    const run = await h.run({ tracked: false, extraNodes: [note('n2', 'Kickoff', 'h2')], plannerEvidenceIds: { first: ['nope'], second: [] } });
    expect(run.events.filter(event => event === 'planner').length).toBeGreaterThan(1);
  });
});

describe('the planner marks each page\'s rules (#474 idea 4)', () => {
  const memory = (id: number, content: string, source = 'curator'): Memory => ({ id, source, scope: 'vault', node_id: null, content,
    category: 'preference', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' });

  it('lists the build\'s memories about the project for the planner, and writes the marked ones onto the page after a check', async () => {
    const h = harness();
    const run = await h.run({ tracked: false, memories: [memory(1, 'Owner standing note.', 'owner'), memory(7, 'Never call it headless.')],
      firstRuleIds: [7, 404] });
    expect(run.result.outcome).toBe('written');
    expect(run.plannerInputs[0].user.memories).toEqual([{ id: 7, category: 'preference', text: 'Never call it headless.' }]);
    expect(JSON.stringify(run.plannerInputs[0].schema)).toContain('rule_ids');
    expect(run.events).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page', 'home']);
    const summaries = JSON.stringify(run.writes[0]!.pages.map(page => 'sections' in page ? page.sections : null));
    expect(summaries.match(/Never call it headless\. <!-- memory:7 -->/g)).toHaveLength(1);
    expect(summaries.match(/Rules on what to say/g)).toHaveLength(1);
  });

  it('offers no rule_ids when the build has no memories', async () => {
    const h = harness();
    const run = await h.run({ tracked: false });
    expect(run.plannerInputs[0].user.memories).toBeUndefined();
    expect(JSON.stringify(run.plannerInputs[0].schema)).not.toContain('rule_ids');
  });
});

it('plans again when a long memory changed past the part the evidence shows (#474 idea 4)', async () => {
  const h = harness();
  const long = (tail: string): Memory => ({ id: 7, source: 'curator', scope: 'vault', node_id: null, content: `${'x'.repeat(1_200)}${tail}`,
    category: 'preference', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' });
  await h.run({ tracked: false, failHome: true, memories: [long('old ending')] });
  const same = await h.run({ tracked: false, failHome: true, memories: [long('old ending')] });
  expect(same.events[0]).not.toBe('planner');
  const again = await h.run({ tracked: false, memories: [long('new ending')] });
  expect(again.events[0]).toBe('planner');
});

it('writes the rest of the build when one page breaks a rule twice, and says so (#474 idea 4)', async () => {
  const h = harness();
  const rule: Memory = { id: 7, source: 'curator', scope: 'vault', node_id: null, content: 'Never call it headless.', category: 'preference',
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' };
  for (const tracked of [false, true]) {
    const run = await h.run({ tracked, memories: [rule].map(m => tracked ? { ...m, provenance_observation: { source: { kind: 'memory', namespace: 'vault', native_id: '7' },
      authority: 'engine', observed_at: '2026-11-01T00:00:00.000Z', native_version: 1, content_hash: 'm7', hash_semantics: 'engine_content_hash',
      observation_projection: 'memory-token-v1', observation_digest: 'sha256:m7' } as never } : m), firstRuleIds: [7], ruleBreaks: 2 });
    expect(run.result.outcome, run.result.detail).toBe('written');
    expect(run.events).toEqual(['planner', 'adjudicator', 'page', 'rules', 'page', 'rules', 'page', 'home']);
    const written = run.writes.at(-1)!.pages.filter(page => page.op !== 'retire');
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).toContain('Page body');
    expect(run.result.detail).toMatch(/page not created: Project — First breaks a rule on what to say: memory 7/);
  }
});

