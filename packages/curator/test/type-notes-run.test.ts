import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ModelPricing } from '@vault/pricing';
import { BackgroundBuilds } from '../src/background-builds.js';
import { createRunBudget, DailyBudget, type DailyBudgetPolicy, type RunBudgetFactory } from '../src/budget.js';
import type { Config } from '../src/config.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import { getOnDemandRun, listOnDemandRuns } from '../src/db/on-demand-runs.js';
import { EngineError, type Engine, type UndoOperationsResult } from '../src/engine.js';
import { fieldFillStatus, undoFieldFill } from '../src/field-fill/run.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from '../src/llm/types.js';
import { runCeiling } from '../src/on-demand/ceiling.js';
import { ON_DEMAND_BUILD_KEY } from '../src/on-demand/run.js';
import { viewOnDemandRun } from '../src/on-demand/views.js';
import { buildClassifySystem } from '../src/org-sweep.js';
import { CurationQueue } from '../src/queue.js';
import { makeFillFieldsHandler } from '../src/tools/fill-fields.js';
import { makeTypeNotesHandler, TYPE_NOTES_DESCRIPTION } from '../src/tools/type-notes.js';
import { checkTypeNotesArgs, typeNotesCli, typeNotesCliMode, type TypeNotesCliArgs } from '../src/type-notes/cli.js';
import {
  TYPE_NOTES_LIMITS,
  previewTypeNotes,
  startTypeNotes,
  typeNotesStatus,
  undoTypeNotes,
  type TypeNotesDeps,
} from '../src/type-notes/run.js';
import type { EngineNode, OrgNodeRef, SchemaRef } from '../src/types.js';

const MODEL = 'accounts/fireworks/models/small';
const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
const USAGE = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
/** One call at PRICE: 1,000 input and 100 output tokens. */
const CALL_USD = 0.002;

const CONFIG = {
  model: 'home-model',
  fieldGuessModel: MODEL,
  fieldGuessModelError: null,
  orgSweepModel: MODEL,
  orgSweepMaxTokens: 500,
  orgSweepEnabled: false,
  orgTypeExclude: ['wiki'],
  orgTypeExcludePaths: ['Settings'],
  orgTypePaths: ['Inbox'],
  orgMovePaths: ['/'],
  orgMoveCap: 25,
  bodyCharCap: 4_000,
  modelProviders: { [MODEL]: 'fireworks' },
  modelPricing: { [MODEL]: PRICE },
  curatorTz: 'UTC',
  journalEnabled: false,
} as unknown as Config;

const SCHEMAS: SchemaRef[] = [
  { name: 'meeting', display_name: 'Meeting', default_directory: 'Meetings' },
  { name: 'person', display_name: 'Person', default_directory: 'People' },
  { name: 'wiki', display_name: 'Wiki page', default_directory: 'Wikis' },
];
const FIELDS: Record<string, string[]> = { meeting: ['date', 'people'], person: ['email', 'company'], wiki: [] };

interface Note { id: string; title: string; path: string; body: string; types: string[]; version: number; hash: string }

/**
 * A small vault behind the Engine calls a typing run makes: it lists the notes with no type,
 * newest first, gives a note a type only at the version it was read at, and keeps one undo
 * operation per write.
 */
function vault(notes: Note[], options: {
  schemas?: SchemaRef[]; undoRecords?: boolean; refuses?: (note: Note, type: string) => boolean;
  /** The listing gives up before the end of the untyped notes. */
  tooMany?: boolean;
} = {}) {
  const byId = new Map(notes.map(note => [note.id, note]));
  const schemas = options.schemas ?? SCHEMAS;
  const operations = new Map<string, { id: string; version: number }>();
  let nextOperation = 1;
  /** Each type's fields, which a test may change as an owner would. */
  const fields: Record<string, string[]> = { ...FIELDS };
  const engine = {
    listSchemas: vi.fn(async () => schemas),
    schemaFieldNames: vi.fn(async (type: string) => fields[type] ?? []),
    listUntypedNodes: vi.fn(async (args: {
      pathPrefixes: string[]; filter?: Record<string, unknown>; maxPages?: number; pageLimit?: number;
      keep?: (node: OrgNodeRef) => boolean; maxNodes?: number;
    }) => {
      const prefix = typeof args.filter?.path_prefix === 'string' ? args.filter.path_prefix : null;
      const ids = Array.isArray(args.filter?.node_ids) ? new Set(args.filter.node_ids as string[]) : null;
      if (args.filter !== undefined && 'fields' in args.filter) throw new EngineError('INVALID_PARAMS', 'unexpected filter');
      const nodes: OrgNodeRef[] = notes
        .filter(note => note.types.length === 0 && (prefix === null || note.path.startsWith(prefix)) && (ids === null || ids.has(note.id)))
        .map(note => ({ id: note.id, title: note.title, file_path: note.path, types: [], version: note.version }))
        .filter(node => args.keep === undefined || args.keep(node));
      return { nodes: nodes.slice(0, args.maxNodes), truncated: options.tooMany === true || nodes.length > (args.maxNodes ?? Infinity) };
    }),
    getNode: vi.fn(async (id: string): Promise<EngineNode> => {
      const note = byId.get(id);
      if (note === undefined) throw new EngineError('NOT_FOUND', 'no such node');
      return {
        id: note.id, title: note.title, file_path: note.path, types: [...note.types], version: note.version, fields: {},
        relationships: { outgoing: {}, incoming: {} }, body: note.body, metadata: { content_hash: note.hash, file_mtime: 1 },
      } as EngineNode;
    }),
    addTypeCas: vi.fn(async (input: { nodeId: string; type: string; expectedVersion: number; dryRun: boolean }) => {
      const note = byId.get(input.nodeId)!;
      if (note.version !== input.expectedVersion) throw new EngineError('STALE_NODE', 'The node changed');
      if (options.refuses?.(note, input.type)) throw new EngineError('VALIDATION_FAILED', `${input.type} needs a date`);
      if (input.dryRun) return { operationId: null };
      note.types = [input.type];
      note.version += 1;
      if (options.undoRecords === false) return { operationId: null };
      const operationId = `op-${nextOperation++}`;
      operations.set(operationId, { id: note.id, version: note.version });
      return { operationId };
    }),
    undoOperations: vi.fn(async (ids: readonly string[], dryRun: boolean): Promise<UndoOperationsResult> => {
      const live = ids.filter(id => operations.has(id));
      // A note edited since the run typed it is a conflict and is left alone.
      const edited = live.filter(id => byId.get(operations.get(id)!.id)!.version !== operations.get(id)!.version);
      const clean = live.filter(id => !edited.includes(id));
      if (!dryRun) {
        for (const id of clean) {
          const note = byId.get(operations.get(id)!.id)!;
          note.types = [];
          note.version += 1;
          operations.delete(id);
        }
      }
      return {
        dry_run: dryRun, total_undone: dryRun ? 0 : clean.length, total_conflicts: edited.length, total_skipped: 0,
        conflicts: edited.map(id => ({ node_id: operations.get(id)!.id, reason: 'edited since' })) as UndoOperationsResult['conflicts'],
        not_found: ids.filter(id => !operations.has(id)),
      };
    }),
    listFieldGuessCandidates: vi.fn(async () => ({ page: { mode: 'requested' as const, candidates: [], next_cursor: null }, warnings: [] })),
    usageReport: vi.fn(async () => ({ data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] })),
  };
  return { engine, byId, operations, fields };
}

