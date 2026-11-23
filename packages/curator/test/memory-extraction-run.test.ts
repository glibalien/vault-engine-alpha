import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ModelPricing } from '@vault/pricing';
import { createRunBudget, DailyBudget, type DailyBudgetPolicy, type RunBudgetFactory } from '../src/budget.js';
import type { Config } from '../src/config.js';
import type { CoreDeps } from '../src/core.js';
import { ledgerHash, upsertLedger } from '../src/db/memory-sweep.js';
import { runMigrations } from '../src/db/migrate.js';
import { EngineError, type Engine, type MemoryState } from '../src/engine.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from '../src/llm/types.js';
import {
  EXTRACTION_RUN_LIMITS,
  extractionStatus,
  normalizeExtractionRequest,
  previewExtraction,
  recordedWrite,
  startExtraction,
  undoExtraction,
} from '../src/memory-extraction/run.js';
import { EXTRACT_SYSTEM_PROMPT } from '../src/memory-sweep.js';
import type { OnDemandDeps } from '../src/on-demand/run.js';
import { viewOnDemandRun } from '../src/on-demand/views.js';
import { CurationQueue } from '../src/queue.js';
import { makeExtractMemoriesHandler } from '../src/tools/extract-memories.js';

const MODEL = 'accounts/fireworks/models/small';
const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
const USAGE = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
/** One extraction call at PRICE: 1,000 input and 100 output tokens. */
const CALL_USD = 0.002;
/** What the fake Engine says each consolidation check of a written memory cost. */
const CHECK_USD = 0.0005;

const CONFIG = {
  model: 'home-model',
  memorySweepModel: MODEL,
  memorySweepMaxTokens: 4000,
  memorySweepNoteCap: 3,
  memorySweepTypes: ['meeting'],
  memorySweepPaths: ['Journal'],
  reverifyEnabled: true,
  bodyCharCap: null,
  modelProviders: { [MODEL]: 'fireworks' },
  modelPricing: { [MODEL]: PRICE },
  vault: { ownerNote: 'Avery Stone', dateField: 'date', wikiType: 'wiki' },
  curatorTz: 'UTC',
  journalEnabled: false,
} as unknown as Config;

interface FakeNote { id: string; title: string; file_path: string; types: string[]; body: string; hash: string | null }
interface FakeMemory extends MemoryState { evidence_node_id: string | null; evidence_hash: string | null; updated_at?: string }

const note = (id: string, title: string, body: string, opts: { types?: string[]; path?: string; hash?: string | null } = {}): FakeNote => ({
  id, title, file_path: opts.path ?? `Meetings/${title}.md`, types: opts.types ?? ['meeting'], body, hash: opts.hash === undefined ? `hash-${id}` : opts.hash,
});

/** Three meetings, a project the allowlist keeps out, and a journal page under an allowlisted folder. */
const fiveNotes = (): FakeNote[] => [
  note('m1', 'Kickoff', 'FACT: Dana Whitfield leads the Acme renewal.\nFACT: Acme wants a two-year term.'),
  note('m2', 'Standup', 'Nothing durable here.'),
  note('m3', 'Pricing call', 'FACT: Acme pays annually.'),
  note('p1', 'Acme Renewal', 'FACT: A project fact.', { types: ['project'], path: 'Projects/Acme Renewal.md' }),
  note('j1', 'Curator Journal — 2026-11', 'FACT: A journal fact.', { types: [], path: 'Journal/Curator Journal — 2026-11.md' }),
];

/**
 * An Engine over notes and memories in memory. create-memory adds a memory unless told otherwise
 * for its text: `verdicts` makes it a noop, an update (replacing a memory) or a duplicate, and
 * `checkFailure` adds it unchecked with that failure, as when the Engine's key is spent.
 */
