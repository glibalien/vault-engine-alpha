import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ModelPricing } from '@vault/pricing';
import { createRunBudget, DailyBudget, type DailyBudgetPolicy, type RunBudgetFactory } from '../src/budget.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Engine, SubjectPassMemory, SubjectPassResult } from '../src/engine.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import type { LlmClient, StructuredCallRequest, StructuredCallResult } from '../src/llm/types.js';
import {
  SUBJECTS_SYSTEM_PROMPT,
  buildSubjectsUser,
  namedInMemory,
  parseSubjectAnswers,
  previewSubjectRun,
  startSubjectRun,
  subjectCallMaxTokens,
  subjectRunStatus,
  undoSubjectRun,
} from '../src/memory-subjects/run.js';
import type { OnDemandDeps } from '../src/on-demand/run.js';
import { viewOnDemandRun } from '../src/on-demand/views.js';
import { CurationQueue } from '../src/queue.js';
import { makeGuessMemorySubjectsHandler } from '../src/tools/guess-memory-subjects.js';
import type { CoreDeps } from '../src/core.js';

const MODEL = 'accounts/fireworks/models/small';
const PRICE: ModelPricing = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
const USAGE = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 };
/** One call at PRICE: 1,000 input and 100 output tokens. */
const CALL_USD = 0.002;

const CONFIG = {
  model: 'home-model',
  memorySweepModel: MODEL,
  memorySweepMaxTokens: 4000,
  modelProviders: { [MODEL]: 'fireworks' },
  modelPricing: { [MODEL]: PRICE },
  vault: { ownerNote: 'Avery Stone' },
  curatorTz: 'UTC',
  journalEnabled: false,
} as unknown as Config;

/** The entity notes the fake Engine resolves names against. */
const NOTES: Record<string, string> = { 'dana whitfield': 'Dana Whitfield', acme: 'Acme' };

interface StoredMemory extends Omit<SubjectPassMemory, 'subjects'> { live: boolean; subjects: Array<{ name: string; by: string; at: string }> }

/** The Engine's memory-subject-pass, over memories in memory: names resolve by title, the owner is left out. */
function engineOf(memories: StoredMemory[]) {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  let writes = 0;
  const engine = {
    listSubjectPassMemories: vi.fn(async (afterId: number, limit: number) => {
      // Live, with no subject but the free match's.
      const scope = memories.filter(memory => memory.live && memory.subjects.every(subject => subject.by === 'match') && memory.id > afterId);
      const page = scope.slice(0, limit);
      return {
        memories: page.map(({ live: _live, subjects, ...shown }) => ({ ...shown, subjects: subjects.map(subject => subject.name) })),
        total: scope.length,
        next_after_id: scope.length > limit ? page[page.length - 1]!.id : null,
      };
    }),
    writeModelSubjects: vi.fn(async (items: ReadonlyArray<{ memory_id: number; subjects: readonly string[] }>, dryRun: boolean) => {
      const results: SubjectPassResult[] = [];
      const at = `2026-11-20T12:00:00.${String(writes++).padStart(3, '0')}Z`;
      let written = 0;
      let subjects = 0;
      for (const item of items) {
        const memory = byId.get(item.memory_id);
        if (memory === undefined) { results.push({ memory_id: item.memory_id, outcome: 'not_found', subjects: [] }); continue; }
        if (!memory.live) { results.push({ memory_id: item.memory_id, outcome: 'not_live', subjects: [] }); continue; }
        if (memory.subjects.some(subject => subject.by !== 'match')) { results.push({ memory_id: item.memory_id, outcome: 'has_subjects', subjects: [] }); continue; }
        const had = new Set(memory.subjects.map(subject => subject.name.toLowerCase()));
        const names = item.subjects.filter(name => !/^avery( stone)?$/i.test(name) && !had.has(name.toLowerCase()));
        if (names.length === 0) { results.push({ memory_id: item.memory_id, outcome: 'none', subjects: [] }); continue; }
        if (!dryRun) memory.subjects = [...memory.subjects, ...names.map(name => ({ name, by: 'model', at }))];
        written += 1;
        subjects += names.length;
        results.push({
          memory_id: item.memory_id, outcome: 'written', written_at: at,
          subjects: names.map(name => {
            const title = NOTES[name.toLowerCase()] ?? null;
            return { name, status: title === null ? 'unresolved' as const : 'linked' as const, title };
          }),
        });
      }
      return { results, memories: written, subjects };
    }),
    clearModelSubjects: vi.fn(async (writes: ReadonlyArray<{ memory_id: number; written_at: string }>, dryRun: boolean) => {
      const ours = (write: { memory_id: number; written_at: string }) => (subject: { by: string; at: string }) =>
        subject.by === 'model' && subject.at === write.written_at;
      const cleared = writes.filter(write => byId.get(write.memory_id)?.subjects.some(ours(write)));
      let subjects = 0;
      for (const write of cleared) {
        const memory = byId.get(write.memory_id)!;
        subjects += memory.subjects.filter(ours(write)).length;
        if (!dryRun) memory.subjects = memory.subjects.filter(subject => !ours(write)(subject));
      }
      return { cleared: cleared.map(write => write.memory_id), subjects };
    }),
    usageReport: vi.fn(async () => ({ data: { groups: [], totals: { cost_usd: 0 } }, warnings: [] })),
  };
  return { engine, byId };
}

