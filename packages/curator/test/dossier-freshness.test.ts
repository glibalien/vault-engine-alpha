import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { getDossier, listDossiers, recordDossierBuild } from '../src/db/dossiers.js';
import { DOSSIER_NIGHTLY_LIMIT, checkDossiers, dossierFreshness, rebuildOf, runDossierRebuilds } from '../src/dossier/freshness.js';
import { DossierError } from '../src/dossier/evidence.js';
import type { CoreDeps } from '../src/core.js';
import type { Memory } from '../src/types.js';

// Fictional people and companies only (repository rule).

const memory = (id: number, extra: Partial<Memory> = {}): Memory => ({ id, source: 'curator', scope: 'vault', node_id: null, content: `m${id}`,
  category: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...extra });

type Input = { kind: 'memory' | 'node'; id: string; comparison?: string };
const input = ({ kind, id, comparison = 'unchanged' }: Input) => ({ id: `i-${kind}-${id}`, source_id: null, role: 'source_material',
  source: { namespace: 'vault', kind, native_id: id }, comparison });

/** An Engine whose outputs hold `inputs` (by output id, paged by `pageSize`) and whose subject memories are `memories`. */
function fakeEngine(opts: { inputs: Record<string, Input[]>; memories?: Memory[]; past?: Memory[]; replacements?: Memory[]; total?: number; pageSize?: number; fields?: Record<string, unknown> }) {
  const statuses: Array<[string, string]> = [];
  const engine = {
    inspectProvenance: vi.fn(async (request: { output_revision_id: string; cursor?: string }) => {
      const all = (opts.inputs[request.output_revision_id] ?? []).map(input);
      const size = opts.pageSize ?? 100;
      const from = request.cursor ? Number(request.cursor) : 0;
      return { select: 'output', inputs: all.slice(from, from + size), next_cursor: from + size < all.length ? String(from + size) : null };
    }),
    listMemoriesWithTotal: vi.fn(async (filters: { source?: string; category?: string; expire_reasons?: string[]; ids?: number[] }) => {
      if (filters.source === 'owner') return { memories: [], total: 0 };
      if (filters.ids) { const found = (opts.replacements ?? []).filter(m => filters.ids!.includes(m.id)); return { memories: found, total: found.length }; }
      if (filters.expire_reasons) return { memories: opts.past ?? [], total: (opts.past ?? []).length };
      if (filters.category) return { memories: [], total: 0 };
      const list = opts.memories ?? [memory(1), memory(2)];
      return { memories: list, total: opts.total ?? list.length };
    }),
    wikiStatus: vi.fn(async (root: string, status: string) => { statuses.push([root, status]); return {}; }),
    readNodeField: vi.fn(async (nodeId: string) => opts.fields?.[nodeId]),
  };
  return { engine, statuses };
}

function db(): Database.Database { const d = new Database(':memory:'); runMigrations(d); return d; }
const build = (nodeId: string, output = `out-${nodeId}`, memoryTotal: number | null = 2) =>
  ({ nodeId, pageTitle: `${nodeId} Dossier`, homeId: `home-${nodeId}`, outputRevisionId: output, builtAt: '2026-11-20T10:00:00.000Z', memoryTotal });
const read = [{ kind: 'node', id: 'dana' }, { kind: 'memory', id: '1' }, { kind: 'memory', id: '2' }] as Input[];

describe('dossier rebuild mode (#714)', () => {
  it('is on-change only when the note says so, in any case; anything else is manual', () => {
    expect(rebuildOf('on-change')).toBe('on-change');
    expect(rebuildOf({ value: ' On-Change ' })).toBe('on-change');
    expect(rebuildOf('manual')).toBe('manual');
    expect(rebuildOf(true)).toBe('manual');
    expect(rebuildOf(undefined)).toBe('manual');
  });
});

