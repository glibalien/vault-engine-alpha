import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ModelPricing } from '@vault/pricing';
import { BackgroundBuilds } from '../src/background-builds.js';
import { createRunBudget, DailyBudget, type DailyBudgetPolicy, type RunBudgetFactory } from '../src/budget.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { ON_DEMAND_STALE_MS, getOnDemandRun, interruptAbandonedOnDemandRuns } from '../src/db/on-demand-runs.js';
import { checkFieldFillArgs, fieldFillCli, fieldFillCliMode, type FieldFillCliArgs } from '../src/field-fill/cli.js';
import { EngineError, type Engine, type UndoOperationsResult } from '../src/engine.js';
import {
  FIELD_FILL_LIMITS,
  fieldFillStatus,
  REPLACED_UNDO,
  previewFieldFill,
  runFieldFill,
  startFieldFill,
  undoFieldFill,
  type FieldFillDeps,
} from '../src/field-fill/run.js';
import { runCeiling, suggestedLimitUsd } from '../src/on-demand/ceiling.js';
import { flagList, flagValue } from '../src/on-demand/cli.js';
import { ON_DEMAND_BUILD_KEY, OnDemandError } from '../src/on-demand/run.js';
import type { FieldGuessFieldCandidate, FieldGuessNodeCandidate } from '../src/field-guess/types.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest, type StructuredCallResult } from '../src/llm/types.js';
import { CurationQueue } from '../src/queue.js';
import type { EngineNode } from '../src/types.js';
import { makeFillFieldsHandler } from '../src/tools/fill-fields.js';

const MODEL = 'accounts/fireworks/models/small';
const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
const USAGE = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
/** One call at PRICE: 1,000 input and 100 output tokens. */
const CALL_USD = 0.002;

const CONFIG = {
  fieldGuessModel: MODEL,
  fieldGuessModelError: null,
  fieldGuessCap: 25,
  fieldGuessMaxTokens: 500,
  bodyCharCap: 4_000,
  reasoningEffort: undefined,
  modelProviders: { [MODEL]: 'fireworks' },
  modelPricing: { [MODEL]: PRICE },
  curatorTz: 'UTC',
  journalEnabled: false,
} as unknown as Config;

const FIELD_DEFS: Record<string, FieldGuessFieldCandidate> = {
  date: {
    field: 'date', description: null, field_type: 'date', list_item_type: null, required: false, enum_values: null,
    reference_target: null, claiming_types: ['meeting'], eligibility: 'absent', definition_hash: 'd'.repeat(64),
  },
  company: {
    field: 'company', description: null, field_type: 'string', list_item_type: null, required: false, enum_values: null,
    reference_target: null, claiming_types: ['meeting'], eligibility: 'absent', definition_hash: 'c'.repeat(64),
  },
};

interface Note { id: string; title: string; body: string; fields: Record<string, unknown>; version: number; hash: string }

/**
 * A small vault behind the Engine calls a run makes: meetings whose date and company sit in the
 * text. It lists the notes lacking a requested field, newest first, applies guarded writes, and
 * keeps one undo operation per write.
 */
function vault(notes: Note[]) {
  const byId = new Map(notes.map(note => [note.id, note]));
  const operations = new Map<string, { id: string; before: Record<string, unknown>; version: number; hash: string }>();
  let nextOperation = 1;
  /** A date field holding something that is not a date: there, and failing its type. */
  const invalid = (field: string, value: unknown): boolean => field === 'date' && value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const candidates = (fields: readonly string[], query: Record<string, unknown> | undefined, replaceInvalid: boolean): FieldGuessNodeCandidate[] => {
    const ids = Array.isArray(query?.node_ids) ? new Set(query.node_ids as string[]) : null;
    return notes
      .filter(note => ids === null || ids.has(note.id))
      .map(note => ({
        node_id: note.id, title: note.title, file_path: `Meetings/${note.title}.md`, types: ['meeting'], version: note.version,
        content_hash: note.hash, file_mtime: 1_000 - notes.indexOf(note),
        fields: fields.flatMap(field => {
          const value = note.fields[field];
          if (value === undefined) return [FIELD_DEFS[field]!];
          return invalid(field, value) && replaceInvalid ? [{ ...FIELD_DEFS[field]!, eligibility: 'invalid' as const, held_text: String(value) }] : [];
        }),
      }))
      .filter(candidate => candidate.fields.length > 0);
  };
  const engine = {
    listFieldGuessCandidates: vi.fn(async (input: { limit?: number; cursor?: string; requested?: { fields: readonly string[]; query?: Record<string, unknown>; replace_invalid?: boolean } }) => {
      const requested = input.requested!;
      const unknown = requested.fields.filter(field => FIELD_DEFS[field] === undefined);
      if (unknown.length > 0) throw new EngineError('INVALID_PARAMS', `No type claims "${unknown.join('", "')}".`);
      const all = candidates(requested.fields, requested.query, requested.replace_invalid === true);
      // The cursor is the last note of the page before, as the Engine's keyset cursor is.
      const start = input.cursor === undefined ? 0 : all.findIndex(candidate => candidate.node_id === input.cursor) + 1;
      const page = all.slice(start, start + (input.limit ?? 100));
      const more = start + page.length < all.length;
      return { page: { mode: 'requested' as const, candidates: page, next_cursor: more ? page[page.length - 1]!.node_id : null }, warnings: [] };
    }),
    getNode: vi.fn(async (id: string): Promise<EngineNode> => {
      const note = byId.get(id)!;
      return {
        id: note.id, title: note.title, file_path: `Meetings/${note.title}.md`, types: ['meeting'], version: note.version,
        fields: { ...note.fields }, relationships: { outgoing: {}, incoming: {} }, body: note.body,
        metadata: { content_hash: note.hash, file_mtime: 1 },
      } as EngineNode;
    }),
    findNodesByExactTitle: vi.fn(async () => []),
    updateNodeFieldsCas: vi.fn(async (input: { nodeId: string; setFields: Record<string, unknown>; expectedVersion: number; dryRun: boolean; guard: { replace_invalid?: boolean } }) => {
      const note = byId.get(input.nodeId)!;
      if (note.version !== input.expectedVersion) throw new EngineError('STALE_NODE', 'Field guess precondition changed');
      // The Engine's guard holds the rule: a value already there is replaced only for a run that asked to.
      const overwrites = Object.keys(input.setFields).some(field => note.fields[field] !== undefined);
      if (overwrites && input.guard.replace_invalid !== true) throw new EngineError('STALE_NODE', 'Field guess precondition changed');
      if (input.dryRun) return { dry_run: true };
      const operationId = `op-${nextOperation++}`;
      operations.set(operationId, { id: note.id, before: { ...note.fields }, version: note.version, hash: note.hash });
      Object.assign(note.fields, input.setFields);
      note.version += 1;
      note.hash = `${note.hash}+`;
      return { node_id: note.id, operation_id: operationId };
    }),
    undoOperations: vi.fn(async (ids: readonly string[], dryRun: boolean): Promise<UndoOperationsResult> => {
      const notFound = ids.filter(id => !operations.has(id));
      const live = ids.filter(id => operations.has(id));
      if (!dryRun) {
        for (const id of live) {
          const operation = operations.get(id)!;
          const note = byId.get(operation.id)!;
          note.fields = operation.before;
          note.version += 1;
          note.hash = operation.hash;
          operations.delete(id);
        }
      }
      return { dry_run: dryRun, total_undone: dryRun ? 0 : live.length, total_conflicts: 0, total_skipped: 0, conflicts: [], not_found: notFound };
    }),
    usageReport: vi.fn(async () => ({ data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] })),
  };
  return { engine, byId, operations };
}

/** Reads "Date: …" and "Company: …" lines out of the prompt, and abstains on what is not there. */
function readingModel() {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    structuredCall: vi.fn(async (request: StructuredCallRequest): Promise<StructuredCallResult> => {
      requests.push(request);
      const offered = [...request.user.matchAll(/"field":\s*"(date|company)"/g)].map(match => match[1]!);
      const decisions = [...new Set(offered)].map(field => {
        const label = field === 'date' ? 'Date' : 'Company';
        // The note's text is JSON in the prompt, so a value ends at an escaped newline or a quote.
        const found = new RegExp(`${label}: ([^\\\\"]+)`).exec(request.user);
        return found
          ? { field, action: 'set', value: found[1]!.trim(), reason: `The note says "${label}: ${found[1]!.trim()}".` }
          : { field, action: 'abstain', reason: `The note gives no ${field}.` };
      });
      return { output: { decisions }, usage: USAGE };
    }),
  };
  return { llm, requests };
}