/**
 * Names in each memory line the people and companies it mentions: "Dana" as the source note's
 * full name when that note lists her, "Acme" as it is, "Avery" (the owner) never. It answers for
 * every memory unless told to skip one.
 */
function namingModel(options: { skip?: number[]; malformed?: number[]; copySourceNames?: boolean } = {}) {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    structuredCall: vi.fn(async (request: StructuredCallRequest): Promise<StructuredCallResult> => {
      requests.push(request);
      const entries = request.user.split('\n[').slice(1).map(block => {
        const id = Number(/^(\d+)\]/.exec(block)![1]);
        const subjects: string[] = [];
        if (/\bDana\b/.test(block.split('\n')[0]!)) subjects.push(block.includes('names there: Dana Whitfield') ? 'Dana Whitfield' : 'Dana');
        if (/\bAcme\b/.test(block.split('\n')[0]!)) subjects.push('Acme');
        if (/\bJordan Lee\b/.test(block.split('\n')[0]!)) subjects.push('Jordan Lee');
        // What the model did on the owner's vault: every name the source note holds, mentioned or not.
        if (options.copySourceNames) {
          for (const name of /names there: (.*)$/m.exec(block)?.[1]?.split('; ') ?? []) if (!subjects.includes(name)) subjects.push(name);
        }
        return { id, subjects };
      }).map(entry => {
        // Only the names missing from what the memory has already.
        const has = /^\s+has: (.*)$/m.exec(request.user.split('\n[').find(block => block.startsWith(`${entry.id}]`)) ?? '')?.[1]?.split('; ') ?? [];
        return { ...entry, subjects: entry.subjects.filter(name => !has.includes(name)) };
      }).filter(entry => !(options.skip ?? []).includes(entry.id))
        .map(entry => ((options.malformed ?? []).includes(entry.id) ? { id: entry.id } : entry));
      return { output: { memories: entries }, usage: USAGE };
    }),
  };
  return { llm, requests };
}

const memory = (id: number, content: string, source?: { title: string; names: string[] }): StoredMemory => ({
  id, content, category: 'fact', source_title: source?.title ?? null, source_names: source?.names ?? [], live: true, subjects: [],
});

const CALL = { title: 'Renewal call', names: ['Dana Whitfield', 'Acme'] };

/** A stored memory as the Engine lists it. */
const shown = ({ live: _live, subjects, ...rest }: StoredMemory): SubjectPassMemory => ({ ...rest, subjects: subjects.map(subject => subject.name) });