/**
 * Reads the note in the prompt: "Attendees:" makes a meeting, "Email:" a person, and anything
 * else no type. It answers only with a type it was offered.
 */
function readingModel() {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    structuredCall: vi.fn(async (request: StructuredCallRequest): Promise<StructuredCallResult> => {
      requests.push(request);
      const offered = ((request.schema as { properties: { type: { enum: string[] } } }).properties.type.enum);
      const wants = request.user.includes('Attendees:') ? 'meeting' : request.user.includes('Email:') ? 'person' : 'none';
      const type = offered.includes(wants) ? wants : 'none';
      return { output: { type, reason: type === 'none' ? 'Nothing in the note says what it is.' : `It reads like a ${type}.` }, usage: USAGE };
    }),
  };
  return { llm, requests };
}

const note = (n: number, body: string, path = `Inbox/Note ${n}.md`): Note =>
  ({ id: `n${n}`, title: `Note ${n}`, path, body, types: [], version: 1, hash: `hash-${n}` });

/** Five untyped notes: two meetings, one person, one that is neither, and one in the settings folder. */
const fiveNotes = (): Note[] => [
  note(1, 'Attendees: Ada, Grace\n\nWe agreed the renewal.'),
  note(2, 'Email: ada@example.com\nWorks at Acme.'),
  note(3, 'Attendees: Linus\n\nPilot results.'),
  note(4, 'A shopping list.'),
  note(5, 'Attendees: nobody', 'Settings/Templates.md'),
];

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(notes: Note[], options: {
  llm?: LlmClient; builds?: BackgroundBuilds; stopping?: () => boolean; config?: Partial<Config>;
  vault?: Parameters<typeof vault>[1];
} = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  databases.push(db);
  const store = vault(notes, options.vault);
  const model = readingModel();
  const llm = options.llm ?? model.llm;
  const queue = new CurationQueue();
  const config = { ...CONFIG, ...options.config } as Config;
  const policy: DailyBudgetPolicy = { capUsd: 1, tz: 'UTC', pricing: name => config.modelPricing?.[name] ?? null };
  const budgets = new Set<DailyBudget>();
  const runBudget: RunBudgetFactory = run => createRunBudget({
    llm, policy, engine: store.engine as unknown as Engine, limitUsd: run.limitUsd, runRef: run.runRef, budgets,
  });
  const recorder = new ActionRecorder(db);
  const deps: TypeNotesDeps = {
    engine: store.engine as unknown as Engine, llm, config, queue, db, recorder, runBudget,
    ...(options.builds ? { builds: options.builds } : {}),
    ...(options.stopping ? { stopping: options.stopping } : {}),
  };
  return { deps, db, queue, budgets, requests: model.requests, ...store };
}

const typesOf = (byId: Map<string, Note>): Record<string, string[]> => Object.fromEntries([...byId].map(([id, each]) => [id, each.types]));