function engineOf(notes: FakeNote[], options: {
  memories?: FakeMemory[];
  verdicts?: Record<string, { op: 'noop'; target?: number } | { op: 'update'; target: number } | { op: 'duplicate' }>;
  checkFailure?: Record<string, string>;
  /** What the Engine's checks cost on average lately, as its usage report says. */
  checkAverageUsd?: number;
} = {}) {
  const byId = new Map(notes.map(each => [each.id, each]));
  let clock = 0;
  const tick = (): string => `2026-11-20T12:00:${String(clock++).padStart(2, '0')}.000Z`;
  const memories = new Map((options.memories ?? []).map(each => [each.id, { ...each, updated_at: each.updated_at ?? tick() }]));
  let nextId = 100;
  const average = options.checkAverageUsd ?? 0.0005;
  const live = (each: FakeMemory) => each.expired_at === null;
  const engine = {
    listNotesWithHashes: vi.fn(async (args: { filter?: Record<string, unknown>; keep?: (n: never) => boolean; maxNodes: number }) => {
      const types = args.filter?.['types'] as string[] | undefined;
      const prefix = args.filter?.['path_prefix'] as string | undefined;
      const nodes = notes
        .filter(each => (types === undefined || types.every(type => each.types.includes(type))) && (prefix === undefined || each.file_path.startsWith(prefix)))
        .map(each => ({ id: each.id, title: each.title, file_path: each.file_path, types: each.types, version: 1, content_hash: each.hash }))
        .filter(each => args.keep === undefined || args.keep(each as never));
      return { nodes, truncated: false };
    }),
    getNode: vi.fn(async (id: string) => {
      const found = byId.get(id);
      if (found === undefined) throw new EngineError('NOT_FOUND', `no node ${id}`);
      return { id, title: found.title, file_path: found.file_path, types: found.types, body: found.body, fields: {}, metadata: found.hash === null ? {} : { content_hash: found.hash } };
    }),
    listMemories: vi.fn(async (filters: { evidence_node_id?: string }) =>
      [...memories.values()].filter(each => live(each) && each.evidence_node_id === filters.evidence_node_id)
        .map(each => ({ id: each.id, content: each.content, source: 'curator', scope: 'vault', node_id: null, category: 'fact', created_at: '', updated_at: '' }))),
    listMemoriesWithTotal: vi.fn(async () => ({ memories: [], total: 0 })),
    createMemory: vi.fn(async (args: { content: string; evidence?: { node_id?: string; hash?: string }; usage?: { runRef: string; sourceRef?: string } },
      opts: { onSpend?: (usd: number | null) => void; journal?: boolean } = {}) => {
      opts.onSpend?.(CHECK_USD);
      const verdict = options.verdicts?.[args.content];
      if (verdict?.op === 'duplicate') throw new EngineError('DUPLICATE_MEMORY', 'near-duplicate');
      if (verdict?.op === 'noop') {
        // The same fact: the Engine adds the new fact's subjects to the existing memory, which moves it.
        if (verdict.target !== undefined) Object.assign(memories.get(verdict.target)!, { updated_at: tick() });
        return { id: verdict.target ?? 1, operation: 'noop' as const, superseded: [] };
      }
      const id = nextId++;
      const updatedAt = tick();
      memories.set(id, {
        id, content: args.content, expired_at: null, expire_reason: null, superseded_by: null, updated_at: updatedAt,
        evidence_node_id: args.evidence?.node_id ?? null, evidence_hash: args.evidence?.hash ?? null,
      });
      const failure = options.checkFailure?.[args.content];
      if (verdict?.op === 'update') {
        const old = memories.get(verdict.target)!;
        Object.assign(old, { expired_at: '2026-11-20T12:00:00Z', expire_reason: 'superseded-by-update', superseded_by: id, updated_at: tick() });
        return { id, operation: 'update' as const, superseded: [verdict.target], updatedAt };
      }
      return { id, operation: 'add' as const, superseded: [], updatedAt, ...(failure === undefined ? {} : { consolidationFailure: failure }) };
    }),
    getMemoryState: vi.fn(async (id: number) => {
      const found = memories.get(id);
      return found === undefined ? null : { ...found };
    }),
    retireMemory: vi.fn(async (id: number, reason: string) => {
      const found = memories.get(id)!;
      Object.assign(found, { expired_at: '2026-11-20T13:00:00Z', expire_reason: reason, updated_at: tick() });
      return { ...found };
    }),
    reactivateMemory: vi.fn(async (id: number) => {
      const found = memories.get(id)!;
      Object.assign(found, { expired_at: null, expire_reason: null, superseded_by: null, updated_at: tick() });
      return { ...found };
    }),
    /** Someone else's change to a memory: it moves `updated_at`, as every Engine change does. */
    touch: (id: number, change: Partial<FakeMemory> = {}) => { Object.assign(memories.get(id)!, change, { updated_at: tick() }); },
    usageReport: vi.fn(async (args: Record<string, unknown>) => (args['purpose'] === 'memory-consolidation'
      ? { data: { groups: [{ provider: 'openrouter', events: 40, cost_usd: 40 * average }], totals: { events: 40, cost_usd: 40 * average } }, warnings: [] }
      : { data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] })),
  };
  return { engine, memories, notes: byId };
}