/** Four memories with no subjects: one naming Dana by first name, one Acme, one about the owner alone, and one from a chat. */
const fourMemories = (): StoredMemory[] => [
  memory(1, 'Dana takes the renewal from here.', CALL),
  memory(2, 'Acme wants a two-year term.', CALL),
  memory(3, 'Avery prefers short agendas.'),
  memory(4, 'Dana asked about Acme pricing.'),
];

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(memories: StoredMemory[], options: { llm?: LlmClient; config?: Partial<Config>; usage?: OnDemandDeps['usage'] } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  databases.push(db);
  const store = engineOf(memories);
  const model = namingModel();
  const llm = options.llm ?? model.llm;
  const config = { ...CONFIG, ...options.config } as Config;
  const policy: DailyBudgetPolicy = { capUsd: 1, tz: 'UTC', pricing: name => config.modelPricing?.[name] ?? null };
  const budgets = new Set<DailyBudget>();
  const runBudget: RunBudgetFactory = run => createRunBudget({
    llm, policy, engine: store.engine as unknown as Engine, limitUsd: run.limitUsd, runRef: run.runRef, budgets,
  });
  const deps: OnDemandDeps = {
    engine: store.engine as unknown as Engine, llm, config, queue: new CurationQueue(), db, recorder: new ActionRecorder(db), runBudget,
    ...(options.usage ? { usage: options.usage } : {}),
  };
  return { deps, db, requests: model.requests, ...store };
}

const subjectsOf = (byId: Map<number, StoredMemory>): Record<number, string[]> =>
  Object.fromEntries([...byId].map(([id, each]) => [id, each.subjects.map(subject => subject.name)]));

describe('the subject call', () => {
  it('shows each memory with its source note and the names there, and names the owner first', () => {
    const user = buildSubjectsUser(fourMemories().map(shown), 'Avery Stone');
    expect(user).toBe('VAULT OWNER (never a subject): Avery Stone\nMEMORIES:\n'
      + '[1] Dana takes the renewal from here.\n  from: "Renewal call"; names there: Dana Whitfield; Acme\n'
      + '[2] Acme wants a two-year term.\n  from: "Renewal call"; names there: Dana Whitfield; Acme\n'
      + '[3] Avery prefers short agendas.\n'
      + '[4] Dana asked about Acme pricing.');
    expect(buildSubjectsUser([shown(memory(5, 'A note.', { title: 'Inbox', names: [] }))], null)).toBe('MEMORIES:\n[5] A note.\n  from: "Inbox"');
    // What the memory is already about comes first.
    expect(buildSubjectsUser([{ ...shown(memory(6, 'Acme hired Jordan Lee.', CALL)), subjects: ['Acme'] }], null))
      .toBe('MEMORIES:\n[6] Acme hired Jordan Lee.\n  has: Acme\n  from: "Renewal call"; names there: Dana Whitfield; Acme');
    expect(SUBJECTS_SYSTEM_PROMPT).toContain('Never list the vault\'s owner');
  });

  it('keeps a name only when the memory mentions its first word', () => {
    expect(namedInMemory('Tomas Lind', 'Avery reports to Tomas in sales.')).toBe(true);
    expect(namedInMemory('Northwind', "Northwind's integration has no contract cost.")).toBe(true);
    expect(namedInMemory('Priya Raman', "Northwind's integration has no contract cost.")).toBe(false);
    // A shared surname is not enough.
    expect(namedInMemory('Ruth Okafor', 'His father Sam Okafor helped with the financing.')).toBe(false);
    expect(namedInMemory('Sam Okafor', 'His father Sam Okafor helped with the financing.')).toBe(true);
    // "The" is no name's first word.
    expect(namedInMemory('The Harbor Investment Company', 'The company has an open opportunity.')).toBe(false);
    expect(namedInMemory('The Harbor Investment Company', 'Harbor has an open opportunity.')).toBe(true);
    expect(namedInMemory('Contoso.ai', 'Bullish on companies like Contoso.ai.')).toBe(true);
    expect(namedInMemory('Anne-Marie Lowe', 'Anne-Marie leads the review.')).toBe(true);
    expect(namedInMemory('  ', 'Anything.')).toBe(false);
  });

  it('keeps answers for the memories asked about only, each once', () => {
    const answers = parseSubjectAnswers({
      memories: [
        { id: 1, subjects: [' Dana Whitfield ', 'dana whitfield', ''] },
        { id: '2', subjects: ['Acme'] },
        { id: 1, subjects: ['Someone else'] },
        { id: 99, subjects: ['Acme'] },
        { id: 3 },
        'junk',
      ],
    }, new Set([1, 2, 3]));
    // No subjects list is no answer: memory 3 is asked again, not taken for "no one" (Codex, #695).
    expect([...answers]).toEqual([[1, ['Dana Whitfield']], [2, ['Acme']]]);
    expect([...parseSubjectAnswers({ memories: [{ id: 3, subjects: [] }, { id: 4, subjects: 'Acme' }] }, new Set([3, 4]))]).toEqual([[3, []]]);
    expect(parseSubjectAnswers(null, new Set([1])).size).toBe(0);
  });
});