describe('previewTypeNotes', () => {
  it('counts the untyped notes in scope and shows the type the model would give a sample, writing nothing', async () => {
    const { deps, db, engine, byId, requests } = setup(fiveNotes());
    const { request, preview } = await previewTypeNotes(deps, { sample: 3 });

    expect(request).toEqual({});
    expect(preview).toMatchObject({
      notes: 4, already_asked: 0, types_offered: ['meeting', 'person'], model: MODEL, provider: 'fireworks', sample_asked: 3, moves_note: null,
    });
    // The settings folder is never typed, and the preview says a note was left out for it.
    expect(preview.scope_note).toMatch(/^1 more untyped note\(s\) match but sit under a folder kept out of typing \(Settings: /);
    expect(preview.sample).toEqual([
      { id: 'n1', title: 'Note 1', path: 'Inbox/Note 1.md', type: 'meeting', reason: 'It reads like a meeting.' },
      { id: 'n2', title: 'Note 2', path: 'Inbox/Note 2.md', type: 'person', reason: 'It reads like a person.' },
      { id: 'n3', title: 'Note 3', path: 'Inbox/Note 3.md', type: 'meeting', reason: 'It reads like a meeting.' },
    ]);
    expect(preview.sample_cost_usd).toBeCloseTo(3 * CALL_USD, 10);
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect(preview.estimated_minutes).toBe(1);

    // The Engine checked each type as a dry run, and nothing was written or remembered.
    expect(engine.addTypeCas.mock.calls.every(([input]) => input.dryRun)).toBe(true);
    expect(typesOf(byId)).toEqual({ n1: [], n2: [], n3: [], n4: [], n5: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM type_run_verdicts').get()).toEqual({ n: 0 });

    // The model is told each offered type's fields, and is never offered a type the owner keeps out.
    expect(requests[0]!.system).toContain('- meeting — Meeting — Meetings/ — fields: date, people');
    expect(requests[0]!.system).toContain('- person — Person — People/ — fields: email, company');
    expect(requests[0]!.system).not.toContain('wiki');
    expect(requests[0]!.system).toContain('choose by which fields the note\'s content would fill');
    expect(requests[0]!.model).toBe(MODEL);
  });

  it('spreads its sample through the scope, so look-alike neighbours do not stand for the whole set', async () => {
    // An import lists its notes kind by kind: six meetings, then three people.
    const sorted = [
      ...Array.from({ length: 6 }, (_, index) => note(index + 1, 'Attendees: Ada')),
      ...Array.from({ length: 3 }, (_, index) => note(index + 7, 'Email: ada@example.com')),
    ];
    const { preview } = await previewTypeNotes(setup(sorted).deps, { sample: 3 });
    expect(preview.sample.map(each => [each.id, each.type])).toEqual([['n1', 'meeting'], ['n4', 'meeting'], ['n7', 'person']]);
    // Fewer notes than the sample asks for: all of them.
    expect((await previewTypeNotes(setup(sorted.slice(0, 2)).deps, { sample: 5 })).preview.sample.map(each => each.id)).toEqual(['n1', 'n2']);
  });

  it('leaves the nightly sweep\'s prompt as it was: no field names there', () => {
    const nightly = buildClassifySystem(SCHEMAS);
    expect(nightly).toContain('TYPE CATALOG (name — display name — conventional directory):\n- meeting — Meeting — Meetings/\n- person — Person — People/');
    expect(nightly).not.toContain('fields');
    // A type with no fields is still offered to a run, and says so.
    expect(buildClassifySystem(SCHEMAS, new Map([['meeting', ['date']]]))).toContain('- wiki — Wiki page — Wikis/ — fields: (none)');
  });

  it('takes the notes a query selects, and the types the caller narrows the offer to', async () => {
    const { deps, requests } = setup([...fiveNotes(), note(6, 'Attendees: Ken', 'Archive/Old.md')]);
    const archive = await previewTypeNotes(deps, { query: { path_prefix: 'Archive/' }, types: ['person'] });
    expect(archive.request).toEqual({ types: ['person'], query: { path_prefix: 'Archive/' } });
    expect(archive.preview).toMatchObject({ notes: 1, types_offered: ['person'], scope_note: null });
    // Offered people only, the model does not call a meeting a person.
    expect(archive.preview.sample).toEqual([expect.objectContaining({ id: 'n6', type: null })]);
    expect((requests[0]!.schema as { properties: { type: { enum: string[] } } }).properties.type.enum).toEqual(['person', 'none']);

    const two = await previewTypeNotes(deps, { query: { node_ids: ['n2', 'n4'] }, sample: 0 });
    expect(two.preview).toMatchObject({ notes: 2, sample: [], sample_asked: 0, estimated_cost_usd: null });
  });

  it('refuses a type that does not exist, one the owner keeps out of typing, and a filter it does not take', async () => {
    const { deps } = setup(fiveNotes());
    await expect(previewTypeNotes(deps, { types: ['meeting', 'recipe'] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS', message: expect.stringContaining('no such type: recipe'),
    });
    await expect(previewTypeNotes(deps, { types: ['wiki'] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS', message: 'types: wiki is kept out of typing by the curator setting orgTypeExclude, which the owner sets. A model may not assign it.',
    });
    await expect(previewTypeNotes(deps, { types: [' '] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    // A run covers notes with no type: a filter on types would contradict it.
    await expect(previewTypeNotes(deps, { query: { types: ['meeting'] } })).rejects.toMatchObject({
      code: 'INVALID_PARAMS', message: expect.stringMatching(/^query: types is not taken here\. It takes node_ids, /),
    });
    const bare = setup(fiveNotes(), { vault: { schemas: [SCHEMAS[2]!] } });
    await expect(previewTypeNotes(bare.deps, {})).rejects.toMatchObject({ code: 'NO_TYPES' });
  });

  it('says so when the nightly sweep would re-file what a run types', async () => {
    const { deps } = setup(fiveNotes(), { config: { orgSweepEnabled: true, orgMovePaths: ['/', 'Inbox'] } as Partial<Config> });
    const { preview } = await previewTypeNotes(deps, { sample: 0 });
    expect(preview.moves_note).toContain('moves a typed note that sits directly in the vault root, Inbox to its type\'s folder, up to 25 a night');
  });

  it('uses the home model when no typing model is set, and names that setting when its key is missing', async () => {
    const config = {
      orgSweepModel: null, modelProviders: { 'home-model': 'anthropic' }, modelPricing: { 'home-model': PRICE },
      llmKeys: { keys: { fireworks: 'k' } },
    } as unknown as Partial<Config>;
    const { deps, requests } = setup(fiveNotes(), { config });
    const { preview } = await previewTypeNotes(deps, {});
    expect(preview).toMatchObject({ model: 'home-model', provider: 'anthropic', sample: [], sample_asked: 0 });
    expect(preview.sample_note).toMatch(/^No sample was run: the Curator has no key for anthropic, .* or point the model setting at a model whose provider has one\.$/);
    expect(requests).toHaveLength(0);
  });

  it('shows a type the Engine would refuse, and a sample whose calls failed', async () => {
    const refusing = setup(fiveNotes(), { vault: { refuses: (_note, type) => type === 'meeting' } });
    const refused = await previewTypeNotes(refusing.deps, { sample: 1 });
    expect(refused.preview.sample).toEqual([
      { id: 'n1', title: 'Note 1', path: 'Inbox/Note 1.md', type: 'meeting', reason: '', refused: 'meeting needs a date' },
    ]);

    const failing: LlmClient = { structuredCall: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); } };
    const failed = await previewTypeNotes(setup(fiveNotes(), { llm: failing }).deps, { sample: 2 });
    expect(failed.preview).toMatchObject({ sample: [], sample_asked: 2, sample_cost_usd: 0 });
    expect(failed.preview.sample_note).toBe("The model call failed for 2 of the 2 sample notes. The Curator's log has the reason; check the orgSweepModel setting and its provider.");
  });
});

describe('a typing run', () => {
  it('types each note the model is sure of, leaves the rest untyped, and keeps an undo record per note', async () => {
    const { deps, db, byId, engine, requests } = setup(fiveNotes());
    const { run, started } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(started).toBe(true);
    expect(run).toMatchObject({
      job: 'type-notes', status: 'completed', notes: 4, detail: null,
      request: { offered: ['meeting', 'person'] },
      counts: { asked: 4, typed: 3, left_untyped: 1, refused: 0, already_asked: 0, changed: 0, errors: 0, by_type: { meeting: 2, person: 1 } },
    });
    expect(run.spent_usd).toBeCloseTo(4 * CALL_USD, 10);
    // The settings note was never read, and the shopping list stays untyped.
    expect(typesOf(byId)).toEqual({ n1: ['meeting'], n2: ['person'], n3: ['meeting'], n4: [], n5: [] });
    expect(engine.getNode.mock.calls.map(([id]) => id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(requests).toHaveLength(4);
    // Each write named the version the note was read at.
    expect(engine.addTypeCas).toHaveBeenCalledWith({ nodeId: 'n1', type: 'meeting', expectedVersion: 1, dryRun: false });
    expect(db.prepare('SELECT operation_id, node_id FROM on_demand_run_operations WHERE run_id = ? ORDER BY operation_id').all(run.id))
      .toEqual([{ operation_id: 'op-1', node_id: 'n1' }, { operation_id: 'op-2', node_id: 'n2' }, { operation_id: 'op-3', node_id: 'n3' }]);

    const status = typeNotesStatus(deps, run.id);
    expect(status).toMatchObject({ run: { run_id: run.id, job: 'type-notes', types: null, types_offered: ['meeting', 'person'], query: null, undoable_notes: 3 } });
    expect(typeNotesStatus(deps)).toMatchObject({ runs: [{ run_id: run.id }] });
  });

  it('does not ask the same question twice: an answered, unchanged note is not in the next run\'s scope', async () => {
    const { deps, db, requests, engine } = setup(fiveNotes());
    await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(requests).toHaveLength(4);

    // The one note left untyped has its answer. It is out of scope before it is counted, so a
    // run that could only repeat the question does not start, and says why.
    const preview = (await previewTypeNotes(deps, {})).preview;
    expect(preview).toMatchObject({ notes: 0, already_asked: 1, sample: [], sample_note: null });
    expect(preview.scope_note).toContain('1 more untyped note(s) match but were already asked this question (these types, this model) and are unchanged, so they are not asked again.');
    await expect(startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'NOTHING_TO_DO',
      message: 'No untyped note in scope is left to ask: 1 were already asked this question (these types, this model) and are unchanged. '
        + 'Offer other types, or change a type or the notes, to have them asked again.',
    });
    expect(requests).toHaveLength(4);
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 1 });
    // The listing was told to leave it out, as it is told to leave out the settings folder's notes.
    const { keep } = engine.listUntypedNodes.mock.lastCall![0];
    expect(keep!({ id: 'n4', title: 'Note 4', file_path: 'Inbox/Note 4.md', types: [], version: 1 })).toBe(false);
    expect(keep!({ id: 'n4', title: 'Note 4', file_path: 'Inbox/Note 4.md', types: [], version: 2 })).toBe(true);
    expect(keep!({ id: 'n9', title: 'Note 9', file_path: 'Settings/Note 9.md', types: [], version: 1 })).toBe(false);
  });

  it('asks again when the question changes: other types on offer, a type that changed, a note renamed or edited', async () => {
    const { deps, requests, byId, fields } = setup(fiveNotes());
    await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(requests).toHaveLength(4);

    // Fewer types on offer is another question.
    const narrowed = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(narrowed.run).toMatchObject({ notes: 1, counts: { asked: 1, left_untyped: 1 }, request: { types: ['person'], offered: ['person'] } });
    expect(requests).toHaveLength(5);
    await expect(startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'NOTHING_TO_DO' });

    // The owner gives the type another field: the model is shown a different catalog, so the
    // answer it gave for the old one no longer stands.
    fields.person = ['email', 'company', 'phone'];
    const reshaped = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(reshaped.run).toMatchObject({ notes: 1, counts: { asked: 1, left_untyped: 1 } });
    expect(requests[5]!.system).toContain('- person — Person — People/ — fields: email, company, phone');

    // The owner lets the model read more of each note: what was cut off may settle it, so the
    // note is back in scope without having changed.
    (deps.config as { bodyCharCap: number | null }).bodyCharCap = 50_000;
    expect((await previewTypeNotes(deps, { types: ['person'], sample: 0 })).preview).toMatchObject({ notes: 1, already_asked: 0 });
    const reread = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(reread.run).toMatchObject({ notes: 1, counts: { asked: 1, left_untyped: 1 } });

    // A note saved again with the same text is in scope (the listing cannot tell), and is not paid for twice.
    byId.get('n4')!.version += 1;
    const saved = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(saved.run).toMatchObject({ notes: 1, counts: { asked: 0, already_asked: 1 } });
    expect(requests).toHaveLength(7);

    // A note renamed or moved is asked, though its file's content hash is the same: the model
    // reads the title and the path too, and a better name can settle what the text did not.
    byId.get('n4')!.version += 1;
    byId.get('n4')!.title = 'Groceries';
    byId.get('n4')!.path = 'Inbox/Groceries.md';
    const renamed = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(renamed.run).toMatchObject({ notes: 1, counts: { asked: 1, left_untyped: 1, already_asked: 0 } });
    expect(requests[7]!.user).toContain('NOTE: Groceries\nPATH: Inbox/Groceries.md');

    // A note whose text changed is asked.
    byId.get('n4')!.version += 1;
    byId.get('n4')!.body = 'Email: ken@example.com';
    const edited = await startTypeNotes(deps, { types: ['person'], limitUsd: 1, trigger: 'on-demand' });
    expect(edited.run).toMatchObject({ counts: { asked: 1, typed: 1, by_type: { person: 1 } } });
  });

  it('refuses a scope with more untyped notes than it can read through', async () => {
    const { deps } = setup(fiveNotes(), { vault: { tooMany: true } });
    const refusal = { code: 'SCOPE_TOO_LARGE', message: 'More than 500,000 untyped notes match. Narrow the scope: a folder with path_prefix, or one survey-nodes group at a time with node_ids.' };
    await expect(previewTypeNotes(deps, {})).rejects.toMatchObject(refusal);
    await expect(startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject(refusal);
  });

  it('lists its scope once and works through it a batch a turn', async () => {
    const many = Array.from({ length: TYPE_NOTES_LIMITS.batch * 2 + 5 }, (_, index) => note(index + 1, 'Attendees: Ada'));
    const { deps, engine, queue, byId } = setup(many);
    const labels: string[] = [];
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = ((label: string, task: () => Promise<unknown>) => { labels.push(label); return enqueue(label, task); }) as typeof queue.enqueue;
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', notes: 45, counts: { typed: 45 } });
    expect([...byId.values()].every(each => each.types[0] === 'meeting')).toBe(true);
    // A wiki build queued behind a run waits for one batch, not for the run.
    expect(labels.filter(label => label === 'typing run')).toHaveLength(3);
    // Once to count the scope, once for the run: typing a note takes it out of the untyped set.
    expect(engine.listUntypedNodes).toHaveBeenCalledTimes(2);
    expect(engine.listUntypedNodes).toHaveBeenLastCalledWith(expect.objectContaining({ pathPrefixes: [], pageLimit: 200, maxPages: 2_500, maxNodes: 50_000 }));
  });

  it('stops at its limit, and continues when started again', async () => {
    const many = Array.from({ length: 8 }, (_, index) => note(index + 1, 'Attendees: Ada'));
    const { deps, byId } = setup(many);
    const first = await startTypeNotes(deps, { limitUsd: 0.01, trigger: 'on-demand' });
    expect(first.run.status).toBe('stopped');
    expect(first.run.detail).toMatch(/^Stopped before every note was reached: this run's limit: \$0\.0\d+ spent of \$0\.01; .* Start it again with a new limit to continue: notes already typed are not asked again\.$/);
    const typed = first.run.counts.typed as number;
    expect(typed).toBeGreaterThan(0);
    expect(typed).toBeLessThan(8);
    expect([...byId.values()].filter(each => each.types.length > 0)).toHaveLength(typed);

    const second = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(second.run).toMatchObject({ status: 'completed', notes: 8 - typed, counts: { typed: 8 - typed } });
  });

  it('leaves a note alone that was typed or edited after the run listed it', async () => {
    const { deps, byId, engine } = setup(fiveNotes());
    const read = engine.getNode.getMockImplementation()!;
    engine.getNode.mockImplementation(async id => {
      const node = await read(id);
      // While the model reads note 1, its owner edits it; note 2 was typed by hand before it was reached.
      if (id === 'n1') byId.get('n1')!.version += 1;
      if (id === 'n2') return { ...node, types: ['person'] };
      return node;
    });
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', counts: { asked: 3, typed: 1, left_untyped: 1, changed: 2 } });
    expect(byId.get('n1')!.types).toEqual([]);
    expect(byId.get('n3')!.types).toEqual(['meeting']);
  });

  it('does not read a note to the model that was moved into a folder kept out of typing after the run listed it', async () => {
    const { deps, byId, engine, requests } = setup(fiveNotes());
    const read = engine.getNode.getMockImplementation()!;
    // Listed in the inbox; by the time its turn comes, its owner has filed it under Settings.
    engine.getNode.mockImplementation(async id => (id === 'n1' ? { ...(await read(id)), file_path: 'Settings/Note 1.md' } : read(id)));
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', counts: { asked: 3, typed: 2, left_untyped: 1, changed: 1 } });
    expect(byId.get('n1')!.types).toEqual([]);
    expect(requests.some(request => request.user.includes('NOTE: Note 1\n'))).toBe(false);
  });

  it('counts a type the Engine refuses, and stops when the model keeps failing', async () => {
    const refusing = setup(fiveNotes(), { vault: { refuses: (_note, type) => type === 'meeting' } });
    const refused = await startTypeNotes(refusing.deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(refused.run).toMatchObject({ status: 'completed', counts: { asked: 4, typed: 1, refused: 2, left_untyped: 1, errors: 0 } });

    const many = Array.from({ length: 12 }, (_, index) => note(index + 1, 'Attendees: Ada'));
    let calls = 0;
    const dying: LlmClient = { structuredCall: async request => {
      calls += 1;
      if (calls > 2) throw Object.assign(new Error('model not found'), { status: 404 });
      return readingModel().llm.structuredCall(request);
    } };
    const { run } = await startTypeNotes(setup(many, { llm: dying }).deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'stopped', counts: { typed: 2, errors: TYPE_NOTES_LIMITS.failuresInARow } });
    expect(run.detail).toBe('Stopped: the model call failed for 5 notes in a row, so nothing more was asked. '
      + "The Curator's log has the reason; check the orgSweepModel setting and its provider, then start the run again.");
    expect(calls).toBe(2 + TYPE_NOTES_LIMITS.failuresInARow);
  });

  it('goes no further when the Engine gives no undo record for a write', async () => {
    // An Engine from before a single write returned its undo operation.
    const { deps, byId } = setup(fiveNotes(), { vault: { undoRecords: false } });
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'failed', counts: { asked: 1, typed: 1 } });
    expect(run.detail).toContain('The Engine gave no undo record for the type written to "Note 1", so this run stopped after that one note');
    expect(typesOf(byId)).toMatchObject({ n1: ['meeting'], n2: [], n3: [] });
  });

  it('refuses a run with nothing to type, or with no limit', async () => {
    const typed = fiveNotes().map(each => ({ ...each, types: ['meeting'] }));
    await expect(startTypeNotes(setup(typed).deps, { limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'NOTHING_TO_DO', message: expect.stringContaining('No untyped note is in scope'),
    });
    await expect(startTypeNotes(setup(fiveNotes()).deps, { trigger: 'on-demand' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('journals one summary for the run, under the organization sweep', async () => {
    const { deps, db } = setup(fiveNotes());
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    const events = db.prepare('SELECT kind, "function" AS fn, detail FROM journal_events WHERE run_ref = ?').all(run.id) as Array<{ kind: string; fn: string; detail: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'summary', fn: 'org-sweep' });
    expect(JSON.parse(events[0]!.detail).line).toBe(
      'typing run (2 type(s) on offer): completed; 3 of 4 notes typed (meeting 2, person 1), 1 left untyped, 0 already asked, 0 changed meanwhile, 0 errors; $0.0080 of $1.00');
  });
});

describe('undoing a typing run', () => {
  it('takes back every type the run gave, as a dry run first, and the notes can be typed again', async () => {
    const { deps, byId, requests } = setup(fiveNotes());
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(await undoTypeNotes(deps, run.id, true)).toEqual({ run_id: run.id, dry_run: true, restored: 3, conflicts: [], conflict_count: 0, no_longer_undoable: 0 });
    expect(byId.get('n1')!.types).toEqual(['meeting']);

    // A note edited since the run typed it keeps its type.
    byId.get('n2')!.version += 1;
    expect(await undoTypeNotes(deps, run.id, false)).toMatchObject({ dry_run: false, restored: 2, conflict_count: 1, conflicts: [{ node_id: 'n2', reason: 'edited since' }] });
    expect(typesOf(byId)).toMatchObject({ n1: [], n2: ['person'], n3: [] });
    await expect(undoTypeNotes(deps, run.id, false)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already undone') });

    // A typed note had no "no type fits" answer on record, so the next run asks about it again.
    const before = requests.length;
    const again = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(again.run).toMatchObject({ notes: 2, counts: { asked: 2, typed: 2, already_asked: 0 } });
    expect(requests).toHaveLength(before + 2);
  });
});

describe('typing and field filling together', () => {
  const background = () => {
    const kept: Array<Promise<unknown>> = [];
    return { builds: new BackgroundBuilds(work => { kept.push(work); }), settled: () => Promise.all(kept) };
  };
  const call = async (handler: ReturnType<typeof makeTypeNotesHandler> | ReturnType<typeof makeFillFieldsHandler>, args: Record<string, unknown>) => {
    const result = await (handler as ReturnType<typeof makeTypeNotesHandler>)({ action: 'preview', ...args } as never, { authInfo: { scopes: ['curate:trigger'] } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, any>;
    parsed.isError = result.isError === true;
    return parsed;
  };

  it('is one run at a time, whatever the job', async () => {
    const { builds, settled } = background();
    const { deps, db } = setup(fiveNotes(), { builds });
    const typing = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(typing).toMatchObject({ started: true, run: { status: 'queued', job: 'type-notes' } });
    expect(builds.get(ON_DEMAND_BUILD_KEY)).toBeDefined();

    // A field-filling start while the typing run goes on gets that run back, named for what it is.
    const filling = await call(makeFillFieldsHandler(deps), { action: 'start', fields: ['date'], limit_usd: 1 });
    expect(filling).toMatchObject({
      ok: true, started: false, run_id: typing.run.id, job: 'type-notes',
      detail: 'A type-notes run is in progress, so nothing was started: one run at a time, whatever the job. '
        + 'Follow it with the type-notes tool, action "status", and this run_id.',
    });
    expect(listOnDemandRuns(db, 10)).toHaveLength(1);
    await settled();
    expect(getOnDemandRun(db, typing.run.id)).toMatchObject({ status: 'completed' });
    expect(builds.get(ON_DEMAND_BUILD_KEY)).toBeUndefined();
  });

  it('keeps each tool to its own runs', async () => {
    const { deps, db } = setup(fiveNotes());
    const { run } = await startTypeNotes(deps, { limitUsd: 1, trigger: 'on-demand' });
    // The field-filling tool lists none of it, and sends a caller who names it to the right tool.
    expect(fieldFillStatus(deps)).toEqual({ runs: [] });
    expect(() => fieldFillStatus(deps, run.id)).toThrow(`Run ${run.id} is a type-notes run, not a fill-fields run. Use the type-notes tool for it.`);
    await expect(undoFieldFill(deps, run.id, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getOnDemandRun(db, run.id)!.undone_at).toBeNull();
    // Status shows whichever run is the latest, as its own tool shows it.
    expect(viewOnDemandRun(db, getOnDemandRun(db, run.id)!)).toMatchObject({ job: 'type-notes', types_offered: ['meeting', 'person'], counts: { typed: 3 } });
  });

  it('shares the day\'s ceiling: what a typing run spent is not there for the next run of either job', async () => {
    const { deps } = setup(fiveNotes(), { config: { runDailyBudgetCents: 3 } as Partial<Config> });
    expect(runCeiling(deps)).toMatchObject({ remaining_usd: 0.03 });
    await startTypeNotes(deps, { limitUsd: 0.03, trigger: 'on-demand' });
    // Four calls at a fifth of a cent each.
    expect(runCeiling(deps)).toEqual({ daily_usd: 0.03, spent_today_usd: 0.008, remaining_usd: 0.02 });
    const filling = await call(makeFillFieldsHandler(deps), { action: 'start', fields: ['date'], limit_usd: 0.03 });
    expect(filling).toMatchObject({ ok: false, error: { code: 'RUN_CEILING', message: expect.stringContaining('so this run may be given at most $0.02') } });
    await expect(startTypeNotes(deps, { limitUsd: 0.03, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'RUN_CEILING' });
  });

  it('renames the run tables and keeps the runs already there as field-filling runs', () => {
    const db = new Database(':memory:');
    databases.push(db);
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 35));
    db.prepare(`
      INSERT INTO field_fill_runs (id, status, request_json, limit_usd, model, provider, trigger, notes, counts_json, spent_usd, created_at, owner_host, owner_pid, heartbeat_at)
      VALUES ('old-run', 'completed', '{"fields":["date"]}', 1, ?, 'fireworks', 'on-demand', 9, '{"filled":7}', 0.4, '2026-11-18T10:00:00.000Z', 'h', 1, '2026-11-18T10:00:00.000Z')
    `).run(MODEL);
    db.prepare("INSERT INTO field_fill_run_operations (run_id, operation_id, node_id, written_at) VALUES ('old-run', 'op-9', 'n9', '2026-11-18T10:00:01.000Z')").run();
    runMigrations(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'field_fill%' OR name LIKE 'idx_field_fill%'").all()).toEqual([]);
    expect(getOnDemandRun(db, 'old-run')).toMatchObject({ job: 'fill-fields', request: { fields: ['date'] }, counts: { filled: 7 }, spent_usd: 0.4 });
    expect(viewOnDemandRun(db, getOnDemandRun(db, 'old-run')!)).toMatchObject({ job: 'fill-fields', fields: ['date'], undoable_notes: 1 });
  });
});

describe('the type-notes tool', () => {
  const call = async (deps: TypeNotesDeps, args: Record<string, unknown>, scopes = ['curate:trigger']) => {
    const result = await makeTypeNotesHandler(deps)({ action: 'preview', ...args } as never, { authInfo: { scopes } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, any>;
    parsed.isError = result.isError === true;
    return parsed;
  };

  it('needs the trigger scope, and says what it does in its first sentence', async () => {
    const { deps } = setup(fiveNotes());
    expect(await call(deps, {}, ['curate:read'])).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' }, isError: true });
    expect(TYPE_NOTES_DESCRIPTION.split('. ')[0]!.length).toBeLessThanOrEqual(90);
  });

  it('previews with the call that starts the run, then starts, follows and undoes it', async () => {
    const { deps, byId } = setup(fiveNotes(), { config: { runDailyBudgetCents: 500 } as Partial<Config> });
    const preview = await call(deps, { query: { path_prefix: 'Inbox/' }, types: ['meeting', 'person'] });
    expect(preview).toMatchObject({
      ok: true, notes: 4, types_offered: ['meeting', 'person'], sample_asked: 4, estimated_cost_usd: 0.01,
      daily_cap_note: expect.stringContaining('paid from today\'s cap'),
      run_ceiling_note: "$5.00 is left of today's ceiling for on-demand runs ($5.00, the curator setting runDailyBudgetCents). A run's limit must fit it.",
      next: {
        tool: 'type-notes',
        arguments: { action: 'start', query: { path_prefix: 'Inbox/' }, types: ['meeting', 'person'], limit_usd: 0.05 },
      },
    });

    const started = await call(deps, preview.next.arguments);
    expect(started).toMatchObject({ ok: true, started: true, job: 'type-notes', status: 'completed', counts: { typed: 3, left_untyped: 1 } });
    expect(await call(deps, { action: 'status', run_id: started.run_id })).toMatchObject({ ok: true, run: { status: 'completed', undoable_notes: 3 } });
    expect(await call(deps, { action: 'undo', run_id: started.run_id })).toMatchObject({ ok: true, dry_run: true, restored: 3 });
    expect(byId.get('n1')!.types).toEqual(['meeting']);
    expect(await call(deps, { action: 'undo', run_id: started.run_id, dry_run: false })).toMatchObject({ ok: true, dry_run: false, restored: 3 });
    expect(byId.get('n1')!.types).toEqual([]);
  });

  it('names a parameter that belongs to another action, and offers no start with nothing to type', async () => {
    const { deps } = setup(fiveNotes());
    expect(await call(deps, { limit_usd: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: 'preview takes query, types and sample; not limit_usd.' } });
    expect(await call(deps, { action: 'status', types: ['meeting'] })).toMatchObject({ ok: false, error: { message: 'status takes run_id; not types.' } });
    expect(await call(deps, { action: 'start', limit_usd: 1, query: { path_prefix: 'Nowhere/' } })).toMatchObject({ ok: false, error: { code: 'NOTHING_TO_DO' } });
    const empty = await call(deps, { query: { path_prefix: 'Nowhere/' } });
    expect(empty).toMatchObject({ ok: true, notes: 0, sample: [] });
    expect(empty.next).toBeUndefined();
  });
});

describe('the --type-notes command', () => {
  const ARGS: TypeNotesCliArgs = { dryRun: false, preview: false, typeNotes: true, offer: null, path: null, limitUsd: null, sample: null, undoTypes: null };
  const cli = async (deps: TypeNotesDeps, args: Partial<TypeNotesCliArgs>) => {
    const lines: string[] = [];
    const done = await typeNotesCli(deps, { ...ARGS, ...args }, line => { lines.push(line); }, { on: () => undefined, off: () => undefined }, () => undefined);
    return { ...done, lines };
  };

  it('counts with no model call, previews with a paid sample, and runs with a limit', async () => {
    const counted = setup(fiveNotes());
    expect(typeNotesCliMode({ ...ARGS, limitUsd: 1, dryRun: true })).toBe('count');
    expect((await cli(counted.deps, { path: 'Inbox/' })).lines).toEqual([
      '4 untyped note(s) in scope; model accounts/fireworks/models/small on fireworks',
      '  types on offer: meeting, person',
      'no model was called; --preview tries it on a sample (paid, from the daily cap), and --limit-usd <n> runs it',
    ]);
    expect(counted.requests).toHaveLength(0);

    const previewed = await cli(setup(fiveNotes()).deps, { dryRun: true, preview: true, sample: 3, offer: ['meeting'] });
    expect(previewed.lines).toEqual([
      '4 untyped note(s) in scope; model accounts/fireworks/models/small on fireworks',
      '  types on offer: meeting',
      expect.stringMatching(/^  1 more untyped note\(s\) match but sit under a folder kept out of typing/),
      '  sample "Note 1" (Inbox/Note 1.md): meeting; It reads like a meeting.',
      '  sample "Note 2" (Inbox/Note 2.md): no type; Nothing in the note says what it is.',
      '  sample "Note 3" (Inbox/Note 3.md): meeting; It reads like a meeting.',
      'estimated cost $0.01, about 1 minute(s); to run it use --limit-usd 0.05 in place of --preview',
    ]);

    const ran = setup(fiveNotes());
    const done = await cli(ran.deps, { limitUsd: 1 });
    expect(done.failed).toBe(false);
    expect(done.lines[0]).toMatch(/^COMPLETED {2}run \S+: 3 of 4 note\(s\) typed \(meeting 2, person 1\), 1 left untyped, 0 refused by the Engine, 0 already asked, 0 changed meanwhile, 0 error\(s\); \$0\.0080 of \$1\.00$/);
    expect(done.lines[1]).toMatch(/^ {2}undo it with --undo-types \S+$/);
    expect(ran.byId.get('n2')!.types).toEqual(['person']);

    const runId = done.lines[1]!.split(' ').pop()!;
    expect((await cli(ran.deps, { undoTypes: runId, dryRun: true, typeNotes: false })).lines)
      .toEqual(['would take the type back from 3 note(s); 0 edited since and left alone; 0 no longer undoable']);
    expect((await cli(ran.deps, { undoTypes: runId, typeNotes: false })).lines[0]).toMatch(/^took the type back from 3 note\(s\)/);
    expect(ran.byId.get('n2')!.types).toEqual([]);
  });

  it('refuses flags that would not mean what they say', () => {
    expect(() => checkTypeNotesArgs({ ...ARGS, sample: 3 })).toThrow('--sample goes with --preview');
    expect(() => checkTypeNotesArgs({ ...ARGS, preview: true, dryRun: true, sample: 3 })).not.toThrow();
    expect(() => checkTypeNotesArgs({ ...ARGS, limitUsd: 0 })).toThrow('positive number of dollars');
  });
});
