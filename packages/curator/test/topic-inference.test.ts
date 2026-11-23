import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { registerWikiRoot } from '../src/db/wiki-roots.js';
import { setPaused } from '../src/db/control.js';
import { replaceExplicitTopicRefreshSources } from '../src/db/topic-refresh.js';
import { CurationQueue } from '../src/queue.js';
import { EngineError, type Engine } from '../src/engine.js';
import { BudgetExhaustedError } from '../src/budget.js';
import { UsageReporter } from '../src/usage-reporter.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { TOPIC_WIKIS_OFF, TOPIC_WIKIS_OFF_MESSAGE, type CoreDeps } from '../src/core.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';
import { proposeTopicWiki, MIN_NOTE_TEXT_CHARS } from '../src/topic-inference.js';
import {
  TOPIC_INFERENCE_NOTE_CHAR_CAP, TOPIC_INFERENCE_SCHEMA, buildTopicInferenceRequest, cleanTopicTitle,
  sanitizeTopicInference, wikiTitleKey,
} from '../src/prompts/topic-inference.js';

const CLIPPING = 'The Metro Owls fired their head coach after a nine-game losing streak. The club named an interim coach '
  + 'and said a search would start at the end of the 2026 season.';

function answer(overrides: Record<string, unknown> = {}) {
  return {
    topic: 'The 2026 Metro Owls',
    brief: 'The Metro Owls in their 2026 season: results, coaching changes and the club\'s direction.',
    confidence: 'high',
    alternatives: [],
    existing_wiki: '',
    ...overrides,
  };
}

function fakeLlm(output: unknown | (() => Promise<unknown>)) {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    configurationFor: () => ({ provider: 'openrouter', reasoningEffort: null }),
    withConfiguration: () => llm,
    structuredCall: vi.fn(async (req: StructuredCallRequest) => {
      requests.push(req);
      return { output: typeof output === 'function' ? await (output as () => Promise<unknown>)() : output,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    }),
  };
  return { llm, requests };
}

const config = {
  model: 'main-model', wikiPlanningModel: 'planning-model', wikiPlanningMaxTokens: 0, homeMaxTokens: 4000,
  wikiPlanningReasoningEffort: 'inherit', activeStatuses: ['open'],
};

function setup(options: {
  node?: Record<string, unknown> | (() => Promise<unknown>);
  output?: unknown | (() => Promise<unknown>);
  activeProjects?: Array<{ id: string; title: string }>;
  usage?: UsageReporter;
  llm?: LlmClient;
} = {}) {
  const db = new Database(':memory:'); runMigrations(db);
  const engine = {
    getNode: vi.fn(async (id: string) => {
      if (typeof options.node === 'function') return options.node();
      return { id, title: 'Why the Owls fired their coach', types: ['clipping'], fields: {}, body: CLIPPING, ...options.node };
    }),
    listActiveProjects: vi.fn(async () => (options.activeProjects ?? []).map(p => ({ ...p, file_path: '', status: 'open' }))),
  };
  const fake = fakeLlm(options.output ?? answer());
  const deps = {
    engine: engine as unknown as Engine, llm: options.llm ?? fake.llm, config: config as never, queue: new CurationQueue(), db,
    ...(options.usage ? { usage: options.usage } : {}),
  } as CoreDeps;
  return { db, engine, deps, requests: fake.requests, llm: fake.llm };
}

function registerTopic(db: Database.Database, title: string, sourceIds: string[] = [], source = 'vault+web') {
  registerWikiRoot(db, { root_title: title, root_node_id: `root-${title}`, kind: 'topic', source, cadence: null, brief: null,
    created_at: '2026-11-01T00:00:00.000Z', created_by: 'test' });
  if (sourceIds.length > 0) replaceExplicitTopicRefreshSources(db, title, sourceIds);
}

function registerProject(db: Database.Database, title: string) {
  registerWikiRoot(db, { root_title: title, root_node_id: `project-${title}`, kind: 'project', source: 'vault', cadence: null,
    brief: null, created_at: '2026-11-01T00:00:00.000Z', created_by: 'test' });
}