describe('previewSubjectRun', () => {
  it('counts the memories with no subjects and shows what the model would give a sample, writing nothing', async () => {
    const { deps, db, engine, byId, requests } = setup(fourMemories());
    const preview = await previewSubjectRun(deps, { sample: 4 });

    expect(preview).toMatchObject({
      memories: 4, already_asked: 0, scope_note: null, model: MODEL, provider: 'fireworks', owner: 'Avery Stone', sample_asked: 1,
      sample_counts: { given: 3, none: 1, linked: 3, unmatched: 1, dropped: 0 },
    });
    expect(preview.sample).toEqual([
      { id: 1, content: 'Dana takes the renewal from here.', source_title: 'Renewal call', outcome: 'given',
        subjects: [{ name: 'Dana Whitfield', status: 'linked', title: 'Dana Whitfield' }] },
      { id: 2, content: 'Acme wants a two-year term.', source_title: 'Renewal call', outcome: 'given',
        subjects: [{ name: 'Acme', status: 'linked', title: 'Acme' }] },
      { id: 3, content: 'Avery prefers short agendas.', source_title: null, outcome: 'none', subjects: [] },
      { id: 4, content: 'Dana asked about Acme pricing.', source_title: null, outcome: 'given',
        subjects: [{ name: 'Dana', status: 'unresolved', title: null }, { name: 'Acme', status: 'linked', title: 'Acme' }] },
    ]);
    // One call for the four memories: the estimate is per memory.
    expect(preview.sample_cost_usd).toBeCloseTo(CALL_USD, 10);
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe(MODEL);
    expect(requests[0]!.system).toBe(SUBJECTS_SYSTEM_PROMPT);
    expect(requests[0]!.user.startsWith('VAULT OWNER (never a subject): Avery Stone\n')).toBe(true);

    // The Engine was asked as a dry run, and nothing was written or remembered.
    expect(engine.writeModelSubjects.mock.calls.every(([, dryRun]) => dryRun)).toBe(true);
    expect(subjectsOf(byId)).toEqual({ 1: [], 2: [], 3: [], 4: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM on_demand_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subject_run_verdicts').get()).toEqual({ n: 0 });
  });

  it('asks 20 memories to a call, and spreads its sample through the set', async () => {
    const many = Array.from({ length: 50 }, (_, index) => memory(index + 1, `Memory ${index + 1} about Acme.`));
    const { deps, requests } = setup(many);
    const preview = await previewSubjectRun(deps, { sample: 25 });
    expect(requests).toHaveLength(2);
    expect(preview.sample_asked).toBe(2);
    expect(preview.sample.map(each => each.id).slice(0, 4)).toEqual([1, 3, 5, 7]);
    // Two calls for 25 memories: 0.004 / 25 per memory, times 50.
    expect(preview.estimated_cost_usd).toBe(0.01);
    expect((await previewSubjectRun(setup(many).deps, { sample: 0 }))).toMatchObject({ memories: 50, sample: [], sample_asked: 0, estimated_cost_usd: null });
  });

  it('sends the sample\'s calls side by side, each with room for a reasoning model to answer, each under its own label', async () => {
    let inFlight = 0;
    let most = 0;
    const naming = namingModel();
    const slow: LlmClient = {
      structuredCall: async request => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise(resolve => setTimeout(resolve, 20));
        inFlight -= 1;
        return naming.llm.structuredCall(request);
      },
    };
    const contexts: unknown[] = [];
    const usage = {
      setContext: vi.fn(),
      withContext: vi.fn(async (context: unknown, work: () => Promise<unknown>) => { contexts.push(context); return work(); }),
    } as unknown as OnDemandDeps['usage'];
    const many = Array.from({ length: 60 }, (_, index) => memory(index + 1, `Memory ${index + 1} about Acme.`));
    const preview = await previewSubjectRun(setup(many, { llm: slow, usage }).deps, { sample: 60 });
    expect(preview).toMatchObject({ sample_asked: 3, sample_counts: { given: 60 } });
    expect(most).toBe(3);
    // The sample keeps the scope's order, whichever call answered first.
    expect(preview.sample.map(each => each.id)).toEqual(many.map(each => each.id));
    // The memory sweep's 4,000 tokens cut a reasoning model off; a call gets at least 8,000.
    expect(naming.requests.map(request => request.maxTokens)).toEqual([8_000, 8_000, 8_000]);
    expect(subjectCallMaxTokens({ memorySweepMaxTokens: 12_000 })).toBe(12_000);
    // Each call is labelled in its own scope; the shared slot is left alone.
    expect(contexts).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ purpose: 'memory-sweep', project: 'guess-memory-subjects' })));
    expect(usage!.setContext).not.toHaveBeenCalled();
  });

  it('uses the home model when no memory sweep model is set, and names that setting when its key is missing', async () => {
    const config = {
      memorySweepModel: null, modelProviders: { 'home-model': 'anthropic' }, modelPricing: { 'home-model': PRICE },
      llmKeys: { keys: { fireworks: 'k' } },
    } as unknown as Partial<Config>;
    const { deps, requests } = setup(fourMemories(), { config });
    const preview = await previewSubjectRun(deps, {});
    expect(preview).toMatchObject({ model: 'home-model', provider: 'anthropic', sample: [], sample_asked: 0 });
    expect(preview.sample_note).toMatch(/^No sample was run: the Curator has no key for anthropic/);
    expect(requests).toHaveLength(0);
  });
});