const meeting = (n: number, body: string, fields: Record<string, unknown> = {}): Note =>
  ({ id: `m${n}`, title: `Sync ${n}`, body, fields, version: 1, hash: `hash-${n}` });

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(notes: Note[], options: { llm?: LlmClient; builds?: BackgroundBuilds; stopping?: () => boolean; config?: Partial<Config> } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  databases.push(db);
  const store = vault(notes);
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
  const deps: FieldFillDeps = {
    engine: store.engine as unknown as Engine, llm, config, queue, db, recorder, runBudget,
    ...(options.builds ? { builds: options.builds } : {}),
    ...(options.stopping ? { stopping: options.stopping } : {}),
  };
  return { deps, db, queue, budgets, requests: model.requests, ...store };
}

const REQUEST = { fields: ['date', 'company'], query: { types: ['meeting'] } };

/** Four meetings: two give both values, one gives a date only, one gives neither. */
const fourMeetings = (): Note[] => [
  meeting(1, 'Date: 2024-03-01\nCompany: Acme\n\nWe agreed the renewal.'),
  meeting(2, 'Date: 2024-03-08\nCompany: Northwind\n\nPilot results.'),
  meeting(3, 'Date: 2024-03-15\n\nNo company named.'),
  meeting(4, 'A short note with nothing in it.'),
];