/**
 * Keeps each "FACT: " line of a note as a fact, up to the stated cap, and says a re-checked fact
 * is no longer supported when the note has a "DROPPED: <id>" line.
 */
function extractingModel() {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    structuredCall: vi.fn(async (request: StructuredCallRequest): Promise<StructuredCallResult> => {
      requests.push(request);
      const cap = Number(/PER-NOTE CAP: at most (\d+) facts/.exec(request.user)?.[1] ?? 0);
      const facts = [...request.user.matchAll(/^FACT: (.+)$/gm)].map(match => ({ content: match[1]!, category: 'fact', subjects: [] })).slice(0, cap);
      const dropped = [...request.user.matchAll(/^DROPPED: (\d+)$/gm)].map(match => Number(match[1]));
      return { output: { facts, unsupported_ids: dropped }, usage: USAGE };
    }),
  };
  return { llm, requests };
}

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(notes: FakeNote[], options: Parameters<typeof engineOf>[1] & { config?: Partial<Config> } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  databases.push(db);
  const store = engineOf(notes, options);
  const model = extractingModel();
  const config = { ...CONFIG, ...options.config } as Config;
  const policy: DailyBudgetPolicy = { capUsd: 1, tz: 'UTC', pricing: name => config.modelPricing?.[name] ?? null };
  const runBudget: RunBudgetFactory = run => createRunBudget({
    llm: model.llm, policy, engine: store.engine as unknown as Engine, limitUsd: run.limitUsd, runRef: run.runRef, budgets: new Set<DailyBudget>(),
  });
  const deps: OnDemandDeps = {
    engine: store.engine as unknown as Engine, llm: model.llm, config, queue: new CurationQueue(), db, recorder: new ActionRecorder(db), runBudget,
  };
  return { deps, db, requests: model.requests, ...store };
}

const liveContents = (memories: Map<number, FakeMemory>): string[] =>
  [...memories.values()].filter(each => each.expired_at === null).map(each => each.content).sort();

describe('the request', () => {
  it('takes query-nodes filters without search or joins, and a facts-per-note cap', () => {
    expect(normalizeExtractionRequest({ query: { types: ['meeting'] }, facts_per_note: 5 })).toEqual({ query: { types: ['meeting'] }, facts_per_note: 5 });
    expect(normalizeExtractionRequest({ query: {} })).toEqual({});
    expect(() => normalizeExtractionRequest({ query: { query: 'acme' } })).toThrow(/query is not taken here/);
    expect(() => normalizeExtractionRequest({ query: { join_filters: [] } })).toThrow(/join_filters is not taken here/);
    expect(() => normalizeExtractionRequest({ facts_per_note: 11 })).toThrow(/from 1 to 10/);
    expect(() => normalizeExtractionRequest({ facts_per_note: 0 })).toThrow(/from 1 to 10/);
  });

  it('reads writes back from their recorded form', () => {
    expect(recordedWrite('memory:101')).toEqual({ kind: 'memory', id: 101, replaced: [], at: null });
    expect(recordedWrite('memory:101@2026-11-20T12:00:01.000Z')).toEqual({ kind: 'memory', id: 101, replaced: [], at: '2026-11-20T12:00:01.000Z' });
    expect(recordedWrite('memory:102:replaced:7,9@2026-11-20T12:00:02.000Z')).toEqual({ kind: 'memory', id: 102, replaced: [7, 9], at: '2026-11-20T12:00:02.000Z' });
    expect(recordedWrite('retired:5@2026-11-20T12:00:03.000Z')).toEqual({ kind: 'retired', id: 5, at: '2026-11-20T12:00:03.000Z' });
    expect(recordedWrite('typed:5')).toBeNull();
  });
});