describe('topic inference prompt and schema', () => {
  it('keeps the schema compact, with every field required and no nullable values', () => {
    expect(TOPIC_INFERENCE_SCHEMA).toMatchObject({
      required: ['topic', 'brief', 'confidence', 'alternatives', 'existing_wiki'],
      properties: { confidence: { enum: ['high', 'medium', 'low'] } },
    });
    expect(JSON.stringify(TOPIC_INFERENCE_SCHEMA)).not.toMatch(/null|oneOf|anyOf|pattern|minLength/);
  });

  it('builds one fail-closed request with the wiki titles and the note, cut at the cap', () => {
    const req = buildTopicInferenceRequest({ model: 'm', maxTokens: 100, noteTitle: 'A note',
      noteBody: 'x'.repeat(TOPIC_INFERENCE_NOTE_CHAR_CAP + 50), existingWikiTitles: ['Alpha', 'Beta'] });
    expect(req).toMatchObject({ model: 'm', maxTokens: 100, toolName: 'propose_topic', malformedOutputPolicy: 'fail-closed-redacted' });
    expect(req.user).toContain('EXISTING WIKIS: ["Alpha","Beta"]');
    expect(req.user).toContain('NOTE TITLE: A note');
    expect(req.user).toContain('the rest of the note is cut');
    expect(req.user.length).toBeLessThan(TOPIC_INFERENCE_NOTE_CHAR_CAP + 200);
    expect(req.system).toMatch(/untrusted/);
  });

  it('cleans a topic into a safe wiki title that never ends in "Wiki"', () => {
    expect(cleanTopicTitle('  "Owls: the [2026] season / recap"  ')).toBe('Owls the 2026 season recap');
    expect(cleanTopicTitle('Metro Owls Wiki')).toBe('Metro Owls');
    expect(cleanTopicTitle('Metro Owls wiki wiki.')).toBe('Metro Owls');
    expect(cleanTopicTitle(`${'Long '.repeat(40)}name`).length).toBeLessThanOrEqual(100);
    expect(cleanTopicTitle(42)).toBe('');
  });

  it('compares titles loosely for a match', () => {
    expect(wikiTitleKey('The 2026 Metro Owls')).toBe(wikiTitleKey('2026 metro owls'));
    expect(wikiTitleKey('Café Rivals Wiki')).toBe(wikiTitleKey('cafe rivals'));
    expect(wikiTitleKey('Owls')).not.toBe(wikiTitleKey('Metro Owls'));
  });

  it('sanitizes the model answer: defaults, deduplicated alternatives, and no usable topic as null', () => {
    expect(sanitizeTopicInference(answer({
      confidence: 'certain',
      alternatives: [{ topic: 'the 2026 metro owls', brief: 'dup' }, { topic: 'Coaching changes', brief: ' b ' },
        { topic: 'Coaching Changes', brief: 'dup' }, null, { topic: '' }, { topic: 'A', brief: '' }, { topic: 'B' }, { topic: 'C' }],
      existing_wiki: 7,
    }))).toEqual({
      topic: 'The 2026 Metro Owls', brief: answer().brief, confidence: 'low',
      alternatives: [{ topic: 'Coaching changes', brief: 'b' }, { topic: 'A', brief: '' }, { topic: 'B', brief: '' }],
      existingWiki: '',
    });
    expect(sanitizeTopicInference(answer({ topic: ' :: ' }))).toBeNull();
    expect(sanitizeTopicInference('The Owls')).toBeNull();
    expect(sanitizeTopicInference(null)).toBeNull();
  });
});

