import { describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError } from '../src/budget.js';
import Database from 'better-sqlite3';
import { runReconcile, parseReconcileVerdict, buildReconcileUser, RECONCILE_SYSTEM_PROMPT, RECONCILE_TOOL } from '../src/reconcile.js';
import { runMigrations } from '../src/db/migrate.js';
import { ledgerVerdict, upsertVerdict } from '../src/db/reconcile.js';
import { CurationQueue } from '../src/queue.js';
import { EngineError, type Engine, type NearPair } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';

const USAGE = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };

function mem(id: number, content: string, updated = 'T1'): NearPair['a'] {
  return { id, content, source: id % 2 ? 'chat' : 'curator', scope: 'vault', updated_at: updated } as NearPair['a'];
}
function pair(a: NearPair['a'], b: NearPair['a'], distance = 0.1): NearPair {
  return { a, b, distance };
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
    reconcileEnabled: true, reconcilePairCap: 10, reconcileModel: null, ...over,
  } as Config;
}

function fakes(pairs: NearPair[], verdicts: Array<Record<string, unknown>>, opts: { expireError?: Error } = {}) {
  const calls: string[] = [];
  let v = 0;
  const engine = {
    listMemoryNearPairs: async () => ({ pairs, total_in_band: pairs.length }),
    expireMemory: async (a: { id: number; reason: string; superseded_by?: number; unless_subjects_apart?: boolean }) => {
      calls.push(`expire:${a.id}:${a.reason}:${a.superseded_by}`);
      if (a.unless_subjects_apart !== true) throw new Error('the reconcile must ask the Engine to check subjects');
      if (opts.expireError) throw opts.expireError;
    },
  } as unknown as Engine;
  const llm: LlmClient = {
    structuredCall: async () => ({ output: verdicts[Math.min(v++, verdicts.length - 1)], usage: USAGE }),
  };
  return { engine, llm, calls };
}

function db(): Database.Database { const d = new Database(':memory:'); runMigrations(d); return d; }
function deps(f: ReturnType<typeof fakes>, config: Config, d?: Database.Database) {
  return { engine: f.engine, llm: f.llm, config, queue: new CurationQueue(), db: d };
}

describe('parseReconcileVerdict', () => {
  it('accepts the three verdicts; survivor required for duplicate/contradiction and must be a pair member', () => {
    expect(parseReconcileVerdict({ verdict: 'distinct' }, 1, 2)).toEqual({ verdict: 'distinct' });
    expect(parseReconcileVerdict({ verdict: 'duplicate', survivor_id: 2 }, 1, 2)).toEqual({ verdict: 'duplicate', survivorId: 2 });
    expect(parseReconcileVerdict({ verdict: 'duplicate' }, 1, 2)).toBeNull();
    expect(parseReconcileVerdict({ verdict: 'contradiction', survivor_id: 9 }, 1, 2)).toBeNull();
    expect(parseReconcileVerdict({ verdict: 'maybe' }, 1, 2)).toBeNull();
    expect(parseReconcileVerdict(null, 1, 2)).toBeNull();
  });
});