describe('previewExtraction', () => {
  it('counts the allowlisted notes not yet read, and shows what the model would keep from a sample, writing nothing', async () => {
    const { deps, db, requests, memories, engine } = setup(fiveNotes());
    // The nightly sweep read the standup at its current text already.
    upsertLedger(db, 'm2', 'hash-m2', '2026-11-19T05:00:00Z');
    const { preview } = await previewExtraction(deps, { sample: 5 });

    expect(preview).toMatchObject({
      notes: 2, already_read: 1, outside_allowlist: 1, never_read: 1, allowlist: { types: ['meeting'], paths: ['Journal'] }, facts_per_note: 3,
      model: MODEL, provider: 'fireworks', sample_asked: 2,
    });
    expect(preview.sample).toEqual([
      { id: 'm1', title: 'Kickoff', path: 'Meetings/Kickoff.md', no_longer_supported: 0,
        facts: [{ content: 'Dana Whitfield leads the Acme renewal.', category: 'fact' }, { content: 'Acme wants a two-year term.', category: 'fact' }] },
      { id: 'm3', title: 'Pricing call', path: 'Meetings/Pricing call.md', no_longer_supported: 0,
        facts: [{ content: 'Acme pays annually.', category: 'fact' }] },
    ]);
    expect(preview.scope_note).toContain('1 more note(s) match but are outside what the memory sweep reads (kinds meeting; folders Journal');
    // The journal sits under an allowlisted folder and is still never read.
    expect(preview.scope_note).toContain('1 more note(s) match but are wiki pages, notes in the settings folder or the Curator\'s journal');
    expect(preview.scope_note).toContain('1 more note(s) match but were already read');
    // Both shares: the model's (a call a note), and at most one Engine check a fact at its recent average.
    expect(preview.sample_cost_usd).toBeCloseTo(2 * CALL_USD, 10);
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect(preview.engine).toMatchObject({ provider: 'openrouter', per_check_usd: 0.0005, estimated_usd: 0.01 });
    expect(preview.estimated_total_usd).toBe(0.02);

    // The sweep's own instructions, with the caller's cap.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.system.startsWith(EXTRACT_SYSTEM_PROMPT)).toBe(true);
    expect(requests[0]!.user).toContain('PER-NOTE CAP: at most 3 facts.');
    expect(requests[0]!.user.startsWith('VAULT OWNER')).toBe(true);
    // Nothing written, nothing marked read, no run.
    expect(engine.createMemory).not.toHaveBeenCalled();
    expect(memories.size).toBe(0);
    expect(ledgerHash(db, 'm1')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 0 });
  });

  it("averages the Engine's checks over live checks and runs' own, and calls the figure an estimate (#707)", async () => {
    const { deps, engine } = setup(fiveNotes());
    engine.usageReport.mockImplementation(async (args: Record<string, unknown>) => (args['purpose'] === 'memory-consolidation'
      ? { data: { groups: [{ provider: 'openrouter', events: 40, cost_usd: 0.02 }], totals: { events: 40, cost_usd: 0.02 } }, warnings: [] }
      : args['purpose'] === 'memory-consolidation-run'
        ? { data: { groups: [{ provider: 'openrouter', events: 10, cost_usd: 0.025 }], totals: { events: 10, cost_usd: 0.025 } }, warnings: [] }
        : { data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] }));
    const { preview } = await previewExtraction(deps, { sample: 5 });
    expect(engine.usageReport.mock.calls.map(([args]) => (args as Record<string, unknown>)['purpose']).sort())
      .toEqual(['memory-consolidation', 'memory-consolidation-run']);
    // (0.02 + 0.025) / 50 checks.
    expect(preview.engine).toMatchObject({ provider: 'openrouter', per_check_usd: 0.0009 });
    expect(preview.engine.note).toContain('This is an estimate, not a ceiling');
    expect(preview.engine.note).not.toContain('the most it should come to');
  });

  it("counts the Engine's writes in the minutes: the sample times only the model's calls (#707)", async () => {
    const { deps } = setup(fiveNotes());
    const { preview } = await previewExtraction(deps, { sample: 5 });
    // The fake model answers at once, so its calls give the one-minute floor; 3 expected facts at
    // 20 seconds a write add one more.
    expect(EXTRACTION_RUN_LIMITS.engineWriteSeconds).toBe(20);
    expect(preview.estimated_minutes).toBe(2);
  });

  it('says why a query with several kinds in types matched nothing (#707)', async () => {
    const { deps } = setup(fiveNotes(), { config: { memorySweepTypes: [], memorySweepPaths: [] } });
    const both = await previewExtraction(deps, { query: { types: ['meeting', 'project'] }, sample: 0 });
    expect(both.preview.notes).toBe(0);
    expect(both.preview.scope_note).toContain('No note has all of the kinds in types (meeting, project): types means every one of them, not any.');
    const one = await previewExtraction(deps, { query: { types: ['meeting'] }, sample: 0 });
    expect(one.preview.notes).toBe(3);
    expect(one.preview.scope_note ?? '').not.toContain('No note has all of the kinds');
  });

  it('narrows by the query, and with no allowlist (a new install) lets the query decide, never reading the suite\'s own writing', async () => {
    const { deps } = setup(fiveNotes());
    const { preview } = await previewExtraction(deps, { query: { path_prefix: 'Projects/' }, sample: 0 });
    expect(preview).toMatchObject({ notes: 0, outside_allowlist: 1 });

    const suiteWriting = [
      note('w1', 'Acme Renewal Wiki', 'FACT: A wiki fact.', { types: ['wiki'], path: 'Wikis/Acme Renewal Wiki.md' }),
      note('s1', 'Curator', 'FACT: A settings fact.', { types: [], path: 'Settings/Curator.md' }),
    ];
    const empty = setup([...fiveNotes(), ...suiteWriting], { config: { memorySweepTypes: [], memorySweepPaths: [] } as Partial<Config> });
    const open = (await previewExtraction(empty.deps, { sample: 0 })).preview;
    // The project note is read now; the wiki page, the settings note and the journal are not.
    expect(open).toMatchObject({ notes: 4, outside_allowlist: 0, never_read: 3, allowlist: null });
    const { run } = await startExtraction(empty.deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', notes: 4, counts: { asked: 4, created: 4 } });
    expect(liveContents(empty.memories)).toContain('A project fact.');
    expect(liveContents(empty.memories)).not.toContain('A wiki fact.');
  });
});