describe('proposeTopicWiki', () => {
  it('proposes the implied topic with one planning-model call and offers a paused vault+web create', async () => {
    const { deps, requests, engine } = setup();
    const res = await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({
      ok: true, dry_run: false, node: { id: 'clip-1', title: 'Why the Owls fired their coach' },
      topic: 'The 2026 Metro Owls', brief: answer().brief, confidence: 'high', alternatives: [], existing_wiki: null,
      next: { create: { topic: 'The 2026 Metro Owls', brief: answer().brief, source: 'vault+web', source_node_ids: ['clip-1'], paused: true } },
      model: 'planning-model',
    });
    expect(res.ok && !res.dry_run && res.next.add_source).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'planning-model', maxTokens: 4000 });
    expect(engine.getNode).toHaveBeenCalledWith('clip-1', { includeEmbeds: false });
  });

  it('records the call under the topic-inference purpose', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const usage = new UsageReporter({ recordUsage: async (args: Record<string, unknown>) => { recorded.push(args); } },
      { provider: 'openrouter', experiment: null, variant: null });
    const inner = fakeLlm(answer()).llm;
    const { deps } = setup({ usage, llm: usage.wrap(inner) });
    await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false });
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({ service: 'curator', purpose: 'topic-inference', model: 'planning-model', source_ref: 'topic-inference' });
  });

  it('dry_run runs the free checks and names the model without calling it', async () => {
    const { deps, requests } = setup();
    expect(await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: true })).toMatchObject({
      ok: true, dry_run: true, model: 'planning-model', node: { id: 'clip-1' },
    });
    expect(requests).toHaveLength(0);
  });

  it('refuses a wiki page plainly, before any call, so no "<topic> Wiki Wiki" is proposed', async () => {
    const byField = setup({ node: { title: 'Owls — Roster', fields: { wiki_for: { value: '[[The 2026 Metro Owls]]' } } } });
    expect(await proposeTopicWiki(byField.deps, { nodeId: 'page-1', dryRun: false })).toMatchObject({
      ok: false, error: { code: 'NODE_IS_A_WIKI_PAGE' },
    });
    expect(byField.requests).toHaveLength(0);

    const byTitle = setup({ node: { title: 'The 2026 Metro Owls Wiki' } });
    registerTopic(byTitle.db, 'The 2026 Metro Owls');
    const res = await proposeTopicWiki(byTitle.deps, { nodeId: 'home-1', dryRun: true });
    expect(res).toMatchObject({ ok: false, error: { code: 'NODE_IS_A_WIKI_PAGE' } });
    expect(!res.ok && res.error.message).toContain('topic "The 2026 Metro Owls"');
    expect(byTitle.requests).toHaveLength(0);

    const projectHome = setup({ node: { title: 'Atlas Wiki' }, activeProjects: [{ id: 'p1', title: 'Atlas' }] });
    expect(await proposeTopicWiki(projectHome.deps, { nodeId: 'home-2', dryRun: false })).toMatchObject({
      ok: false, error: { code: 'NODE_IS_A_WIKI_PAGE' },
    });
    expect(projectHome.requests).toHaveLength(0);
  });

  it('refuses a note with too little text before any call', async () => {
    const { deps, requests } = setup({ node: { body: '  Owls   lost again. ' } });
    const res = await proposeTopicWiki(deps, { nodeId: 'short-1', dryRun: false });
    expect(res).toMatchObject({ ok: false, error: { code: 'TOO_LITTLE_TEXT' } });
    expect(!res.ok && res.error.message).toContain(`at least ${MIN_NOTE_TEXT_CHARS}`);
    expect(requests).toHaveLength(0);
  });

  it('reports a missing note and an unreachable Engine without a call', async () => {
    const missing = setup({ node: async () => { throw new EngineError('NOT_FOUND', 'no node'); } });
    expect(await proposeTopicWiki(missing.deps, { nodeId: 'gone', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
    const down = setup({ node: async () => { throw new Error('socket hang up'); } });
    expect(await proposeTopicWiki(down.deps, { nodeId: 'x', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
    expect(missing.requests.length + down.requests.length).toBe(0);
  });

  it('refuses before any read or call when the topic kind is none', async () => {
    const { deps, engine, requests } = setup();
    const off = { ...deps, config: { ...(deps.config as object), vault: { ...(defaultsFor('vault') as unknown as VaultSettings), topicType: null } } } as CoreDeps;
    for (const dryRun of [true, false]) {
      expect(await proposeTopicWiki(off, { nodeId: 'clip-1', dryRun }))
        .toEqual({ ok: false, error: { code: TOPIC_WIKIS_OFF, message: `${TOPIC_WIKIS_OFF_MESSAGE} Nothing was called or created.` } });
    }
    expect(engine.getNode).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('requires the curator DB', async () => {
    const { deps } = setup();
    expect(await proposeTopicWiki({ ...deps, db: undefined }, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'NO_DB' } });
  });

  it('offers adding the note to a topic wiki of the same name, keeping its sources, and no duplicate create', async () => {
    const { deps, db, requests } = setup();
    registerTopic(db, 'The 2026 Metro Owls', ['older-1', 'older-2']);
    setPaused(db, 'The 2026 Metro Owls', true, null, '2026-11-07T00:00:00.000Z');
    const res = await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({
      ok: true,
      existing_wiki: { title: 'The 2026 Metro Owls', kind: 'topic', matched_by: 'title', paused: true, source: 'vault+web',
        source_node_ids: ['older-1', 'older-2'], note_is_source: false },
    });
    expect(res.ok && !res.dry_run && res.next.add_source).toEqual({ topic: 'The 2026 Metro Owls', add_source_node_ids: ['clip-1'] });
    expect(res.ok && !res.dry_run && res.next.create).toBeUndefined();
    expect(requests[0]!.user).toContain('"The 2026 Metro Owls"');
  });

  it('treats a loosely equal title as the same name: add the note there, no near-duplicate create', async () => {
    const { deps, db } = setup();
    registerTopic(db, '2026 metro owls', [], 'vault');
    const res = await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({
      ok: true, existing_wiki: { title: '2026 metro owls', matched_by: 'title', source: 'vault', paused: false },
      next: { add_source: { topic: '2026 metro owls', add_source_node_ids: ['clip-1'] } },
    });
    expect(res.ok && !res.dry_run && res.next.create).toBeUndefined();
    expect(res.ok && res.detail).toContain('different topic');
  });

  it('sees a wiki registered while the model ran', async () => {
    let db!: Database.Database;
    const { deps, db: opened } = setup({ output: async () => {
      registerTopic(db, 'The 2026 Metro Owls');
      return answer();
    } });
    db = opened;
    expect(await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: true, existing_wiki: { title: 'The 2026 Metro Owls' }, next: { add_source: {} } });
  });

  it('offers no create named after the note itself, which would reuse the note as the wiki root (#387)', async () => {
    const { deps } = setup({
      node: { title: 'Metro Owls', types: ['topic'] },
      output: answer({ topic: 'metro owls', alternatives: [{ topic: 'Metro Owls', brief: 'x' }, { topic: 'The 2026 Metro Owls', brief: 'y' }] }),
    });
    const res = await proposeTopicWiki(deps, { nodeId: 'topic-note', dryRun: false });
    expect(res).toMatchObject({ ok: true, topic: 'metro owls', existing_wiki: null,
      alternatives: [{ topic: 'The 2026 Metro Owls', brief: 'y' }] });
    expect(res.ok && !res.dry_run && res.next).toEqual({});
    expect(res.ok && res.detail).toContain('own title');
    expect(res.ok && res.detail).toContain('source_node_ids ["topic-note"]');
  });

  it('tells the model not to reuse the note\'s title', () => {
    expect(buildTopicInferenceRequest({ model: 'm', maxTokens: 1, noteTitle: 'n', noteBody: 'b', existingWikiTitles: [] }).system)
      .toMatch(/Never use the note's own title/);
  });

  it('refuses the topic note of a registered topic wiki before any call', async () => {
    const { deps, db, requests } = setup();
    registerTopic(db, 'The 2026 Metro Owls');
    const res = await proposeTopicWiki(deps, { nodeId: 'root-The 2026 Metro Owls', dryRun: false });
    expect(res).toMatchObject({ ok: false, error: { code: 'NODE_HAS_A_WIKI' } });
    expect(requests).toHaveLength(0);
  });

  it('accepts the model\'s named match only when it is a registered wiki', async () => {
    const named = setup({ output: answer({ topic: 'Metro Owls coaching', existing_wiki: 'The 2026 Metro Owls' }) });
    registerTopic(named.db, 'The 2026 Metro Owls');
    expect(await proposeTopicWiki(named.deps, { nodeId: 'clip-1', dryRun: false })).toMatchObject({
      ok: true, existing_wiki: { title: 'The 2026 Metro Owls', matched_by: 'model' },
      next: { create: { topic: 'Metro Owls coaching' } },
    });

    const invented = setup({ output: answer({ existing_wiki: 'Owls Fan Club' }) });
    registerTopic(invented.db, 'Harbor Lights');
    expect(await proposeTopicWiki(invented.deps, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: true, existing_wiki: null });
  });

  it('says when the note is already a source, and when the matched wiki has no room for another', async () => {
    const already = setup();
    registerTopic(already.db, 'The 2026 Metro Owls', ['clip-1']);
    const res = await proposeTopicWiki(already.deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({ ok: true, existing_wiki: { note_is_source: true } });
    expect(res.ok && !res.dry_run && res.next).toEqual({});
    expect(res.ok && res.detail).toContain('already a source');

    const full = setup();
    registerTopic(full.db, 'The 2026 Metro Owls', Array.from({ length: 20 }, (_, i) => `s${i}`));
    const fullRes = await proposeTopicWiki(full.deps, { nodeId: 'clip-1', dryRun: false });
    expect(fullRes.ok && !fullRes.dry_run && fullRes.next).toEqual({});
    expect(fullRes.ok && fullRes.detail).toContain('maximum 20 sources');
  });

  it('matches a project wiki without offering a source add, or a create that would collide with it', async () => {
    const { deps, db } = setup({ output: answer({ topic: 'Atlas' }) });
    registerProject(db, 'Atlas');
    const res = await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({ ok: true, existing_wiki: { title: 'Atlas', kind: 'project', matched_by: 'title', paused: false } });
    expect(res.ok && !res.dry_run && res.next).toEqual({});
    expect(res.ok && !res.dry_run && res.existing_wiki).not.toHaveProperty('source_node_ids');
    expect(res.ok && res.detail).toContain('takes no listed sources');
  });

  it('passes a daily-budget refusal through by code', async () => {
    const { deps } = setup({ output: async () => { throw new BudgetExhaustedError('daily budget: $1.0000 spent of $1.00'); } });
    expect(await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'DAILY_BUDGET_EXHAUSTED' } });
  });

  it('fails closed on a provider failure or an answer with no usable topic', async () => {
    const failed = setup({ output: async () => { throw new StructuredCallFailure('raw provider text', undefined, 'malformed_json'); } });
    const res = await proposeTopicWiki(failed.deps, { nodeId: 'clip-1', dryRun: false });
    expect(res).toMatchObject({ ok: false, error: { code: 'INFERENCE_FAILED' } });
    expect(!res.ok && res.error.message).toContain('malformed_json');
    expect(!res.ok && res.error.message).not.toContain('raw provider text');

    const empty = setup({ output: answer({ topic: '' }) });
    expect(await proposeTopicWiki(empty.deps, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'INFERENCE_FAILED' } });
  });

  it('refuses when the planning model cannot be configured, before any call', async () => {
    const llm: LlmClient = { structuredCall: vi.fn() };
    const { deps } = setup({ llm });
    expect(await proposeTopicWiki(deps, { nodeId: 'clip-1', dryRun: false }))
      .toMatchObject({ ok: false, error: { code: 'MODEL_UNAVAILABLE' } });
    expect(llm.structuredCall).not.toHaveBeenCalled();
  });
});