describe('runReconcile', () => {
  it('stops after 3 identical provider rejections; unattempted pairs stay unledgered (#254)', async () => {
    const pairs = [1, 3, 5, 7, 9].map(i => pair(mem(i, `m${i}`), mem(i + 1, `m${i + 1}`)));
    const f = fakes(pairs, []);
    let calls = 0;
    f.llm.structuredCall = async () => {
      calls += 1;
      throw Object.assign(new Error('400 Provider returned error'), { status: 400, error: { message: 'Provider returned error' } });
    };
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(calls).toBe(3);
    expect(r.adjudicated).toBe(3);
    expect(r.errors).toBe(3);
    expect(r.stopped).toContain('memory reconcile stopped after 3 identical rejections from model test-model');
    for (const p of pairs) expect(ledgerVerdict(d, p.a.id, p.b.id)).toBeUndefined();
  });

  it('tells the model today in the configured zone (#459)', async () => {
    const f = fakes([pair(mem(1, 'm1'), mem(2, 'm2'))], [{ verdict: 'distinct' }]);
    const systems: string[] = [];
    const call = f.llm.structuredCall.bind(f.llm);
    f.llm.structuredCall = async req => { systems.push(req.system); return call(req); };
    await runReconcile(deps(f, cfg({ curatorTz: 'Asia/Tokyo' }), db()), { dryRun: false, trigger: 'scheduled' });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(Asia\/Tokyo\)\.$/);
  });

  it('stops at the first budget refusal; the refused pair and the rest stay unledgered (#342)', async () => {
    const pairs = [1, 3, 5].map(i => pair(mem(i, `m${i}`), mem(i + 1, `m${i + 1}`)));
    const f = fakes(pairs, []);
    let calls = 0;
    f.llm.structuredCall = async () => {
      calls += 1;
      throw new BudgetExhaustedError('daily budget: $12.0000 spent of $12.00; this call could cost up to $0.0100');
    };
    const d = db();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
      expect(calls).toBe(1);
      expect(r.adjudicated).toBe(0);
      expect(r.errors).toBe(0);
      expect(r.stopped).toBe('memory reconcile stopped: daily budget: $12.0000 spent of $12.00; this call could cost up to $0.0100; '
        + 'the rest is retried next run');
      for (const p of pairs) expect(ledgerVerdict(d, p.a.id, p.b.id)).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it('is inert when disabled or db-less', async () => {
    const f = fakes([], []);
    expect((await runReconcile(deps(f, cfg({ reconcileEnabled: false }), db()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
    expect((await runReconcile(deps(f, cfg()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
  });

  it('duplicate: expires the loser with duplicate-of reason + supersede link, then ledgers', async () => {
    const f = fakes([pair(mem(1, 'fact v1'), mem(2, 'fact v1 duplicate'))], [{ verdict: 'duplicate', survivor_id: 2 }]);
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ ran: true, adjudicated: 1, duplicates: 1, expired: 1, errors: 0 });
    expect(f.calls).toEqual(['expire:1:duplicate-of:2:2']);
    expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('duplicate');
  });

  it('contradiction: reason is contradicted; distinct: ledger only, no expiry', async () => {
    const f = fakes(
      [pair(mem(1, 'x is true'), mem(2, 'x is false')), pair(mem(3, 'about a'), mem(4, 'about b'))],
      [{ verdict: 'contradiction', survivor_id: 1 }, { verdict: 'distinct' }],
    );
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ contradictions: 1, distinct: 1, expired: 1 });
    expect(f.calls).toEqual(['expire:2:contradicted:1']);
    expect(ledgerVerdict(d, 3, 4)?.verdict).toBe('distinct');
  });

  it('skips ledgered unchanged pairs; a changed updated_at re-opens the pair', async () => {
    const d = db();
    upsertVerdict(d, { idA: 1, idB: 2, updatedAtA: 'T1', updatedAtB: 'T1', verdict: 'distinct', adjudicatedAt: 'x' });
    const unchanged = pair(mem(1, 'a', 'T1'), mem(2, 'b', 'T1'));
    const reopened = pair(mem(1, 'a', 'T2'), mem(2, 'b', 'T1')); // member 1 edited since
    const f1 = fakes([unchanged], [{ verdict: 'distinct' }]);
    const r1 = await runReconcile(deps(f1, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r1).toMatchObject({ ledgerSkipped: 1, adjudicated: 0 });
    const f2 = fakes([reopened], [{ verdict: 'distinct' }]);
    const r2 = await runReconcile(deps(f2, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r2).toMatchObject({ ledgerSkipped: 0, adjudicated: 1 });
  });

  it('never asks about or merges a pair the Engine keeps apart by subjects, and ledgers it as kept apart (#718)', async () => {
    const apart: NearPair = { ...pair(mem(1, 'the Northwind deal is valued at 500K'), mem(2, 'the Contoso deal is valued at 500K')), subjects_apart: true };
    const older = pair(mem(3, 'fact'), mem(4, 'fact again')); // an older Engine sends no flag
    const structuredCall = vi.fn(async () => ({ output: { verdict: 'duplicate', survivor_id: 4 }, usage: USAGE }));
    const f = fakes([apart, older], []);
    f.llm.structuredCall = structuredCall;
    const d = db();
    const r = await runReconcile(deps(f, cfg({ reconcilePairCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ keptApart: 1, adjudicated: 1, duplicates: 1, expired: 1 });
    expect(structuredCall).toHaveBeenCalledTimes(1); // only the unflagged pair, and the cap did not count the kept one
    expect(f.calls).toEqual(['expire:3:duplicate-of:4:4']);
    expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('kept_apart');
    // A dry run counts it and ledgers nothing.
    const d2 = db();
    const dry = await runReconcile(deps(fakes([apart], []), cfg(), d2), { dryRun: true, trigger: 'scheduled' });
    expect(dry).toMatchObject({ keptApart: 1, adjudicated: 0 });
    expect(ledgerVerdict(d2, 1, 2)).toBeUndefined();
  });

  it('reopens a pair kept apart once the Engine no longer keeps it apart, with no timestamp change (Codex, #726)', async () => {
    const d = db();
    upsertVerdict(d, { idA: 1, idB: 2, updatedAtA: 'T1', updatedAtB: 'T1', verdict: 'kept_apart', adjudicatedAt: 'x' });
    const still: NearPair = { ...pair(mem(1, 'a', 'T1'), mem(2, 'b', 'T1')), subjects_apart: true };
    const r1 = await runReconcile(deps(fakes([still], [{ verdict: 'distinct' }]), cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r1).toMatchObject({ ledgerSkipped: 1, adjudicated: 0, keptApart: 0 });
    const cleared: NearPair = { ...pair(mem(1, 'a', 'T1'), mem(2, 'b', 'T1')), subjects_apart: false };
    const r2 = await runReconcile(deps(fakes([cleared], [{ verdict: 'distinct' }]), cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r2).toMatchObject({ ledgerSkipped: 0, adjudicated: 1, distinct: 1 });
    expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('distinct');
  });

  it('leaves a pair for the next run when this run already merged one of its memories (Codex, #726)', async () => {
    // A merged into B; B/C was flagged before B took A's subjects, so it waits for a fresh listing.
    const pairs = [pair(mem(1, 'A'), mem(2, 'B')), pair(mem(2, 'B'), mem(3, 'C')), pair(mem(4, 'D'), mem(5, 'E'))];
    const f = fakes(pairs, [{ verdict: 'duplicate', survivor_id: 2 }, { verdict: 'distinct' }]);
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ adjudicated: 2, deferred: 1, expired: 1, distinct: 1 });
    expect(ledgerVerdict(d, 2, 3)).toBeUndefined();
    expect(ledgerVerdict(d, 4, 5)?.verdict).toBe('distinct');
  });

  it('a dry run defers the same pairs a live run would (Codex, #726)', async () => {
    const pairs = [pair(mem(1, 'A'), mem(2, 'B')), pair(mem(2, 'B'), mem(3, 'C')), pair(mem(4, 'D'), mem(5, 'E'))];
    const f = fakes(pairs, [{ verdict: 'duplicate', survivor_id: 2 }, { verdict: 'distinct' }]);
    const r = await runReconcile(deps(f, cfg(), db()), { dryRun: true, trigger: 'on-demand' });
    expect(r).toMatchObject({ adjudicated: 2, previews: 2, deferred: 1, expired: 0 });
  });

  it('replaces an older kept_both conflict when the Engine now keeps the pair apart, with no timestamp change (Codex, #726)', async () => {
    const d = db();
    upsertVerdict(d, { idA: 1, idB: 2, updatedAtA: 'T1', updatedAtB: 'T1', verdict: 'kept_both', adjudicatedAt: 'x' });
    const flagged: NearPair = { ...pair(mem(1, 'a', 'T1'), mem(2, 'b', 'T1')), subjects_apart: true };
    const r = await runReconcile(deps(fakes([flagged], []), cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ ledgerSkipped: 0, adjudicated: 0, keptApart: 1 });
    expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('kept_apart');
  });

  it('ledgers a pair kept apart when the Engine refuses the merge on subjects changed during the call (Codex, #726)', async () => {
    const refusal = new EngineError('CONFLICT', 'about different things', { subjects_apart: true });
    const f = fakes([pair(mem(1, 'A'), mem(2, 'B'))], [{ verdict: 'duplicate', survivor_id: 2 }], { expireError: refusal });
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ adjudicated: 1, expired: 0, keptApart: 1, errors: 0 });
    expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('kept_apart');
  });

  it('caps at reconcilePairCap', async () => {
    const pairs = [1, 2, 3].map(i => pair(mem(i * 10, `a${i}`), mem(i * 10 + 1, `b${i}`)));
    const f = fakes(pairs, [{ verdict: 'distinct' }]);
    const r = await runReconcile(deps(f, cfg({ reconcilePairCap: 2 }), db()), { dryRun: false, trigger: 'scheduled' });
    expect(r.adjudicated).toBe(2);
  });

  it('verdict failure skips without ledgering (retries next run) and counts an error', async () => {
    const f = fakes([pair(mem(1, 'a'), mem(2, 'b'))], [{ verdict: 'duplicate' }]); // missing survivor → parse null
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ errors: 1, adjudicated: 1, expired: 0 });
    expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
  });

  it('expiry failure is an error and the pair is NOT ledgered (retries)', async () => {
    const f = fakes([pair(mem(1, 'a'), mem(2, 'b'))], [{ verdict: 'duplicate', survivor_id: 2 }], { expireError: new Error('down') });
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ errors: 1, expired: 0 });
    expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
  });

  describe('note dates (#351)', () => {
    const dated = (id: number, noteDate: string | null): NearPair['a'] => ({ ...mem(id, `m${id}`), note_date: noteDate });

    it('a contradiction whose survivor has the older note keeps both, though it was extracted later', async () => {
      // The sweep works newest note first: 1 is the later note, 2 the older one extracted after it.
      const f = fakes([pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
      const d = db();
      const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
      expect(r).toMatchObject({ adjudicated: 1, keptBoth: 1, contradictions: 0, distinct: 0, expired: 0 });
      expect(f.calls).toEqual([]);
      expect(ledgerVerdict(d, 1, 2)?.verdict).toBe('kept_both');
    });

    it('a contradiction between notes of the same date keeps both', async () => {
      const f = fakes([pair(dated(1, '2026-09-01'), dated(2, '2026-09-01'))], [{ verdict: 'contradiction', survivor_id: 1 }]);
      const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
      expect(r).toMatchObject({ keptBoth: 1, expired: 0 });
      expect(f.calls).toEqual([]);
    });

    it('a kept pair stays out of the next run until a member changes', async () => {
      const kept = pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'));
      const d = db();
      await runReconcile(deps(fakes([kept], [{ verdict: 'contradiction', survivor_id: 2 }]), cfg(), d), { dryRun: false, trigger: 'scheduled' });
      const again = await runReconcile(deps(fakes([kept], []), cfg(), d), { dryRun: false, trigger: 'scheduled' });
      expect(again).toMatchObject({ ledgerSkipped: 1, adjudicated: 0 });
      const changed = pair({ ...kept.a, updated_at: 'T2' }, kept.b);
      const f = fakes([changed], [{ verdict: 'distinct' }]);
      expect(await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' })).toMatchObject({ adjudicated: 1 });
    });

    it('a contradiction whose survivor has the later note still expires the loser', async () => {
      const f = fakes([pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'))], [{ verdict: 'contradiction', survivor_id: 1 }]);
      const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
      expect(r).toMatchObject({ contradictions: 1, keptBoth: 0, expired: 1 });
      expect(f.calls).toEqual(['expire:2:contradicted:1']);
    });

    it.each([[null, '2026-09-01'], ['2026-09-01', null], [null, null]])('an unknown date leaves the contradiction alone (%s, %s)', async (a, b) => {
      const f = fakes([pair(dated(1, a), dated(2, b))], [{ verdict: 'contradiction', survivor_id: 1 }]);
      const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
      expect(r).toMatchObject({ contradictions: 1, keptBoth: 0, expired: 1 });
    });

    describe('a memory drawn from a chat is dated by its write (#706 follow-up)', () => {
      const chat = (id: number, writtenAt: string): NearPair['a'] =>
        ({ ...mem(id, `m${id}`), evidence_kind: 'conversation', note_date: null, created_at: writtenAt });
      const noted = (id: number, noteDate: string): NearPair['a'] => ({ ...dated(id, noteDate), evidence_kind: 'note' });

      it('an older note does not replace what a chat said', async () => {
        const f = fakes([pair(chat(1, '2026-11-10T15:00:00.000Z'), noted(2, '2021-03-04'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
        const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
        expect(r).toMatchObject({ keptBoth: 1, expired: 0 });
        expect(f.calls).toEqual([]);
      });

      it('nor does a note of the same day', async () => {
        const f = fakes([pair(chat(1, '2026-11-10T15:00:00.000Z'), noted(2, '2026-11-10'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
        expect(await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' })).toMatchObject({ keptBoth: 1, expired: 0 });
      });

      it('a later note still replaces it', async () => {
        const f = fakes([pair(chat(1, '2026-11-10T15:00:00.000Z'), noted(2, '2026-11-15'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
        const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
        expect(r).toMatchObject({ contradictions: 1, keptBoth: 0, expired: 1 });
        expect(f.calls).toEqual(['expire:1:contradicted:2']);
      });

      it("a chat still corrects a note's memory", async () => {
        const f = fakes([pair(chat(1, '2026-11-10T15:00:00.000Z'), noted(2, '2026-11-15'))], [{ verdict: 'contradiction', survivor_id: 1 }]);
        const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
        expect(r).toMatchObject({ contradictions: 1, keptBoth: 0, expired: 1 });
        expect(f.calls).toEqual(['expire:2:contradicted:1']);
      });
    });

    it('a duplicate still expires the loser, whatever the dates', async () => {
      const f = fakes([pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'))], [{ verdict: 'duplicate', survivor_id: 2 }]);
      const r = await runReconcile(deps(f, cfg(), db()), { dryRun: false, trigger: 'scheduled' });
      expect(r).toMatchObject({ duplicates: 1, keptBoth: 0, expired: 1 });
      expect(f.calls).toEqual(['expire:1:duplicate-of:2:2']);
    });

    it('a dry run previews a kept pair and writes nothing', async () => {
      const f = fakes([pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
      const d = db();
      const r = await runReconcile(deps(f, cfg(), d), { dryRun: true, trigger: 'cli' });
      expect(r).toMatchObject({ previews: 1, keptBoth: 0, expired: 0 });
      expect(f.calls).toEqual([]);
      expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
    });

    it('a failed ledger write counts an error, not a kept pair', async () => {
      const f = fakes([pair(dated(1, '2026-10-01'), dated(2, '2026-09-01'))], [{ verdict: 'contradiction', survivor_id: 2 }]);
      const d = db();
      blockLedgerWrites(d);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
        expect(r).toMatchObject({ errors: 1, keptBoth: 0, expired: 0 });
        expect(warn.mock.calls.flat().join(' ')).toContain('ledger write failed for kept_both pair 1/2');
      } finally { warn.mockRestore(); }
    });

    it('shows the model the note date in place of valid_at, and valid_at without one', () => {
      const a = { ...dated(1, '2026-09-01'), valid_at: '2026-11-04T02:00:00.000Z' };
      const b = { ...dated(2, null), valid_at: '2026-11-05T02:00:00.000Z' };
      const user = buildReconcileUser(pair(a, b));
      expect(user).toContain('note_date 2026-09-01');
      expect(user).not.toContain('valid_at 2026-11-04');
      expect(user).toContain('valid_at 2026-11-05T02:00:00.000Z');
      expect(RECONCILE_SYSTEM_PROMPT).toContain('prefer the later note_date');
    });

    it('names each memory\'s source note and its projects, and treats different contexts as different facts (#352)', () => {
      const a = { ...dated(1, '2026-10-05'), note_title: 'Acme sync', note_projects: ['Acme Pilot', 'Zenith Rollout'] };
      const b = { ...dated(2, null), note_title: null, note_projects: [] };
      const user = buildReconcileUser(pair(a, b));
      expect(user).toContain('MEMORY A [id 1, source chat, scope vault, note_date 2026-10-05, note "Acme sync", filed under Acme Pilot; Zenith Rollout]');
      expect(user.split('MEMORY B')[1]).not.toContain('note "');
      expect(user.split('MEMORY B')[1]).not.toContain('filed under');
      expect(RECONCILE_SYSTEM_PROMPT).toContain('Memories from notes filed under different projects');
    });
  });

  it('dry-run adjudicates but neither expires nor ledgers', async () => {
    const f = fakes([pair(mem(1, 'a'), mem(2, 'b'))], [{ verdict: 'duplicate', survivor_id: 2 }]);
    const d = db();
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: true, trigger: 'cli' });
    expect(r).toMatchObject({ previews: 1, expired: 0 });
    expect(f.calls).toEqual([]);
    expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
  });

  it('a thrown shortlist fetch is captured, never rejected', async () => {
    const engine = { listMemoryNearPairs: async () => { throw new Error('engine down'); } } as unknown as Engine;
    const r = await runReconcile({ engine, llm: { structuredCall: async () => ({ output: {}, usage: USAGE }) }, config: cfg(), queue: new CurationQueue(), db: db() }, { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ ran: true, errors: 1 });
  });

  // Blocks writes to reconcile_ledger while leaving reads intact, so the filter
  // phase (ledgerVerdict SELECT) is unaffected — only upsertVerdict fails.
  function blockLedgerWrites(d: Database.Database): void {
    d.exec("CREATE TRIGGER block_ledger BEFORE INSERT ON reconcile_ledger BEGIN SELECT RAISE(ABORT, 'ledger blocked'); END;");
  }

  it('distinct: a ledger-write failure is an error but does NOT abort the run — later pairs still process', async () => {
    const d = db();
    blockLedgerWrites(d);
    const f = fakes(
      [pair(mem(1, 'about a'), mem(2, 'about b')), pair(mem(3, 'about c'), mem(4, 'about d'))],
      [{ verdict: 'distinct' }, { verdict: 'distinct' }],
    );
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(r).toMatchObject({ ran: true, adjudicated: 2, distinct: 0, errors: 2 });
    expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
    expect(ledgerVerdict(d, 3, 4)).toBeUndefined();
  });

  it('duplicate: a ledger-write failure AFTER a landed expiry still counts the expiry (accurately labeled, unledgered → retries)', async () => {
    const d = db();
    blockLedgerWrites(d);
    const f = fakes([pair(mem(1, 'fact v1'), mem(2, 'fact v1 duplicate'))], [{ verdict: 'duplicate', survivor_id: 2 }]);
    const r = await runReconcile(deps(f, cfg(), d), { dryRun: false, trigger: 'scheduled' });
    expect(f.calls).toEqual(['expire:1:duplicate-of:2:2']);
    expect(r).toMatchObject({ expired: 1, duplicates: 1, errors: 1 });
    expect(ledgerVerdict(d, 1, 2)).toBeUndefined();
  });
});