describe('whether a dossier is behind (#714)', () => {
  it('is current when what it read is unchanged and a build would show the same memories', async () => {
    const { engine } = fakeEngine({ inputs: { out: read } });
    expect(await dossierFreshness(engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 })).toEqual({ behind: false, reasons: [] });
    expect(engine.inspectProvenance).toHaveBeenCalledWith(expect.objectContaining({ include_comparisons: true }));
  });

  it('is behind when a note or memory it read changed or is gone', async () => {
    const { engine } = fakeEngine({ inputs: { out: [{ kind: 'node', id: 'dana', comparison: 'changed' }, ...read.slice(1)] } });
    const result = await dossierFreshness(engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 });
    expect(result.behind).toBe(true);
    expect(result.reasons[0]).toMatch(/1 of the notes and memories it read changed/);
  });

  it('is behind when the subject gained a memory a build would show, or its total moved', async () => {
    const added = fakeEngine({ inputs: { out: read }, memories: [memory(1), memory(2), memory(3)] });
    expect((await dossierFreshness(added.engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 })).reasons)
      .toEqual(['1 memory it would show now is new to it', 'the memories about the subject went from 2 to 3']);
    const beyond = fakeEngine({ inputs: { out: read }, total: 140 }); // one beyond the shown window
    expect((await dossierFreshness(beyond.engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 139 })).behind).toBe(true);
  });

  it('is behind when a newer memory replaced one about the subject: the past fact is new to it (#717)', async () => {
    const past = memory(5, { expired_at: '2026-11-02T00:00:00.000Z', expire_reason: 'contradicted', superseded_by: 6 });
    // Its replacement is shown with it, so it counts too (here not among the subject's live memories).
    const replacements = [memory(6)];
    const replaced = fakeEngine({ inputs: { out: read }, past: [past], replacements });
    expect((await dossierFreshness(replaced.engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 })).reasons)
      .toEqual(['2 memories it would show now are new to it']);
    // Once shown, both are the page's inputs, unchanged.
    const shown = fakeEngine({ inputs: { out: [...read, { kind: 'memory', id: '5' }, { kind: 'memory', id: '6' }] }, past: [past], replacements });
    expect(await dossierFreshness(shown.engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 })).toEqual({ behind: false, reasons: [] });
  });

  it('reads every page of the inputs', async () => {
    const many = [...read, ...Array.from({ length: 150 }, (_, i) => ({ kind: 'node', id: `n${i}` }) as Input)];
    many[140] = { kind: 'node', id: 'n-late', comparison: 'missing' };
    const { engine } = fakeEngine({ inputs: { out: many } });
    expect((await dossierFreshness(engine as never, { nodeId: 'dana', outputRevisionId: 'out', memoryTotal: 2 })).behind).toBe(true);
    expect(engine.inspectProvenance).toHaveBeenCalledTimes(2);
  });
});

describe('the dossier check writes each page\'s status (#714)', () => {
  it('marks a behind dossier once, and current again after it catches up', async () => {
    const d = db();
    recordDossierBuild(d, build('dana', 'out'));
    const behind = fakeEngine({ inputs: { out: [{ kind: 'node', id: 'dana', comparison: 'changed' }] } });
    expect(await checkDossiers({ engine: behind.engine as never, db: d }, () => {})).toEqual({ checked: 1, behind: 1 });
    await checkDossiers({ engine: behind.engine as never, db: d }, () => {});
    expect(behind.statuses).toEqual([['dana', 'behind']]); // written once: the second check found it already behind
    expect(getDossier(d, 'dana')?.status).toBe('behind');
    const fixed = fakeEngine({ inputs: { out: read } });
    await checkDossiers({ engine: fixed.engine as never, db: d }, () => {});
    expect(fixed.statuses).toEqual([['dana', 'current']]);
  });

  it('tries a status write again at the next check when the Engine refused it (Codex, #731)', async () => {
    const d = db();
    recordDossierBuild(d, build('dana', 'out'));
    const { engine, statuses } = fakeEngine({ inputs: { out: [{ kind: 'node', id: 'dana', comparison: 'changed' }] } });
    engine.wikiStatus.mockImplementationOnce(async () => { throw new Error('engine CONTENT_HASH_MISMATCH: an unread edit'); });
    const lines: string[] = [];
    await checkDossiers({ engine: engine as never, db: d }, line => lines.push(line));
    expect(getDossier(d, 'dana')?.status).toBe('current'); // not recorded: the page still says current
    expect(lines.join('\n')).toMatch(/tried again at the next check/);
    await checkDossiers({ engine: engine as never, db: d }, () => {});
    expect(statuses).toEqual([['dana', 'behind']]);
    expect(getDossier(d, 'dana')?.status).toBe('behind');
  });

  it('leaves a record a build rewrote during the check alone', async () => {
    const d = db();
    recordDossierBuild(d, build('dana', 'out-old'));
    const { engine, statuses } = fakeEngine({ inputs: { 'out-old': [{ kind: 'node', id: 'dana', comparison: 'changed' }] } });
    engine.inspectProvenance.mockImplementationOnce(async () => {
      recordDossierBuild(d, build('dana', 'out-new')); // a build landed while the check read
      return { select: 'output', inputs: [input({ kind: 'node', id: 'dana', comparison: 'changed' })], next_cursor: null };
    });
    await checkDossiers({ engine: engine as never, db: d }, () => {});
    expect(statuses).toEqual([]);
    expect(getDossier(d, 'dana')).toMatchObject({ outputRevisionId: 'out-new', status: 'current' });
  });
});

