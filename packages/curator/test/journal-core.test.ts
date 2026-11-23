import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CurateResult } from '../src/types.js';

const { curateProjectMock } = vi.hoisted(() => ({
  curateProjectMock: vi.fn(async (_e: unknown, _l: unknown, _c: unknown, p: { title: string }): Promise<CurateResult> => ({
    project: p.title, outcome: 'skipped' as const, detail: 'evidence unchanged', dryRun: false,
  })),
}));

vi.mock('../src/curate.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  curateProject: curateProjectMock,
}));
vi.mock('../src/journal/writer.js', () => ({ writeJournalEntry: vi.fn(async () => {}) }));

import { writeJournalEntry } from '../src/journal/writer.js';
import { runSweep, curateOne, type CoreDeps } from '../src/core.js';
import { CurationQueue } from '../src/queue.js';
import { runMigrations } from '../src/db/migrate.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { unjournaledEvents } from '../src/db/journal.js';
import type { Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';
import { enrolProjects } from './project-wiki-fixtures.js';

function makeDeps(): CoreDeps & { db: Database.Database } {
  const db = new Database(':memory:');
  runMigrations(db); enrolProjects(db, 'Proj');
  const engine = {
    listActiveProjects: async () => [{ id: 'p1', title: 'Proj', file_path: '', status: 'open' }],
    setRecorder: () => {},
  } as unknown as Engine;
  const llm = { structuredCall: async () => { throw new Error('unused'); } } as LlmClient;
  const config = {
    activeStatuses: ['open'], journalEnabled: true, journalModel: null,
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
    memorySweepEnabled: false, orgSweepEnabled: false,
    staleProjectDays: 9999, staleSkipStatuses: [], projectStatusField: 'status',
    staleProjectStatus: 'backlog', curatorTz: 'UTC',
  } as unknown as Config;
  return { engine, llm, config, queue: new CurationQueue(), db, recorder: new ActionRecorder(db) };
}

describe('journal wiring in core', () => {
  it('persists conversation-capture summaries under their typed journal function', () => {
    const deps = makeDeps();
    const recorder = deps.recorder!;
    recorder.setContext({ runRef: 'capture-run', trigger: 'scheduled', fn: 'conversation-capture' });
    recorder.summary('conversation-capture', 'Conversation capture — scanned 1', { scanned: 1, errors: 0 }, false);
    recorder.setContext(null);

    expect(unjournaledEvents(deps.db)).toEqual([
      expect.objectContaining({ function: 'conversation-capture', run_ref: 'capture-run', kind: 'summary' }),
    ]);
  });

  it('curateTimed emits a per-project summary carrying the run ref, and the result exposes runRef', async () => {
    const deps = makeDeps();
    const results = await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(results[0]!.runRef).toBeTruthy();
    const summaries = unjournaledEvents(deps.db).filter(e => e.kind === 'summary' && e.function === 'wiki-curation');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.run_ref).toBe(results[0]!.runRef);
    expect(JSON.parse(summaries[0]!.detail).line).toContain('Proj — skipped');
  });

  it('runSweep writes exactly one all-unjournaled entry (and none under dry-run)', async () => {
    const deps = makeDeps();
    vi.mocked(writeJournalEntry).mockClear();
    await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });
    expect(writeJournalEntry).toHaveBeenCalledTimes(1);
    expect(writeJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ db: deps.db }), { kind: 'all-unjournaled' }, 'nightly sweep',
    );
    vi.mocked(writeJournalEntry).mockClear();
    await runSweep(deps, { dryRun: true, force: false, trigger: 'scheduled' });
    expect(writeJournalEntry).not.toHaveBeenCalled();
  });

  it('records a distinguishable journal summary when scheduled wiki work is disabled', async () => {
    const deps = makeDeps();
    deps.config = { ...deps.config, fieldGuessCap: 0, wikiReconciliationMode: 'off' } as Config;

    const results = await runSweep(deps, { dryRun: false, force: false, trigger: 'scheduled' });

    expect(results).toHaveLength(1);
    const summaries = unjournaledEvents(deps.db).filter(event => event.kind === 'summary');
    expect(summaries.map(event => event.function)).toEqual([
      'field-guess-sweep',
      'wiki-curation',
    ]);
    const fieldGuessSummary = summaries.find(event => event.function === 'field-guess-sweep');
    expect(JSON.parse(fieldGuessSummary!.detail)).toMatchObject({
      stats: { ran: false, skipReason: 'disabled', fieldsSet: 0, errors: 0 },
    });
    const wikiSummary = summaries.find(event => event.function === 'wiki-curation');
    expect(JSON.parse(wikiSummary!.detail)).toMatchObject({
      line: 'Scheduled wiki reconciliation — skipped (mode disabled (off))',
      stats: { outcome: 'skipped_mode_disabled' },
    });
  });

  it("curateOne writes a run-refs entry labeled by trigger + project", async () => {
    const deps = makeDeps();
    vi.mocked(writeJournalEntry).mockClear();
    const result = await curateOne(deps, 'Proj', { dryRun: false, force: false, trigger: 'cli' });
    expect(writeJournalEntry).toHaveBeenCalledWith(
      expect.anything(), { kind: 'run-refs', runRefs: [result.runRef] }, 'CLI: Proj',
    );
  });

  it('records normalized topology actions with stable ids, merge sources, and dry-run marking', async () => {
    // Given
    curateProjectMock.mockResolvedValueOnce({
      project: 'Proj', outcome: 'written', detail: 'ok', dryRun: true,
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], reconcileKey: 'key-1', warnings: [],
      },
      topology: [
        { action: 'created', node_id: 'target', title: 'Target', scope: { v: 1, subject: 'Proj', facet: 'A' } },
        { action: 'merged-target', node_id: 'target', title: 'Target', scope: { v: 1, subject: 'Proj', facet: 'A' }, source_node_ids: ['source'] },
        { action: 'merged-source', node_id: 'source', title: 'Source', scope: { v: 1, subject: 'Proj', facet: 'A' }, target_node_id: 'target', target_title: 'Target' },
      ],
    });
    const deps = makeDeps();

    // When
    const result = await curateOne(deps, 'Proj', { dryRun: true, force: true, trigger: 'on-demand' });

    // Then
    expect(result.topology).toHaveLength(3);
    const actions = deps.db.prepare("SELECT * FROM journal_events WHERE kind = 'action' ORDER BY id").all() as ReturnType<typeof unjournaledEvents>;
    expect(actions.map(event => event.action)).toEqual(['page-created', 'pages-merged']);
    expect(actions[1]?.detail).toContain('"Target" (target)');
    expect(actions[1]?.detail).toContain('"Source" (source)');
    expect(actions[1]?.detail).toContain('key=key-1');
    expect(actions.every(event => event.dry_run === 1 && event.detail.includes('[dry-run]'))).toBe(true);
    expect(actions.map(event => event.detail).join(' ')).not.toMatch(/delet/i);
  });
});