describe('a run', () => {
  it('writes the facts, pays for the Engine\'s checks from its limit, marks the notes read, and undoes as one request', async () => {
    const { deps, db, memories, engine } = setup(fiveNotes(), { verdicts: { 'Acme pays annually.': { op: 'noop' } } });
    const { run, started } = await startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(started).toBe(true);
    expect(run).toMatchObject({
      job: 'extract-memories', status: 'completed', notes: 3, detail: null,
      counts: { asked: 3, with_facts: 2, facts: 3, created: 2, replaced: 0, already_known: 1, duplicates: 0, errors: 0, retired: 0 },
    });
    expect(run.counts.engine_usd).toBeCloseTo(3 * CHECK_USD, 10);
    // The run's spend is its three calls and the Engine's three checks.
    expect(run.spent_usd).toBeCloseTo(3 * CALL_USD + 3 * CHECK_USD, 10);
    expect(liveContents(memories)).toEqual(['Acme wants a two-year term.', 'Dana Whitfield leads the Acme renewal.']);
    // Each write named the run and its source, kept out of the journal, and charged the run.
    for (const [args, opts] of engine.createMemory.mock.calls) {
      expect(args.usage).toEqual({ runRef: run.id, sourceRef: 'memory-extraction-run', purpose: 'memory-consolidation-run' });
      expect(opts).toMatchObject({ journal: false });
      expect(typeof opts?.onSpend).toBe('function');
    }
    expect(['m1', 'm2', 'm3'].map(id => ledgerHash(db, id))).toEqual(['hash-m1', 'hash-m2', 'hash-m3']);

    // Read notes are not in the next run's scope.
    await expect(startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'NOTHING_TO_DO', message: expect.stringContaining('3 were already read'),
    });
    expect(extractionStatus(deps, run.id)).toMatchObject({ run: { run_id: run.id, job: 'extract-memories', notes: 3, undoable_memories: 2 } });
    expect(viewOnDemandRun(db, run)).toMatchObject({ job: 'extract-memories' });

    const dry = await undoExtraction(deps, run.id, true);
    expect(dry).toMatchObject({ dry_run: true, restored: 2, conflict_count: 0, no_longer_undoable: 0 });
    expect(liveContents(memories)).toHaveLength(2);

    const undone = await undoExtraction(deps, run.id, false);
    expect(undone).toMatchObject({ dry_run: false, restored: 2, conflict_count: 0 });
    expect(liveContents(memories)).toEqual([]);
    // The note it took memories from is read again by a later run; the ones it took none from stay read.
    expect(['m1', 'm2', 'm3'].map(id => ledgerHash(db, id))).toEqual([undefined, 'hash-m2', 'hash-m3']);
    expect((await previewExtraction(deps, { sample: 0 })).preview).toMatchObject({ notes: 1, already_read: 2 });
  });

  it('retires the earlier facts a changed note no longer supports, brings back what it replaced on undo, and leaves memories changed since', async () => {
    const notes = [note('m1', 'Kickoff', 'FACT: Acme renews in March.\nDROPPED: 7'), note('m3', 'Pricing call', 'FACT: Acme pays quarterly.')];
    const prior: FakeMemory[] = [
      { id: 7, content: 'Acme renews in January.', expired_at: null, expire_reason: null, superseded_by: null, evidence_node_id: 'm1', evidence_hash: 'old-m1' },
      { id: 8, content: 'Acme pays annually.', expired_at: null, expire_reason: null, superseded_by: null, evidence_node_id: 'm9', evidence_hash: 'h9' },
    ];
    const { deps, memories, requests } = setup(notes, { memories: prior, verdicts: { 'Acme pays quarterly.': { op: 'update', target: 8 } } });
    const { run } = await startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ asked: 2, facts: 2, created: 1, replaced: 1, retired: 1 });
    // The changed note's earlier fact was shown to the model for re-checking.
    expect(requests[0]!.user).toContain('PREVIOUSLY EXTRACTED FROM THIS NOTE (verify)');
    expect(requests[0]!.user).toContain('[id 7] Acme renews in January.');
    expect(liveContents(memories)).toEqual(['Acme pays quarterly.', 'Acme renews in March.']);

    // Someone retired the run's new March memory since: it, and nothing else of it, is left alone.
    const march = [...memories.values()].find(each => each.content === 'Acme renews in March.')!;
    Object.assign(march, { expired_at: '2026-11-20T14:00:00Z', expire_reason: 'deleted' });
    const undone = await undoExtraction(deps, run.id, false);
    expect(undone).toMatchObject({ restored: 2, conflict_count: 1 });
    expect(undone.conflicts[0]).toMatchObject({ node_id: `memory:${march.id}`, reason: expect.stringContaining('changed since the run wrote it') });
    // The memory the update replaced, and the fact the re-check retired, are back.
    expect(liveContents(memories)).toEqual(['Acme pays annually.', 'Acme renews in January.']);
  });

  it('stops when the Engine\'s key is spent, since the rest would be added unchecked', async () => {
    const { deps, memories } = setup(fiveNotes(), { checkFailure: { 'Dana Whitfield leads the Acme renewal.': 'OpenRouter: Key limit exceeded' } });
    const { run } = await startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'stopped', counts: { asked: 1, unmerged: 1 }, detail: expect.stringContaining('out of budget') });
    // The note's facts were written, so it is read; the rest wait.
    expect(liveContents(memories)).toEqual(['Acme wants a two-year term.', 'Dana Whitfield leads the Acme renewal.']);
  });

  it('honours a cap on facts per note, and leaves a duplicate unrecorded', async () => {
    const { deps, memories, db } = setup(fiveNotes(), { verdicts: { 'Acme pays annually.': { op: 'duplicate' } } });
    const { run } = await startExtraction(deps, { facts_per_note: 1, limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ facts: 2, created: 1, duplicates: 1 });
    expect(liveContents(memories)).toEqual(['Dana Whitfield leads the Acme renewal.']);
    expect(db.prepare('SELECT operation_id FROM on_demand_run_operations').all()).toEqual([{ operation_id: expect.stringMatching(/^memory:100@/) }]);
  });

  it('writes nothing of a note when what is left of its limit cannot pay for the Engine\'s checks of it (Codex, #705)', async () => {
    // A check has cost $0.05 lately, so each new memory is held at $0.10; a $0.15 limit pays for the call but not two memories' checks.
    const { deps, db, memories } = setup(fiveNotes(), { checkAverageUsd: 0.05 });
    const { run } = await startExtraction(deps, { limitUsd: 0.15, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'stopped', counts: { asked: 1, created: 0 }, detail: expect.stringContaining('less than the Engine\'s checks') });
    expect(memories.size).toBe(0);
    // The note it read stays unread, for a later run with room.
    expect(ledgerHash(db, 'm1')).toBeUndefined();
    expect(run.spent_usd).toBeLessThanOrEqual(0.15);
  });

  it('unwinds a chain of replacements the run made itself, and its own touches are no change (Codex, #705)', async () => {
    const pre: FakeMemory = { id: 7, content: 'Acme wants a one-year term.', expired_at: null, expire_reason: null, superseded_by: null, evidence_node_id: 'x', evidence_hash: 'hx' };
    const notes = [
      note('m1', 'Kickoff', 'FACT: Acme wants a two-year term.\nFACT: Acme pays annually.'),
      note('m3', 'Pricing call', 'FACT: Acme wants a three-year term.\nFACT: Acme pays every year.'),
    ];
    // 7 → 100 (two-year) → 102 (three-year); and "pays every year" is the same fact as 101, which only gains its subjects.
    const { deps, memories, db } = setup(notes, {
      memories: [pre],
      verdicts: {
        'Acme wants a two-year term.': { op: 'update', target: 7 },
        'Acme wants a three-year term.': { op: 'update', target: 100 },
        'Acme pays every year.': { op: 'noop', target: 101 },
      },
    });
    const { run } = await startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ created: 1, replaced: 2, already_known: 1 });
    expect(liveContents(memories)).toEqual(['Acme pays annually.', 'Acme wants a three-year term.']);
    // The run's own touch of 101 moved its record with it.
    const recorded = (db.prepare('SELECT operation_id FROM on_demand_run_operations').all() as Array<{ operation_id: string }>).map(row => row.operation_id);
    expect(recorded.find(id => id.startsWith('memory:101@'))).toBe(`memory:101@${memories.get(101)!.updated_at}`);

    expect(await undoExtraction(deps, run.id, true)).toMatchObject({ restored: 3, conflict_count: 0 });
    const undone = await undoExtraction(deps, run.id, false);
    expect(undone).toMatchObject({ restored: 3, conflict_count: 0 });
    // Back to before the run: the one-year memory, and nothing the run wrote.
    expect(liveContents(memories)).toEqual(['Acme wants a one-year term.']);
  });

  it('leaves on undo a memory changed since the run wrote it, even one brought back or given subjects (Codex, #705)', async () => {
    const { deps, memories, engine } = setup(fiveNotes());
    const { run } = await startExtraction(deps, { limitUsd: 1, trigger: 'on-demand' });
    const byContent = (text: string) => [...memories.values()].find(each => each.content === text)!;
    // Retired and brought back by someone: live again, but not as the run left it.
    engine.touch(byContent('Acme wants a two-year term.').id, { expired_at: '2026-11-20T14:00:00Z' });
    engine.touch(byContent('Acme wants a two-year term.').id, { expired_at: null });
    // Given subjects in place.
    engine.touch(byContent('Acme pays annually.').id);
    const undone = await undoExtraction(deps, run.id, false);
    expect(undone).toMatchObject({ restored: 1, conflict_count: 2 });
    expect(liveContents(memories)).toEqual(['Acme pays annually.', 'Acme wants a two-year term.']);
  });
});

describe('the tool', () => {
  it('names a parameter of another action, and suggests a start with the request and a limit covering both shares', async () => {
    const { deps } = setup(fiveNotes());
    const handler = makeExtractMemoriesHandler(deps as unknown as CoreDeps);
    const auth = { authInfo: { scopes: ['curate:trigger'] } } as never;
    const stray = await handler({ action: 'status', facts_per_note: 2 }, auth);
    expect(JSON.parse((stray.content[0] as { text: string }).text)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: 'status takes run_id; not facts_per_note.' } });

    const previewed = JSON.parse(((await handler({ action: 'preview', query: { types: ['meeting'] }, facts_per_note: 2, sample: 1 }, auth)).content[0] as { text: string }).text);
    expect(previewed).toMatchObject({ ok: true, notes: 3, next: { tool: 'extract-memories', arguments: { action: 'start', query: { types: ['meeting'] }, facts_per_note: 2 } } });
    expect(previewed.next.arguments.limit_usd).toBeGreaterThan(0);
  });
});