describe('a subject run', () => {
  it('gives each memory the model names someone in its subjects, remembers the rest, and undoes as one request', async () => {
    const { deps, db, byId } = setup(fourMemories());
    const { run, started } = await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(started).toBe(true);
    expect(run).toMatchObject({
      job: 'guess-memory-subjects', status: 'completed', notes: 4, detail: null,
      counts: { asked: 4, given: 3, none: 1, changed: 0, unanswered: 0, errors: 0, subjects: 4, linked: 3, unmatched: 1 },
    });
    expect(run.spent_usd).toBeCloseTo(CALL_USD, 10);
    expect(subjectsOf(byId)).toEqual({ 1: ['Dana Whitfield'], 2: ['Acme'], 3: [], 4: ['Dana', 'Acme'] });
    expect(db.prepare('SELECT memory_id FROM subject_run_verdicts').all()).toEqual([{ memory_id: 3 }]);

    // A run started again has nothing left to ask: the owner's memory was answered.
    await expect(startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' })).rejects.toMatchObject({
      code: 'NOTHING_TO_DO', message: expect.stringContaining('the 1 live memories in scope were already asked'),
    });
    expect(await previewSubjectRun(deps, { sample: 0 })).toMatchObject({ memories: 0, already_asked: 1 });

    const status = subjectRunStatus(deps, run.id);
    expect(status).toMatchObject({ run: { run_id: run.id, job: 'guess-memory-subjects', memories: 4, undoable_memories: 3 } });
    expect('run' in status && 'notes' in status.run).toBe(false);
    expect(viewOnDemandRun(db, run)).toMatchObject({ job: 'guess-memory-subjects', memories: 4 });

    const preview = await undoSubjectRun(deps, run.id, true);
    expect(preview).toMatchObject({ dry_run: true, restored: 3, conflict_count: 0, no_longer_undoable: 0 });
    expect(subjectsOf(byId)).toEqual({ 1: ['Dana Whitfield'], 2: ['Acme'], 3: [], 4: ['Dana', 'Acme'] });

    // The owner removed the subjects of one memory since: nothing is left to take from it.
    byId.get(2)!.subjects = [];
    const undone = await undoSubjectRun(deps, run.id, false);
    expect(undone).toMatchObject({ dry_run: false, restored: 2, no_longer_undoable: 1 });
    expect(subjectsOf(byId)).toEqual({ 1: [], 2: [], 3: [], 4: [] });
    await expect(undoSubjectRun(deps, run.id, false)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('leaves out the source note\'s names a memory does not mention, and says so (2026-11-20)', async () => {
    const memories = [
      memory(1, 'Dana takes the renewal from here.', CALL),
      memory(2, 'The pricing page needs a refresh.', CALL),
    ];
    const llm = namingModel({ copySourceNames: true }).llm;
    const preview = await previewSubjectRun(setup(memories, { llm }).deps, { sample: 2 });
    expect(preview.sample).toEqual([
      { id: 1, content: 'Dana takes the renewal from here.', source_title: 'Renewal call', outcome: 'given',
        subjects: [{ name: 'Dana Whitfield', status: 'linked', title: 'Dana Whitfield' }], dropped: ['Acme'] },
      { id: 2, content: 'The pricing page needs a refresh.', source_title: 'Renewal call', outcome: 'none',
        subjects: [], dropped: ['Dana Whitfield', 'Acme'] },
    ]);
    expect(preview.sample_counts).toMatchObject({ given: 1, none: 1, dropped: 3 });

    const { deps, db, byId } = setup(memories.map(each => ({ ...each, subjects: [] })), { llm });
    const { run } = await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ given: 1, none: 1, dropped: 3, subjects: 1 });
    expect(subjectsOf(byId)).toEqual({ 1: ['Dana Whitfield'], 2: [] });
    // A memory left with no name was answered "no one": it is not asked again.
    expect(db.prepare('SELECT memory_id FROM subject_run_verdicts').all()).toEqual([{ memory_id: 2 }]);
  });

  it('asks a memory again when what it would be shown changes, or the model left it out or answered it malformed', async () => {
    const memories = fourMemories();
    const { deps, db, byId } = setup(memories, { llm: namingModel({ skip: [2], malformed: [4] }).llm });
    const { run } = await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ asked: 4, given: 1, none: 1, unanswered: 2 });
    expect(db.prepare('SELECT memory_id FROM subject_run_verdicts').all()).toEqual([{ memory_id: 3 }]);
    expect(await previewSubjectRun(deps, { sample: 0 })).toMatchObject({ memories: 2, already_asked: 1 });

    // The owner's memory now comes from a note that links Acme: a new question.
    byId.get(3)!.source_title = 'Planning';
    byId.get(3)!.source_names = ['Acme'];
    const again = await previewSubjectRun(deps, { sample: 0 });
    expect(again).toMatchObject({ memories: 3, already_asked: 0 });
  });

  it('adds the names the free match missed, and leaves its subjects alone, undo included (owner, 2026-11-20)', async () => {
    const tagged = memory(7, 'Acme hired Jordan Lee as account lead.', CALL);
    tagged.subjects = [{ name: 'Acme', by: 'match', at: 'x' }];
    const nothingMissed = memory(8, 'Acme moved offices.', CALL);
    nothingMissed.subjects = [{ name: 'Acme', by: 'match', at: 'x' }];
    const ownersOwn = memory(9, 'Acme hired Jordan Lee.', CALL);
    ownersOwn.subjects = [{ name: 'Acme', by: 'owner', at: 'x' }];
    const { deps, db, byId, requests } = setup([tagged, nothingMissed, ownersOwn]);

    const preview = await previewSubjectRun(deps, { sample: 5 });
    expect(preview.memories).toBe(2);
    expect(preview.sample).toEqual([
      expect.objectContaining({ id: 7, outcome: 'given', subjects: [{ name: 'Jordan Lee', status: 'unresolved', title: null }] }),
      expect.objectContaining({ id: 8, outcome: 'none', subjects: [] }),
    ]);
    expect(requests[0]!.user).toContain('[7] Acme hired Jordan Lee as account lead.\n  has: Acme\n');

    const { run } = await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run.counts).toMatchObject({ asked: 2, given: 1, none: 1, subjects: 1 });
    expect(byId.get(7)!.subjects.map(subject => [subject.name, subject.by])).toEqual([['Acme', 'match'], ['Jordan Lee', 'model']]);
    // Nothing missed: answered, and not asked again until what it is shown changes.
    expect(db.prepare('SELECT memory_id FROM subject_run_verdicts').all()).toEqual([{ memory_id: 8 }]);

    await undoSubjectRun(deps, run.id, false);
    expect(byId.get(7)!.subjects.map(subject => [subject.name, subject.by])).toEqual([['Acme', 'match']]);
    expect(byId.get(9)!.subjects.map(subject => subject.name)).toEqual(['Acme']);
  });

  it('undoes its own writes only: a later run\'s subjects on the same memory stay (Codex, #695)', async () => {
    const { deps, byId } = setup(fourMemories());
    const first = (await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' })).run;
    // The owner removes the first memory's subjects, and a later run gives it new ones.
    byId.get(1)!.subjects = [];
    const second = (await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' })).run;
    expect(second.counts).toMatchObject({ asked: 1, given: 1 });

    const undone = await undoSubjectRun(deps, first.id, false);
    expect(undone).toMatchObject({ restored: 2, no_longer_undoable: 1 });
    expect(subjectsOf(byId)).toEqual({ 1: ['Dana Whitfield'], 2: [], 3: [], 4: [] });
    expect(await undoSubjectRun(deps, second.id, false)).toMatchObject({ restored: 1 });
    expect(subjectsOf(byId)[1]).toEqual([]);
  });

  it('works through the set a call at a turn, and stops after calls fail in a row', async () => {
    const many = Array.from({ length: 45 }, (_, index) => memory(index + 1, `Memory ${index + 1} about Acme.`));
    const { deps, requests, byId } = setup(many);
    const { run } = await startSubjectRun(deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(run).toMatchObject({ status: 'completed', notes: 45, counts: { asked: 45, given: 45 } });
    expect(requests).toHaveLength(3);
    expect([...byId.values()].every(each => each.subjects.length === 1)).toBe(true);

    const failing: LlmClient = { structuredCall: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); } };
    const lots = Array.from({ length: 200 }, (_, index) => memory(index + 1, `Memory ${index + 1}.`));
    const failed = await startSubjectRun(setup(lots, { llm: failing }).deps, { limitUsd: 1, trigger: 'on-demand' });
    expect(failed.run).toMatchObject({ status: 'stopped', counts: { asked: 0, errors: 100 } });
    expect(failed.run.detail).toMatch(/^Stopped: the model call failed for 5 calls in a row, so nothing more was asked\. .*memorySweepModel/);
  });

  it('stops at its limit and says how to go on', async () => {
    const many = Array.from({ length: 100 }, (_, index) => memory(index + 1, `Memory ${index + 1} about Acme.`));
    const { deps } = setup(many);
    const { run } = await startSubjectRun(deps, { limitUsd: 0.005, trigger: 'on-demand' });
    expect(run.status).toBe('stopped');
    expect(run.detail).toMatch(/^Stopped before every memory was reached: .* Start it again with a new limit to continue: memories already given subjects are not asked again\.$/);
  });
});

describe('the guess-memory-subjects tool', () => {
  const call = async (deps: OnDemandDeps, args: Record<string, unknown>) => {
    const handler = makeGuessMemorySubjectsHandler(deps as unknown as CoreDeps);
    const result = await handler({ action: 'preview', ...args } as never, { authInfo: { scopes: ['curate:trigger'] } } as never);
    return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
  };

  it('previews with a suggested start, starts, and names parameters that belong to another action', async () => {
    const { deps } = setup(fourMemories());
    const preview = await call(deps, { sample: 2 });
    expect(preview).toMatchObject({ ok: true, memories: 4, next: { tool: 'guess-memory-subjects', arguments: { action: 'start' } } });
    expect(preview.daily_cap_note).toBeDefined();

    const started = await call(deps, { action: 'start', limit_usd: 1 });
    expect(started).toMatchObject({ ok: true, started: true, job: 'guess-memory-subjects', memories: 4, status: 'completed' });

    expect(await call(deps, { action: 'start', sample: 3, limit_usd: 1 })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', message: 'start takes limit_usd; not sample.' },
    });
    expect(await call(deps, { action: 'start' })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });
});