describe('previewFieldFill', () => {
  it('counts the notes in scope and shows what the model would write on a sample, writing nothing', async () => {
    const { deps, db, engine, byId } = setup([...fourMeetings(), meeting(5, 'Company: Globex', { date: '2024-04-01' })]);
    const { request, preview } = await previewFieldFill(deps, { ...REQUEST, sample: 3 });

    expect(request).toEqual({ fields: ['date', 'company'], query: { types: ['meeting'] } });
    // Note 5 has its date already, so only company is counted for it.
    expect(preview).toMatchObject({
      notes: 5, fields: { date: { empty: 4, invalid: 0 }, company: { empty: 5, invalid: 0 } }, replace_invalid: false, invalid_values_note: null,
      model: MODEL, provider: 'fireworks', sample_asked: 3,
    });
    expect(preview.sample).toEqual([
      { id: 'm1', title: 'Sync 1', path: 'Meetings/Sync 1.md', set: { date: '2024-03-01', company: 'Acme' }, left: [] },
      { id: 'm2', title: 'Sync 2', path: 'Meetings/Sync 2.md', set: { date: '2024-03-08', company: 'Northwind' }, left: [] },
      { id: 'm3', title: 'Sync 3', path: 'Meetings/Sync 3.md', set: { date: '2024-03-15' }, left: [{ field: 'company', reason: 'The note gives no company.' }] },
    ]);
    // Three calls at $0.002; the estimate is their average over the five notes, rounded up to a cent.
    expect(preview.sample_cost_usd).toBeCloseTo(3 * CALL_USD, 10);
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect(suggestedLimitUsd(preview.estimated_cost_usd)).toBe(0.05);
    expect(preview.estimated_minutes).toBe(1);

    // A dry run at the Engine, marked as a requested fill; nothing written or remembered.
    expect(engine.updateNodeFieldsCas).toHaveBeenCalledTimes(3);
    for (const [input] of engine.updateNodeFieldsCas.mock.calls) {
      expect(input).toMatchObject({ dryRun: true, guard: { requested: true } });
    }
    expect(byId.get('m1')!.fields).toEqual({});
    expect(db.prepare('SELECT COUNT(*) AS n FROM field_guess_attempts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 0 });
    // The preview's listing also looks at values that fail their type, to count them; it offers the model none of them.
    expect(engine.listFieldGuessCandidates).toHaveBeenCalledWith(expect.objectContaining({ requested: { ...request, replace_invalid: true } }));
  });

  it('does not price a sample call as free when the provider reported no usage', async () => {
    const model = readingModel();
    // A valid answer whose usage the provider left out: the adapters zero the counters and say so.
    const unmetered: LlmClient = { structuredCall: async request => ({
      ...(await model.llm.structuredCall(request)), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageKnown: false,
    }) };
    const { preview } = await previewFieldFill(setup(fourMeetings(), { llm: unmetered }).deps, { ...REQUEST, sample: 2 });
    expect(preview).toMatchObject({ sample_asked: 2, sample_cost_usd: null, estimated_cost_usd: null });
    expect(preview.sample).toHaveLength(2);
    expect(preview.sample_note).toBe('The provider did not report what a sample call used, so no cost can be estimated. A run still stops at the limit you give it.');
    expect(suggestedLimitUsd(preview.estimated_cost_usd)).toBeNull();

    // The provider's own charge is used when every response carries one, usage or not.
    const charged: LlmClient = { structuredCall: async request => ({
      ...(await model.llm.structuredCall(request)), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageKnown: false,
      diagnostics: { version: 1, adapterAttempts: 1, sdkAttempts: 1, responses: [{ attempt: 0, contentKind: 'string', usageKnown: false, providerCostUsd: 0.004 }] },
    }) as never };
    const priced = await previewFieldFill(setup(fourMeetings(), { llm: charged }).deps, { ...REQUEST, sample: 2 });
    expect(priced.preview.sample_cost_usd).toBeCloseTo(0.008, 10);
    expect(priced.preview.estimated_cost_usd).toBe(0.02);
  });

  it('counts a sample call that failed after it was sent: it may have been billed', async () => {
    const model = readingModel();
    // The first note's answer is cut off: the provider billed the tokens, and the adapter rejects the output.
    const billedFailure = (): LlmClient => {
      let calls = 0;
      return { structuredCall: async request => {
        calls += 1;
        if (calls === 1) throw new StructuredCallFailure('structured call failed (reason=truncated)', USAGE, 'truncated');
        return model.llm.structuredCall(request);
      } };
    };
    const { preview } = await previewFieldFill(setup(fourMeetings(), { llm: billedFailure() }).deps, { ...REQUEST, sample: 3 });
    // Three calls were sent and paid for; two gave a result.
    expect(preview).toMatchObject({ sample_asked: 3 });
    expect(preview.sample).toHaveLength(2);
    expect(preview.sample_cost_usd).toBeCloseTo(3 * CALL_USD, 10);
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect(preview.sample_note).toMatch(/^The model call failed for 1 of the 3 sample notes\./);

    // Every call fails that way: money was spent, and the preview says so instead of reporting an idle sample.
    const allBilled: LlmClient = { structuredCall: async () => { throw new StructuredCallFailure('structured call failed (reason=truncated)', USAGE, 'truncated'); } };
    const spent = await previewFieldFill(setup(fourMeetings(), { llm: allBilled }).deps, { ...REQUEST, sample: 2 });
    expect(spent.preview).toMatchObject({ sample: [], sample_asked: 2 });
    expect(spent.preview.sample_cost_usd).toBeCloseTo(2 * CALL_USD, 10);

    // A call that timed out carries no usage: its cost is unknown, never zero.
    const timedOut: LlmClient = { structuredCall: async () => { throw new Error('socket hang up'); } };
    const unknown = await previewFieldFill(setup(fourMeetings(), { llm: timedOut }).deps, { ...REQUEST, sample: 2 });
    expect(unknown.preview).toMatchObject({ sample_asked: 2, sample_cost_usd: null, estimated_cost_usd: null });
    expect(unknown.preview.sample_note).toContain('A sample call failed after it was sent and may have been billed');

    // The provider answered with an error: sent, and billed nothing.
    const refused: LlmClient = { structuredCall: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); } };
    const free = await previewFieldFill(setup(fourMeetings(), { llm: refused }).deps, { ...REQUEST, sample: 2 });
    expect(free.preview).toMatchObject({ sample_asked: 2, sample_cost_usd: 0 });
  });

  it('gives the count alone with sample 0, and no estimate', async () => {
    const { deps, engine } = setup(fourMeetings());
    const { preview } = await previewFieldFill(deps, { ...REQUEST, sample: 0 });
    expect(preview).toMatchObject({ notes: 4, sample: [], sample_asked: 0, sample_cost_usd: null, estimated_cost_usd: null, estimated_minutes: null });
    expect(engine.getNode).not.toHaveBeenCalled();
  });

  it('pages a scope larger than one listing page', async () => {
    const many = Array.from({ length: FIELD_FILL_LIMITS.scanPage + 30 }, (_, index) => meeting(index + 1, 'Date: 2024-01-01'));
    const { deps, engine } = setup(many);
    const { preview } = await previewFieldFill(deps, { fields: ['date'], sample: 0 });
    expect(preview.notes).toBe(FIELD_FILL_LIMITS.scanPage + 30);
    expect(engine.listFieldGuessCandidates).toHaveBeenCalledTimes(2);
  });

  it('refuses a request it cannot run, in the caller\'s terms', async () => {
    const { deps } = setup(fourMeetings());
    await expect(previewFieldFill(deps, { fields: [] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(previewFieldFill(deps, { fields: ['mood'] })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('No type claims "mood"') });
    const unresolved = setup(fourMeetings(), { config: { fieldGuessModel: null, fieldGuessModelError: 'fieldGuessModel names no enabled model.' } });
    await expect(previewFieldFill(unresolved.deps, REQUEST)).rejects.toMatchObject({ code: 'MODEL_UNRESOLVED' });
  });
});

describe('a run', () => {
  it('fills the notes in scope under its own limit and records what it did', async () => {
    const { deps, db, engine, byId, requests } = setup(fourMeetings());
    const { run, started } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });

    expect(started).toBe(true);
    expect(run).toMatchObject({
      status: 'completed', notes: 4, limit_usd: 1, model: MODEL, provider: 'fireworks', detail: null,
      counts: { asked: 4, filled: 3, left_empty: 1, already_asked: 0, changed: 0, errors: 0, fields_set: 5, fields_left: 3 },
    });
    expect(run.spent_usd).toBeCloseTo(4 * CALL_USD, 10);
    expect(byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });
    expect(byId.get('m3')!.fields).toEqual({ date: '2024-03-15' });
    expect(byId.get('m4')!.fields).toEqual({});

    // Each write is guarded as a requested fill and keeps its undo operation.
    for (const [input] of engine.updateNodeFieldsCas.mock.calls) {
      expect(input).toMatchObject({ dryRun: false, guard: { requested: true } });
    }
    expect(db.prepare('SELECT operation_id, node_id FROM on_demand_run_operations WHERE run_id = ? ORDER BY operation_id').all(run.id))
      .toEqual([{ operation_id: 'op-1', node_id: 'm1' }, { operation_id: 'op-2', node_id: 'm2' }, { operation_id: 'op-3', node_id: 'm3' }]);
    // The attempt ledger is the run's memory of what it asked.
    expect(db.prepare('SELECT outcome, COUNT(*) AS n FROM field_guess_attempts WHERE run_ref = ? GROUP BY outcome ORDER BY outcome').all(run.id))
      .toEqual([{ outcome: 'abstained', n: 3 }, { outcome: 'set', n: 5 }]);
    // One journal summary, and no line per field.
    const events = db.prepare('SELECT kind, action, detail FROM journal_events WHERE run_ref = ?').all(run.id) as Array<{ kind: string; action: string | null; detail: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain('3 of 4 notes filled, 5 fields set, 1 left empty');
    expect(requests).toHaveLength(4);
  });

  it('asks nothing twice: a second run finds only the notes still lacking a field, already asked and unchanged', async () => {
    const { deps, requests } = setup(fourMeetings());
    await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(requests).toHaveLength(4);

    const again = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    // Notes 1 and 2 are full. Note 3 was written, so it is new text to ask about; note 4 is unchanged.
    expect(again.run).toMatchObject({ status: 'completed', notes: 2, counts: { asked: 1, filled: 0, left_empty: 1, already_asked: 1 } });
    expect(requests).toHaveLength(5);
  });

  it('stops at its limit, says so, and continues when started again', async () => {
    const eight = Array.from({ length: 8 }, (_, index) => meeting(index + 1, `Date: 2024-05-0${index + 1}\nCompany: Acme`));
    const { deps, byId } = setup(eight);
    // A call's worst case is larger than what it costs, so the limit refuses a call it could have paid for.
    const first = await startFieldFill(deps, { ...REQUEST, limitUsd: 0.012, trigger: 'on-demand' });
    expect(first.run.status).toBe('stopped');
    expect(first.run.detail).toMatch(/^Stopped before every note was reached: this run's limit: \$0\.0\d+ spent of \$0\.01; .* Start it again with a new limit to continue/);
    const filled = first.run.counts.filled as number;
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(8);
    expect(first.run.spent_usd).toBeLessThanOrEqual(0.012);
    expect([...byId.values()].filter(note => note.fields.date !== undefined)).toHaveLength(filled);

    const second = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(second.run).toMatchObject({ status: 'completed', notes: 8 - filled, counts: { filled: 8 - filled } });
    expect([...byId.values()].every(note => note.fields.date !== undefined && note.fields.company === 'Acme')).toBe(true);
  });

  it('takes the queue a batch at a time, so other work is not held for the whole run', async () => {
    const many = Array.from({ length: FIELD_FILL_LIMITS.batch * 2 + 5 }, (_, index) => meeting(index + 1, 'Date: 2024-06-01'));
    const { deps, queue } = setup(many);
    const labels: string[] = [];
    const enqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, 'enqueue').mockImplementation(((label: string, work: () => Promise<unknown>) => {
      labels.push(label);
      return enqueue(label, work);
    }) as typeof queue.enqueue);
    const { run } = await startFieldFill(deps, { fields: ['date'], limitUsd: 5, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', counts: { filled: many.length } });
    expect(labels.filter(label => label === 'field fill run')).toHaveLength(3);
  });

  it('counts a note that changed under it and goes on', async () => {
    const { deps, engine, byId } = setup(fourMeetings());
    const write = engine.updateNodeFieldsCas.getMockImplementation()!;
    engine.updateNodeFieldsCas.mockImplementationOnce(async () => { throw new EngineError('STALE_NODE', 'Field guess precondition changed'); });
    engine.updateNodeFieldsCas.mockImplementation(write);
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', counts: { asked: 4, filled: 2, left_empty: 1, changed: 1, errors: 0 } });
    expect(byId.get('m1')!.fields).toEqual({});
  });

  it('refuses to start without a limit, with an unpriced model, or with nothing to do', async () => {
    const { deps } = setup(fourMeetings());
    await expect(startFieldFill(deps, { ...REQUEST, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('limit_usd') });
    await expect(startFieldFill(deps, { ...REQUEST, limitUsd: 500, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const unpriced = setup(fourMeetings(), { config: { modelPricing: { [MODEL]: null } } });
    await expect(startFieldFill(unpriced.deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'MODEL_UNPRICED' });
    const full = setup([meeting(1, 'x', { date: '2024-01-01', company: 'Acme' })]);
    await expect(startFieldFill(full.deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' })).rejects.toBeInstanceOf(OnDemandError);
    await expect(startFieldFill(full.deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'NOTHING_TO_DO' });
  });
});

describe('a value that fails its field\'s type', () => {
    /** Two meetings with no date, and one whose date says "TBD" although its text gives the day. */
  const withTbd = (): Note[] => [
    meeting(1, 'Date: 2024-03-01\nCompany: Acme', { company: 'Acme' }),
    meeting(2, 'Date: 2024-03-08\nCompany: Northwind', { company: 'Northwind' }),
    meeting(3, 'Date: 2024-03-15\nCompany: Globex', { company: 'Globex', date: 'TBD' }),
  ];
  const DATE = { fields: ['date'], query: { types: ['meeting'] } };

  it('is counted by the preview and left as it is by a run', async () => {
    const { deps, byId, engine } = setup(withTbd());
    const { request, preview } = await previewFieldFill(deps, DATE);
    expect(request.replace_invalid).toBeUndefined();
    // Two notes are in scope; the third is seen, counted and not touched.
    expect(preview).toMatchObject({ notes: 2, fields: { date: { empty: 2, invalid: 1 } }, replace_invalid: false, sample_asked: 2 });
    expect(preview.invalid_values_note).toBe('1 value(s) fail their field\'s type (a date field holding "TBD", say) and are left as they are. '
      + 'Pass replace_invalid: true to have them replaced where the note gives a value.');
    expect(preview.sample.map(note => note.id)).toEqual(['m1', 'm2']);
    expect(preview.sample.every(note => note.replaces === undefined)).toBe(true);

    const { run } = await startFieldFill(deps, { ...DATE, limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', notes: 2, counts: { filled: 2, fields_set: 2, fields_replaced: 0 } });
    expect(byId.get('m3')!.fields.date).toBe('TBD');
    // Neither the listing nor any write asked to replace.
    for (const [input] of engine.updateNodeFieldsCas.mock.calls) expect(input.guard).not.toHaveProperty('replace_invalid');
    expect(engine.listFieldGuessCandidates.mock.calls.filter(([input]) => input.limit === FIELD_FILL_LIMITS.batch)
      .every(([input]) => input.requested?.replace_invalid === undefined)).toBe(true);
  });

  it('is replaced only by a run that asks to, and the preview shows what would go', async () => {
    const { deps, byId, engine } = setup(withTbd());
    const { request, preview } = await previewFieldFill(deps, { ...DATE, replaceInvalid: true });
    expect(request.replace_invalid).toBe(true);
    expect(preview).toMatchObject({ notes: 3, fields: { date: { empty: 2, invalid: 1 } }, replace_invalid: true, sample_asked: 3 });
    expect(preview.invalid_values_note).toMatch(/^1 value\(s\) fail their field's type and would be replaced where the note gives a value\./);
    // Said before anything is replaced: undo puts it back.
    expect(preview.invalid_values_note).toContain(REPLACED_UNDO);
    expect(preview.sample[2]).toEqual({
      id: 'm3', title: 'Sync 3', path: 'Meetings/Sync 3.md', set: { date: '2024-03-15' }, replaces: { date: 'TBD' }, left: [],
    });
    expect(byId.get('m3')!.fields.date).toBe('TBD');

    const { run } = await startFieldFill(deps, { ...DATE, replaceInvalid: true, limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', notes: 3, request: { replace_invalid: true }, counts: { filled: 3, fields_set: 3, fields_replaced: 1 } });
    expect(byId.get('m3')!.fields.date).toBe('2024-03-15');
    for (const [input] of engine.updateNodeFieldsCas.mock.calls.slice(3)) expect(input.guard).toMatchObject({ requested: true, replace_invalid: true });
    expect(fieldFillStatus(deps, run.id)).toMatchObject({ run: { replace_invalid: true } });

    // Undo puts it back.
    const undone = await undoFieldFill(deps, run.id, false);
    expect(byId.get('m3')!.fields.date).toBe('TBD');
    expect(undone).not.toHaveProperty('note');
  });

  it('has nothing to do when it is the only gap and the run does not replace', async () => {
    const { deps } = setup([meeting(3, 'Date: 2024-03-15', { date: 'TBD' })]);
    await expect(startFieldFill(deps, { ...DATE, limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'NOTHING_TO_DO', message: expect.stringContaining('left alone unless replace_invalid is true'),
    });
    const { run } = await startFieldFill(deps, { ...DATE, replaceInvalid: true, limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ filled: 1, fields_replaced: 1 });
  });
});

describe('the day\'s ceiling for on-demand runs', () => {
  const FIVE = { runDailyBudgetCents: 500 } as Partial<Config>;

  it('refuses a limit that does not fit what is left, and counts what today\'s runs spent', async () => {
    const { deps, db, requests } = setup(fourMeetings(), { config: FIVE });
    expect(runCeiling(deps)).toEqual({ daily_usd: 5, spent_today_usd: 0, remaining_usd: 5 });
    // The caller states the limit, and the caller is usually a model: the owner's ceiling bounds it.
    await expect(startFieldFill(deps, { ...REQUEST, limitUsd: 5.01, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'RUN_CEILING',
      message: "Today's ceiling for on-demand runs is $5.00 and $0.00 of it is spent, so this run may be given at most $5.00. "
        + 'The ceiling is the curator setting runDailyBudgetCents, which the owner sets.',
    });
    expect(requests).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 0 });

    // A run that fits starts, and what it spends comes off the day.
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 5, trigger: 'on-demand' });
    expect(run.status).toBe('completed');
    expect(runCeiling(deps)).toEqual({ daily_usd: 5, spent_today_usd: 0.008, remaining_usd: 4.99 });
    await expect(startFieldFill(deps, { fields: ['company'], limitUsd: 5, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'RUN_CEILING', message: expect.stringContaining('$0.01 of it is spent, so this run may be given at most $4.99'),
    });
  });

  it('is checked again when the run is claimed: another run may have spent the day meanwhile', async () => {
    const { deps, db, engine, requests } = setup(fourMeetings(), { config: FIVE });
    // While this request counts its scope, another one starts, spends and finishes.
    const list = engine.listFieldGuessCandidates.getMockImplementation()!;
    let raced = false;
    engine.listFieldGuessCandidates.mockImplementation(async input => {
      if (!raced) {
        raced = true;
        const at = new Date().toISOString();
        db.prepare(`
          INSERT INTO on_demand_runs (id, status, request_json, limit_usd, model, provider, trigger, notes, counts_json, spent_usd, created_at, owner_host, owner_pid, heartbeat_at)
          VALUES ('their-run', 'completed', '{"fields":["date"]}', 4.5, ?, 'fireworks', 'cli', 9, '{}', 4.5, ?, 'another-machine', 1, ?)
        `).run(MODEL, at, at);
      }
      return list(input);
    });
    // $1 fitted the day when this request was first looked at; fifty cents are left when it is claimed.
    await expect(startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'RUN_CEILING', message: expect.stringContaining('$4.50 of it is spent, so this run may be given at most $0.50'),
    });
    expect(db.prepare('SELECT id FROM on_demand_runs').all()).toEqual([{ id: 'their-run' }]);
    expect(requests).toHaveLength(0);
    // What is left can still be used.
    expect((await startFieldFill(deps, { ...REQUEST, limitUsd: 0.5, trigger: 'on-demand' })).run.status).toBe('completed');
  });

  it('is a day\'s: yesterday\'s runs do not count, and a spent day starts no run', async () => {
    const { deps, db } = setup(fourMeetings(), { config: FIVE });
    const row = (id: string, createdAt: string, spent: number): void => {
      db.prepare(`
        INSERT INTO on_demand_runs (id, status, request_json, limit_usd, model, provider, trigger, notes, counts_json, spent_usd, created_at, owner_host, owner_pid, heartbeat_at)
        VALUES (?, 'completed', '{"fields":["date"]}', 5, ?, 'fireworks', 'on-demand', 9, '{}', ?, ?, 'h', 1, ?)
      `).run(id, MODEL, spent, createdAt, createdAt);
    };
    const now = new Date();
    row('yesterday', new Date(now.getTime() - 36 * 3_600_000).toISOString(), 4.9);
    expect(runCeiling(deps, now)).toMatchObject({ spent_today_usd: 0, remaining_usd: 5 });

    row('today', now.toISOString(), 5.2);
    expect(runCeiling(deps, now)).toEqual({ daily_usd: 5, spent_today_usd: 5.2, remaining_usd: 0 });
    await expect(startFieldFill(deps, { ...REQUEST, limitUsd: 0.05, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'RUN_CEILING', message: expect.stringContaining('so no run can start today'),
    });
  });

  it('turns on-demand runs off at 0, and is not there when the owner removed it', async () => {
    const off = setup(fourMeetings(), { config: { runDailyBudgetCents: 0 } as Partial<Config> });
    await expect(startFieldFill(off.deps, { ...REQUEST, limitUsd: 0.05, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'RUN_CEILING', message: expect.stringContaining('On-demand runs are turned off (runDailyBudgetCents is 0)'),
    });
    const none = setup(fourMeetings(), { config: { runDailyBudgetCents: null } as Partial<Config> });
    expect(runCeiling(none.deps)).toBeNull();
    expect((await startFieldFill(none.deps, { ...REQUEST, limitUsd: 50, trigger: 'on-demand' })).run.status).toBe('completed');
  });

  it('shows in the preview, and bounds the limit the preview suggests', async () => {
    const call = async (deps: FieldFillDeps, args: Record<string, unknown>) => {
      const result = await makeFillFieldsHandler(deps)({ action: 'preview', ...args } as never, { authInfo: { scopes: ['curate:trigger'] } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return JSON.parse(result.content[0]!.text) as Record<string, any>;
    };
    const roomy = await call(setup(fourMeetings(), { config: FIVE }).deps, REQUEST);
    expect(roomy.run_ceiling).toEqual({ daily_usd: 5, spent_today_usd: 0, remaining_usd: 5 });
    expect(roomy.run_ceiling_note).toBe("$5.00 is left of today's ceiling for on-demand runs ($5.00, the curator setting runDailyBudgetCents). A run's limit must fit it.");
    expect(roomy.next.arguments.limit_usd).toBe(0.05);

    // Three cents left: the estimate (one cent) fits, and the suggested limit is what is left, not five cents.
    const tight = await call(setup(fourMeetings(), { config: { runDailyBudgetCents: 3 } as Partial<Config> }).deps, REQUEST);
    expect(tight.next.arguments.limit_usd).toBe(0.03);
    expect(suggestedLimitUsd(2, { daily_usd: 5, spent_today_usd: 4, remaining_usd: 1 })).toBe(1);
    expect(suggestedLimitUsd(2, { daily_usd: 5, spent_today_usd: 5, remaining_usd: 0 })).toBeNull();
    expect(suggestedLimitUsd(2)).toBe(3);

    // More to do than the day allows: said plainly, with the limit that is left.
    const many = Array.from({ length: 30 }, (_, index) => meeting(index + 1, 'Date: 2024-08-01'));
    const short = await call(setup(many, { config: { runDailyBudgetCents: 2 } as Partial<Config> }).deps, { fields: ['date'] });
    expect(short.estimated_cost_usd).toBe(0.06);
    expect(short.run_ceiling_note).toMatch(/^The estimate is more than what is left of today's ceiling for on-demand runs \(\$0\.02 of \$0\.02, the curator setting runDailyBudgetCents\)\. A run can do part of the set today/);
    expect(short.next.arguments.limit_usd).toBe(0.02);
    expect(short.next.purpose).toContain('short of the whole set');

    // Nothing left: no call is offered.
    const spent = await call(setup(fourMeetings(), { config: { runDailyBudgetCents: 0 } as Partial<Config> }).deps, REQUEST);
    expect(spent.next).toBeUndefined();
    expect(spent.run_ceiling_note).toContain('on-demand runs are turned off');

    // No ceiling: the preview says nothing about one.
    const free = await call(setup(fourMeetings()).deps, REQUEST);
    expect(free.run_ceiling).toBeNull();
    expect(free.run_ceiling_note).toBeUndefined();
  });
});

describe('what stops a run before it spends', () => {
  const noKey = { llmKeys: { keys: { anthropic: 'test-key' }, baseURLs: {} } } as unknown as Partial<Config>;

  it('names a missing provider key: the preview still counts, and a run does not start', async () => {
    const { deps, engine, requests } = setup(fourMeetings(), { config: noKey });
    const { preview } = await previewFieldFill(deps, REQUEST);
    expect(preview).toMatchObject({ notes: 4, sample: [], sample_asked: 0, estimated_cost_usd: null });
    expect(preview.sample_note).toBe(`No sample was run: the Curator has no key for fireworks, the provider of ${MODEL}. `
      + "Add the key to the Curator's environment, or point the fieldGuessModel setting at a model whose provider has one.");
    expect(requests).toHaveLength(0);
    expect(engine.getNode).not.toHaveBeenCalled();
    await expect(startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({ code: 'NO_PROVIDER_KEY' });
  });

  it('refuses a filter the scope does not take, before asking the Engine', async () => {
    const { deps, engine } = setup(fourMeetings());
    await expect(previewFieldFill(deps, { fields: ['date'], query: { join_filters: [], types: ['meeting'] } })).rejects.toMatchObject({
      code: 'INVALID_PARAMS', message: expect.stringMatching(/^query: join_filters is not taken here\. It takes types, without_types, node_ids,/),
    });
    expect(engine.listFieldGuessCandidates).not.toHaveBeenCalled();
  });

  it('reports a filter the Engine\'s schema rejects as the caller\'s mistake', async () => {
    const { deps, engine } = setup(fourMeetings());
    engine.listFieldGuessCandidates.mockRejectedValueOnce(new EngineError('BAD_JSON',
      'tool list-field-guess-candidates returned non-JSON: MCP error -32602: Input validation error: Invalid arguments for tool list-field-guess-candidates: Invalid input: expected array, received string at requested.query.types'));
    await expect(previewFieldFill(deps, { fields: ['date'], query: { types: 'meeting' } })).rejects.toMatchObject({
      code: 'INVALID_PARAMS', message: 'query: Invalid input: expected array, received string at requested.query.types',
    });
  });

  it('says so when the sample\'s calls fail', async () => {
    const llm: LlmClient = { structuredCall: async () => { throw new Error('upstream said no'); } };
    const { deps } = setup(fourMeetings(), { llm });
    const { preview } = await previewFieldFill(deps, { ...REQUEST, sample: 2 });
    // Both calls were sent and neither answered: no result, and a cost nobody can state.
    expect(preview).toMatchObject({ notes: 4, sample: [], sample_asked: 2, sample_cost_usd: null, estimated_cost_usd: null });
    expect(preview.sample_note).toMatch(/^The model call failed for 2 of the 2 sample notes\./);
  });

  it('gives up after calls fail for several notes in a row, and says how to go on', async () => {
    const many = Array.from({ length: 12 }, (_, index) => meeting(index + 1, 'Date: 2024-07-01'));
    const model = readingModel();
    let calls = 0;
    // The first two notes are answered; then the provider fails every call.
    const llm: LlmClient = { structuredCall: async request => {
      calls += 1;
      if (calls > 2) throw new Error('upstream said no');
      return model.llm.structuredCall(request);
    } };
    const { deps, byId } = setup(many, { llm });
    const { run } = await startFieldFill(deps, { fields: ['date'], limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'stopped', counts: { filled: 2, errors: FIELD_FILL_LIMITS.failuresInARow } });
    expect(run.detail).toMatch(/^Stopped: the model call failed for 5 notes in a row, so nothing more was asked\./);
    expect(calls).toBe(2 + FIELD_FILL_LIMITS.failuresInARow);
    expect([...byId.values()].filter(note => note.fields.date !== undefined)).toHaveLength(2);
  });
});

describe('a run on the server', () => {
  const background = () => {
    const kept: Array<Promise<unknown>> = [];
    return { builds: new BackgroundBuilds(work => { kept.push(work); }), settled: () => Promise.all(kept) };
  };

  it('replies at once, runs in the background, and lets no second run start meanwhile', async () => {
    const { builds, settled } = background();
    const { deps, db, byId } = setup(fourMeetings(), { builds });
    const first = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(first).toMatchObject({ started: true, run: { status: 'queued', notes: 4 } });
    expect(builds.get(ON_DEMAND_BUILD_KEY)).toBeDefined();

    const second = await startFieldFill(deps, { fields: ['date'], limitUsd: 1, trigger: 'on-demand' });
    expect(second).toMatchObject({ started: false, run: { id: first.run.id } });

    await settled();
    expect(getOnDemandRun(db, first.run.id)).toMatchObject({ status: 'completed', counts: { filled: 3 } });
    expect(byId.get('m2')!.fields).toEqual({ date: '2024-03-08', company: 'Northwind' });
    expect(builds.get(ON_DEMAND_BUILD_KEY)).toBeUndefined();
  });

  it('frees the way for the next run as soon as it has ended, though its journal entry still waits', async () => {
    const { builds, settled } = background();
    const { deps, db } = setup(fourMeetings(), { builds });
    const first = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    // A long wiki build is queued behind the run's one batch; the run's journal entry will wait behind it.
    let release!: () => void;
    const wiki = deps.queue.enqueue('a long wiki build', () => new Promise<void>(resolve => { release = resolve; }));
    for (let i = 0; i < 200 && getOnDemandRun(db, first.run.id)!.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(getOnDemandRun(db, first.run.id)!.status).toBe('completed');
    await new Promise(resolve => setTimeout(resolve, 10));

    // The run is over, so its key is free: another run starts (and waits its turn in the queue).
    expect(builds.get(ON_DEMAND_BUILD_KEY)).toBeUndefined();
    expect(builds.get(`run-journal:${first.run.id}`)).toBeDefined();
    const second = await startFieldFill(deps, { fields: ['company'], query: { types: ['meeting'] }, limitUsd: 1, trigger: 'on-demand' });
    expect(second).toMatchObject({ started: true, run: { status: 'queued' } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM on_demand_runs WHERE status = 'failed'").get()).toEqual({ n: 0 });

    release();
    await wiki;
    await settled();
    for (let i = 0; i < 200 && getOnDemandRun(db, second.run.id)!.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(getOnDemandRun(db, second.run.id)!.status).toBe('completed');
  });

  it('stops between notes when the server shuts down, and is closed with the daily budget', async () => {
    let asked = 0;
    const model = readingModel();
    const llm: LlmClient = { structuredCall: async request => { asked += 1; return model.llm.structuredCall(request); } };
    const { deps, db } = setup(fourMeetings(), { llm, stopping: () => asked >= 2 });
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'interrupted', counts: { asked: 2, filled: 2 } });
    expect(run.detail).toContain('Start it again to continue');
    expect(getOnDemandRun(db, run.id)!.finished_at).not.toBeNull();
  });

  describe('a run whose process is gone', () => {
    /** A run accepted and then left: its process never reaches the queue. */
    async function abandoned() {
      const { builds } = background();
      const made = setup(fourMeetings(), { builds });
      vi.spyOn(made.deps.queue, 'enqueue').mockImplementation((() => new Promise(() => {})) as typeof made.deps.queue.enqueue);
      const { run } = await startFieldFill(made.deps, { ...REQUEST, limitUsd: 1, trigger: 'cli' });
      expect(run.status).toBe('queued');
      vi.mocked(made.deps.queue.enqueue).mockRestore();
      return { ...made, run };
    }
    const owner = (db: Database.Database, id: string) =>
      db.prepare('SELECT owner_host AS host, owner_pid AS pid, heartbeat_at AS beat FROM on_demand_runs WHERE id = ?').get(id) as { host: string; pid: number; beat: string };

    it('is marked interrupted at once when it ran on this machine and its process no longer exists', async () => {
      const { db, run } = await abandoned();
      const { host, pid } = owner(db, run.id);
      expect(pid).toBe(process.pid);
      const now = new Date();
      // Its process is alive: left alone, however it is asked.
      expect(interruptAbandonedOnDemandRuns(db, { now, host, alive: () => true })).toBe(0);
      expect(getOnDemandRun(db, run.id)!.status).toBe('queued');
      // Gone: marked, once.
      expect(interruptAbandonedOnDemandRuns(db, { now, host, alive: () => false })).toBe(1);
      expect(getOnDemandRun(db, run.id)).toMatchObject({ status: 'interrupted', finished_at: now.toISOString(), detail: expect.stringContaining('Start it again to continue') });
      expect(interruptAbandonedOnDemandRuns(db, { now, host, alive: () => false })).toBe(0);
    });

    it('on another machine is judged by its heartbeat alone', async () => {
      const { db, run } = await abandoned();
      const beat = Date.parse(owner(db, run.id).beat);
      // A process there cannot be looked up from here, so a dead pid says nothing.
      const elsewhere = { host: 'another-machine', alive: () => false };
      expect(interruptAbandonedOnDemandRuns(db, { now: new Date(beat + ON_DEMAND_STALE_MS - 1_000), ...elsewhere })).toBe(0);
      expect(interruptAbandonedOnDemandRuns(db, { now: new Date(beat + ON_DEMAND_STALE_MS + 1_000), ...elsewhere })).toBe(1);
      expect(getOnDemandRun(db, run.id)!.status).toBe('interrupted');
    });

    it('no longer blocks the next run, or its own undo', async () => {
      const { deps, db, run, byId } = await abandoned();
      // The CLI was stopped with Ctrl-C: the row says queued, and nothing owns it.
      db.prepare('UPDATE on_demand_runs SET owner_pid = ? WHERE id = ?').run(2 ** 22 + 12_345, run.id);
      const { builds: _builds, ...inline } = deps;
      const next = await startFieldFill(inline, { ...REQUEST, limitUsd: 1, trigger: 'cli' });
      expect(next).toMatchObject({ started: true, run: { status: 'completed', counts: { filled: 3 } } });
      expect(next.run.id).not.toBe(run.id);
      expect(getOnDemandRun(db, run.id)!.status).toBe('interrupted');
      expect(byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });
      // The abandoned run wrote nothing; undoing it is an empty undo, not a refusal.
      expect(await undoFieldFill(inline, run.id, true)).toMatchObject({ restored: 0 });
    });

    it('beats while it waits its turn, so a live run is never taken for abandoned', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const { builds } = background();
        const { deps, db } = setup(fourMeetings(), { builds });
        // The lane is held by a long build: the run is accepted and waits.
        let release!: () => void;
        const held = deps.queue.enqueue('a long build', () => new Promise<void>(resolve => { release = resolve; }));
        const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
        const first = Date.parse(owner(db, run.id).beat);
        await vi.advanceTimersByTimeAsync(ON_DEMAND_STALE_MS * 3);
        expect(Date.parse(owner(db, run.id).beat)).toBeGreaterThan(first + ON_DEMAND_STALE_MS * 2);
        expect(interruptAbandonedOnDemandRuns(db, { now: new Date(), host: 'another-machine', alive: () => false })).toBe(0);
        expect(getOnDemandRun(db, run.id)!.status).toBe('queued');
        release();
        await held;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('records its summary without touching the journal context of the job that follows it', async () => {
    const { builds, settled } = background();
    const { deps, db } = setup(fourMeetings(), { builds });
    const recorder = deps.recorder!;
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    // A wiki build queued behind the run: it sets its context, works for a while, then records.
    const wiki = deps.queue.enqueue('a wiki build', async () => {
      recorder.setContext({ runRef: 'wiki-run', trigger: 'on-demand', fn: 'wiki-curation' });
      await new Promise(resolve => setTimeout(resolve, 30));
      recorder.record({ action: 'wiki-written', detail: 'a page' });
      recorder.setContext(null);
    });
    await Promise.all([settled(), wiki]);
    expect(db.prepare("SELECT run_ref, function FROM journal_events WHERE action = 'wiki-written'").get())
      .toEqual({ run_ref: 'wiki-run', function: 'wiki-curation' });
    expect(db.prepare("SELECT run_ref, function, kind FROM journal_events WHERE run_ref = ?").all(run.id))
      .toEqual([{ run_ref: run.id, function: 'field-guess-sweep', kind: 'summary' }]);
  });

  it('lets only one of two processes start: the other is handed the run that won', async () => {
    const { deps, db, engine, requests } = setup(fourMeetings());
    // While this process counts its scope, a CLI sharing the database starts a run of its own.
    const list = engine.listFieldGuessCandidates.getMockImplementation()!;
    let raced = false;
    engine.listFieldGuessCandidates.mockImplementation(async input => {
      if (!raced) {
        raced = true;
        db.prepare(`
          INSERT INTO on_demand_runs (id, status, request_json, limit_usd, model, provider, trigger, notes, counts_json, created_at, owner_host, owner_pid, heartbeat_at)
          VALUES ('their-run', 'running', '{"fields":["date"]}', 1, ?, 'fireworks', 'cli', 4, '{}', ?, 'another-machine', 1, ?)
        `).run(MODEL, new Date().toISOString(), new Date().toISOString());
      }
      return list(input);
    });
    const result = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(result).toMatchObject({ started: false, run: { id: 'their-run', status: 'running' } });
    // Nothing of ours was recorded, asked or written.
    expect(db.prepare('SELECT id FROM on_demand_runs').all()).toEqual([{ id: 'their-run' }]);
    expect(requests).toHaveLength(0);
    expect(engine.updateNodeFieldsCas).not.toHaveBeenCalled();
  });

  it('does nothing for a run it has no record of', async () => {
    const { deps, engine } = setup(fourMeetings());
    await runFieldFill(deps, 'no-such-run');
    expect(engine.listFieldGuessCandidates).not.toHaveBeenCalled();
  });
});

describe('status and undo', () => {
  it('lists recent runs, shows one, and undoes a run as one request', async () => {
    const { deps, byId, engine } = setup(fourMeetings());
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });

    expect(fieldFillStatus(deps, run.id)).toMatchObject({ run: { run_id: run.id, status: 'completed', fields: ['date', 'company'], undoable_notes: 3 } });
    expect(fieldFillStatus(deps)).toMatchObject({ runs: [{ run_id: run.id }] });
    expect(() => fieldFillStatus(deps, 'nope')).toThrow(OnDemandError);

    // A dry run by default: says what would be put back.
    // (No note about replaced values: this run replaced none.)
    expect(await undoFieldFill(deps, run.id, true)).toEqual({
      run_id: run.id, dry_run: true, restored: 3, conflicts: [], conflict_count: 0, no_longer_undoable: 0,
    });
    expect(byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });

    expect(await undoFieldFill(deps, run.id, false)).toMatchObject({ dry_run: false, restored: 3, no_longer_undoable: 0 });
    expect(engine.undoOperations).toHaveBeenLastCalledWith(['op-1', 'op-2', 'op-3'], false);
    expect(byId.get('m1')!.fields).toEqual({});
    expect(byId.get('m3')!.fields).toEqual({});
    expect(fieldFillStatus(deps, run.id)).toMatchObject({ run: { undoable_notes: 0, undone_at: expect.any(String) } });
    await expect(undoFieldFill(deps, run.id, false)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('can be run again after an undo: what it set is asked again, what the model declined is not', async () => {
    const { deps, byId, requests } = setup(fourMeetings());
    const first = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(first.run.counts).toMatchObject({ asked: 4, filled: 3, fields_set: 5 });
    await undoFieldFill(deps, first.run.id, false);
    expect([...byId.values()].every(note => Object.keys(note.fields).length === 0)).toBe(true);
    expect(requests).toHaveLength(4);

    // The undo put every note back as it was. The ledger still holds the first run's answers, and
    // only an answer of "the note does not say" stops a field being asked again.
    const again = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    expect(again.run).toMatchObject({
      status: 'completed', notes: 4,
      // Note 4 gave nothing the first time and is unchanged, so it is not paid for again.
      counts: { asked: 3, filled: 3, left_empty: 0, already_asked: 1, fields_set: 5 },
    });
    expect(byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });
    expect(byId.get('m3')!.fields).toEqual({ date: '2024-03-15' });
    expect(requests).toHaveLength(7);
    // Note 3's company was declined the first time, so only its date is offered now.
    expect(requests[6]!.user).toContain('"field":"date"');
    expect(requests[6]!.user).not.toContain('"field":"company"');
  });

  it('reports notes edited since and writes the Engine no longer keeps', async () => {
    const { deps, engine } = setup(fourMeetings());
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    engine.undoOperations.mockResolvedValueOnce({
      dry_run: false, total_undone: 1, total_conflicts: 1, total_skipped: 1,
      conflicts: [{ node_id: 'm2', reason: 'modified_after_operation' }], not_found: ['op-3'],
    });
    expect(await undoFieldFill(deps, run.id, false)).toEqual({
      run_id: run.id, dry_run: false, restored: 1, conflicts: [{ node_id: 'm2', reason: 'modified_after_operation' }],
      conflict_count: 1, no_longer_undoable: 1,
    });
  });

  it('counts a note once in the undo preview when the Engine lists it under two reasons', async () => {
    const { deps, engine } = setup(fourMeetings());
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    // Note 2 was edited, by a later Engine operation: one note, two conflict entries.
    engine.undoOperations.mockResolvedValueOnce({
      dry_run: true, total_undone: 0, total_conflicts: 2, total_skipped: 0, not_found: [],
      conflicts: [{ node_id: 'm2', reason: 'modified_after_operation' }, { node_id: 'm2', reason: 'superseded_by_later_op' }],
    });
    // Three notes were written and one is in conflict, so two would be restored.
    expect(await undoFieldFill(deps, run.id, true)).toEqual({
      run_id: run.id, dry_run: true, restored: 2, conflict_count: 1,
      conflicts: [{ node_id: 'm2', reason: 'modified_after_operation, superseded_by_later_op' }], no_longer_undoable: 0,
    });
  });

  it('refuses to undo without a run, or one still in progress', async () => {
    const { deps, db } = setup(fourMeetings());
    await expect(undoFieldFill(deps, undefined, true)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(undoFieldFill(deps, 'nope', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'on-demand' });
    db.prepare("UPDATE on_demand_runs SET status = 'running' WHERE id = ?").run(run.id);
    await expect(undoFieldFill(deps, run.id, true)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('the CLI', () => {
  const ARGS: FieldFillCliArgs = {
    dryRun: false, preview: false, fillFields: ['date', 'company'], fillTypes: ['meeting'], fillPath: null,
    limitUsd: null, sample: null, undoFill: null, replaceInvalid: false,
  };
  const cli = async (deps: FieldFillDeps, args: Partial<FieldFillCliArgs>) => {
    const lines: string[] = [];
    const result = await fieldFillCli(deps, { ...ARGS, ...args }, line => lines.push(line), { on: () => undefined, off: () => undefined });
    return { ...result, lines };
  };

  it('calls no model for a plain dry run, or with no flag to run under', async () => {
    for (const args of [{ dryRun: true }, {}, { dryRun: true, limitUsd: 1 }] as Array<Partial<FieldFillCliArgs>>) {
      const { deps, engine, requests, byId } = setup(fourMeetings());
      const { lines, failed } = await cli(deps, args);
      expect(failed).toBe(false);
      expect(requests).toHaveLength(0);
      expect(engine.getNode).not.toHaveBeenCalled();
      expect(engine.updateNodeFieldsCas).not.toHaveBeenCalled();
      expect(byId.get('m1')!.fields).toEqual({});
      expect(lines[0]).toBe(`4 note(s) in scope; model ${MODEL} on fireworks`);
      expect(lines[lines.length - 1]).toContain('no model was called; --preview tries it on a sample');
    }
    expect(fieldFillCliMode({ ...ARGS, dryRun: true, limitUsd: 1 })).toBe('count');
  });

  it('makes the paid sample only for --preview, and runs only with a limit', async () => {
    const previewed = setup(fourMeetings());
    // --preview sets dryRun too, as it does for every command.
    const preview = await cli(previewed.deps, { dryRun: true, preview: true, sample: 2 });
    expect(previewed.requests).toHaveLength(2);
    expect(previewed.byId.get('m1')!.fields).toEqual({});
    expect(preview.lines.join('\n')).toContain('sample "Sync 1": {"date":"2024-03-01","company":"Acme"}');
    expect(preview.lines[preview.lines.length - 1]).toMatch(/^estimated cost \$0\.01, about 1 minute\(s\); to run it use --limit-usd 0\.05 in place of --preview$/);

    const ran = setup(fourMeetings());
    const run = await cli(ran.deps, { limitUsd: 1 });
    expect(run.failed).toBe(false);
    expect(run.lines[0]).toMatch(/^COMPLETED  run \S+: 3 of 4 note\(s\) filled, 5 field\(s\) set, 1 left empty/);
    expect(run.lines[run.lines.length - 1]).toMatch(/^  undo it with --undo-fill \S+$/);
    expect(ran.byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });
  });

  it('ends a run after the note in hand on Ctrl-C, recorded as interrupted', async () => {
    const { deps, db } = setup(fourMeetings());
    let interrupt: (() => void) | undefined;
    const lines: string[] = [];
    const exits: number[] = [];
    const model = readingModel();
    let asked = 0;
    const llm: LlmClient = { structuredCall: async request => {
      asked += 1;
      if (asked === 2) interrupt!();
      return model.llm.structuredCall(request);
    } };
    const runBudget: RunBudgetFactory = run => createRunBudget({
      llm, policy: { capUsd: 1, tz: 'UTC', pricing: () => PRICE }, engine: deps.engine, limitUsd: run.limitUsd, runRef: run.runRef,
    });
    const result = await fieldFillCli({ ...deps, runBudget }, { ...ARGS, limitUsd: 1 }, line => lines.push(line),
      { on: (_event, listener) => { interrupt = listener; }, off: () => { interrupt = undefined; } }, code => { exits.push(code); });
    expect(result.failed).toBe(false);
    expect(lines).toContain('stopping after the current note (Ctrl-C again to stop at once)');
    expect(lines.find(line => line.startsWith('INTERRUPTED'))).toMatch(/2 of 4 note\(s\) filled/);
    expect(db.prepare("SELECT status FROM on_demand_runs").all()).toEqual([{ status: 'interrupted' }]);
    // The listener is taken off again, and nothing asked the process to exit.
    expect(interrupt).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it('says how many values fail their type, and replaces them only with --replace-invalid', async () => {
    const notes = (): Note[] => [meeting(1, 'Date: 2024-03-01'), meeting(2, 'Date: 2024-03-08', { date: 'TBD' })];
    const counted = await cli(setup(notes()).deps, { fillFields: ['date'], dryRun: true });
    expect(counted.lines.slice(1, 3)).toEqual([
      '  date: empty on 1; 1 hold a value that fails its type',
      '  1 value(s) fail their field\'s type (a date field holding "TBD", say) and are left as they are. Add --replace-invalid to have them replaced where the note gives a value.',
    ]);
    const previewed = await cli(setup(notes()).deps, { fillFields: ['date'], dryRun: true, preview: true, replaceInvalid: true });
    expect(previewed.lines).toContain('  sample "Sync 2": {"date":"2024-03-08"}; replaces {"date":"TBD"}');
    const ran = setup(notes());
    await cli(ran.deps, { fillFields: ['date'], limitUsd: 1, replaceInvalid: true });
    expect(ran.byId.get('m2')!.fields.date).toBe('2024-03-08');
    expect(() => checkFieldFillArgs({ ...ARGS, fillFields: null, fillTypes: null, replaceInvalid: true })).toThrow('go with --fill-fields');
  });

  it('refuses a flag with no value rather than reading it as absent', () => {
    // At the end of the line, before another flag, or blank: each would have dropped a restriction.
    expect(() => flagValue('--path', undefined)).toThrow('--path needs a value');
    expect(() => flagValue('--path', '--limit-usd')).toThrow('--path needs a value');
    expect(() => flagValue('--project', '  ')).toThrow('--project needs a value');
    expect(flagValue('--path', 'Archive/2021')).toBe('Archive/2021');
    expect(() => flagList('--types', undefined)).toThrow('--types needs a value');
    expect(() => flagList('--types', ' , ')).toThrow('--types needs a comma-separated list of names');
    expect(flagList('--fill-fields', 'date, people')).toEqual(['date', 'people']);
  });

  it('refuses flags that would not mean what they say', () => {
    expect(() => checkFieldFillArgs({ ...ARGS, sample: 3 })).toThrow('--sample goes with --preview');
    expect(() => checkFieldFillArgs({ ...ARGS, preview: true, dryRun: true, sample: 3 })).not.toThrow();
    expect(() => checkFieldFillArgs({ ...ARGS, fillFields: null, fillTypes: ['meeting'] })).toThrow('go with --fill-fields');
    expect(() => checkFieldFillArgs({ ...ARGS, fillFields: [] })).toThrow('comma-separated list');
    expect(() => checkFieldFillArgs({ ...ARGS, limitUsd: 0 })).toThrow('positive number of dollars');
    expect(() => checkFieldFillArgs({ ...ARGS, fillFields: null, fillTypes: null })).not.toThrow();
  });

  it('undoes a run, as a dry run first', async () => {
    const { deps, byId } = setup(fourMeetings());
    const { run } = await startFieldFill(deps, { ...REQUEST, limitUsd: 1, trigger: 'cli' });
    expect((await cli(deps, { undoFill: run.id, dryRun: true, fillFields: null, fillTypes: null })).lines)
      .toEqual(['would put back 3 note(s); 0 edited since and left alone; 0 no longer undoable']);
    expect(byId.get('m1')!.fields).toEqual({ date: '2024-03-01', company: 'Acme' });
    expect((await cli(deps, { undoFill: run.id, fillFields: null, fillTypes: null })).lines[0]).toMatch(/^put back 3 note\(s\)/);
    expect(byId.get('m1')!.fields).toEqual({});
  });
});

describe('the fill-fields tool', () => {
  const call = async (deps: FieldFillDeps, args: Record<string, unknown>, scopes = ['curate:trigger']) => {
    const result = await makeFillFieldsHandler(deps)({ action: 'preview', ...args } as never, { authInfo: { scopes } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, any>;
    parsed.isError = result.isError === true;
    return parsed;
  };

  it('needs the trigger scope', async () => {
    const { deps } = setup(fourMeetings());
    expect(await call(deps, REQUEST, ['curate:read'])).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' }, isError: true });
  });

  it('previews with the call that starts the run, at a suggested limit', async () => {
    const { deps } = setup(fourMeetings());
    const preview = await call(deps, REQUEST);
    expect(preview).toMatchObject({
      ok: true, notes: 4, sample_asked: 4,
      next: { tool: 'fill-fields', arguments: { action: 'start', fields: ['date', 'company'], query: { types: ['meeting'] }, limit_usd: 0.05 } },
    });
    expect(preview.daily_cap_note).toContain('paid from today\'s cap');
    // Said whenever a sample call was sent, even when none gave a result.
    const billed: LlmClient = { structuredCall: async () => { throw new StructuredCallFailure('structured call failed (reason=truncated)', USAGE, 'truncated'); } };
    expect((await call(setup(fourMeetings(), { llm: billed }).deps, REQUEST)).daily_cap_note).toContain('paid from today\'s cap');
    // Nothing to run: no call is offered, and no sample was paid for.
    const empty = await call(setup([meeting(1, 'x', { date: '2024-01-01', company: 'Acme' })]).deps, REQUEST);
    expect(empty).toMatchObject({ ok: true, notes: 0 });
    expect(empty.next).toBeUndefined();
    expect(empty.daily_cap_note).toBeUndefined();
  });

  it('replaces values that fail their type only when asked, and says so in the call it offers', async () => {
    const notes = (): Note[] => [meeting(1, 'Date: 2024-03-01'), meeting(2, 'Date: 2024-03-08', { date: 'TBD' })];
    const plain = await call(setup(notes()).deps, { fields: ['date'] });
    expect(plain).toMatchObject({ ok: true, notes: 1, replace_invalid: false, fields: { date: { empty: 1, invalid: 1 } } });
    expect(plain.next.arguments).toEqual({ action: 'start', fields: ['date'], limit_usd: 0.05 });

    const replacing = setup(notes());
    const preview = await call(replacing.deps, { fields: ['date'], replace_invalid: true });
    expect(preview).toMatchObject({ ok: true, notes: 2, replace_invalid: true });
    expect(preview.next.arguments).toEqual({ action: 'start', fields: ['date'], replace_invalid: true, limit_usd: 0.05 });
    const started = await call(replacing.deps, preview.next.arguments);
    expect(started).toMatchObject({ ok: true, status: 'completed', replace_invalid: true, counts: { filled: 2, fields_replaced: 1 } });
    expect(replacing.byId.get('m2')!.fields.date).toBe('2024-03-08');
    expect(await call(replacing.deps, { action: 'status', replace_invalid: true })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('starts, reports and undoes through one tool', async () => {
    const { deps, byId } = setup(fourMeetings());
    const started = await call(deps, { ...REQUEST, action: 'start', limit_usd: 1 });
    expect(started).toMatchObject({ ok: true, started: true, status: 'completed', counts: { filled: 3 } });
    expect(await call(deps, { action: 'status', run_id: started.run_id })).toMatchObject({ ok: true, run: { run_id: started.run_id, undoable_notes: 3 } });
    expect(await call(deps, { action: 'undo', run_id: started.run_id })).toMatchObject({ ok: true, dry_run: true, restored: 3 });
    expect(await call(deps, { action: 'undo', run_id: started.run_id, dry_run: false })).toMatchObject({ ok: true, dry_run: false, restored: 3 });
    expect(byId.get('m1')!.fields).toEqual({});
  });

  it('names a parameter that belongs to another action, and returns refusals as errors', async () => {
    const { deps } = setup(fourMeetings());
    expect(await call(deps, { ...REQUEST, limit_usd: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: 'preview takes fields, query, sample and replace_invalid; not limit_usd.' } });
    expect(await call(deps, { action: 'status', fields: ['date'] })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call(deps, { ...REQUEST, action: 'start' })).toMatchObject({ ok: false, isError: true, error: { code: 'INVALID_PARAMS', message: expect.stringContaining('limit_usd') } });
    // The Engine's own words, without the client's prefix.
    expect(await call(deps, { action: 'start', fields: ['mood'], limit_usd: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS', message: 'No type claims "mood".' } });
  });
});