describe('the nightly dossier rebuilds (#714)', () => {
  const deps = (d: Database.Database, engine: unknown) => ({ engine, db: d, builds: { started: true } } as unknown as CoreDeps);
  const behindInputs = (ids: string[]) => Object.fromEntries(ids.map(id => [`out-${id}`, [{ kind: 'node', id, comparison: 'changed' } as Input]]));

  it('rebuilds only the behind dossiers whose note says on-change, asking again when each turn comes', async () => {
    const d = db();
    for (const id of ['dana', 'lee', 'sam']) recordDossierBuild(d, build(id));
    const { engine } = fakeEngine({ inputs: { ...behindInputs(['dana', 'lee']), 'out-sam': read },
      fields: { dana: 'on-change', lee: 'manual', sam: 'on-change' } });
    const started: string[] = [];
    const result = await runDossierRebuilds(deps(d, engine), { dryRun: false }, async (built, nodeId, stillWanted) => {
      expect(built.builds).toBeDefined(); // tracked like a live build, so an in-flight one isn't started twice (Codex, #731)
      expect(await stillWanted()).toBe(true);
      started.push(nodeId);
      return { status: 'written' };
    });
    expect(started).toEqual(['dana']);
    expect(result).toEqual({ considered: 1, rebuilt: 1, skipped: 0, failed: 0, leftForLater: 0, stoppedBy: null });
  });

  it('rebuilds at most five a night, and stops at the daily cap', async () => {
    const d = db();
    const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);
    for (const id of ids) recordDossierBuild(d, build(id));
    const { engine } = fakeEngine({ inputs: behindInputs(ids), fields: Object.fromEntries(ids.map(id => [id, 'on-change'])) });
    const limited = await runDossierRebuilds(deps(d, engine), { dryRun: false }, async () => ({ status: 'written' }));
    expect(limited).toMatchObject({ considered: 7, rebuilt: DOSSIER_NIGHTLY_LIMIT, leftForLater: 2 });
    let n = 0;
    const capped = await runDossierRebuilds(deps(d, engine), { dryRun: false }, async () => {
      if (++n === 3) throw new DossierError('DAILY_BUDGET', 'daily budget: spent');
      return { status: 'written' };
    });
    expect(capped).toMatchObject({ rebuilt: 2, leftForLater: 5, stoppedBy: 'budget' });
  });

  it('does not rebuild one set back to manual before its turn came (Codex, #731)', async () => {
    const d = db();
    recordDossierBuild(d, build('dana'));
    const fields: Record<string, unknown> = { dana: 'on-change' };
    const { engine } = fakeEngine({ inputs: behindInputs(['dana']), fields });
    const wanted: boolean[] = [];
    await runDossierRebuilds(deps(d, engine), { dryRun: false }, async (_built, _nodeId, stillWanted) => {
      fields.dana = 'manual'; // edited while it waited in the queue
      wanted.push(await stillWanted());
      return { status: 'current' };
    });
    expect(wanted).toEqual([false]);
  });

  it('counts as skipped a dossier already being built, or current by its turn', async () => {
    const d = db();
    for (const id of ['dana', 'lee']) recordDossierBuild(d, build(id));
    const { engine } = fakeEngine({ inputs: behindInputs(['dana', 'lee']), fields: { dana: 'on-change', lee: 'on-change' } });
    const answers = ['in_progress', 'current'];
    const result = await runDossierRebuilds(deps(d, engine), { dryRun: false }, async () => ({ status: answers.shift()! }));
    expect(result).toMatchObject({ considered: 2, rebuilt: 0, skipped: 2, failed: 0 });
  });

  it('rebuilds nothing in a dry run', async () => {
    const d = db();
    recordDossierBuild(d, build('dana'));
    const { engine } = fakeEngine({ inputs: behindInputs(['dana']), fields: { dana: 'on-change' } });
    const start = vi.fn();
    expect(await runDossierRebuilds(deps(d, engine), { dryRun: true }, start)).toMatchObject({ considered: 0, rebuilt: 0 });
    expect(start).not.toHaveBeenCalled();
    expect(listDossiers(d)).toHaveLength(1);
  });
});
