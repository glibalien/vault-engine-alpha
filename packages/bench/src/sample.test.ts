import { describe, it, expect } from 'vitest';
import { mulberry32, stratifiedSample, ALL_TURN_CLASSES } from './sample.js';
import type { CorpusTurn } from './corpus.js';
import type { TurnClass } from './classify.js';

// Every TurnClass except the one named, each with `requested`/`available: 0`
// shortfall entries — used by tests whose input pool only covers a subset
// of classes, to assert the OTHER classes are still reported rather than
// silently absent.
function zeroShortfallsExcept(present: TurnClass, requested: number): { turnClass: TurnClass; requested: number; available: number }[] {
  return ALL_TURN_CLASSES.filter((c) => c !== present).map((turnClass) => ({ turnClass, requested, available: 0 }));
}

function makeTurn(
  conversationId: string,
  seq: number,
  turnClass: TurnClass,
  overrides: Partial<CorpusTurn> = {}
): CorpusTurn {
  return {
    conversationId,
    seq,
    turnClass,
    history: [],
    recordedCalls: [],
    partial: false,
    unknownTools: [],
    modelRef: null,
    contextState: { doc: true, board: true, nodes: [] },
    conversationUpdatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// A reasonably sized pool of replayable turns spread across classes, used by
// several tests below. 'single-write' is deliberately kept small (3) to
// exercise the shortfall path with a realistic class.
function buildPool(): CorpusTurn[] {
  const turns: CorpusTurn[] = [];
  const classes: TurnClass[] = ['trivial', 'single-read', 'multi-read', 'complex'];
  for (const cls of classes) {
    for (let i = 0; i < 10; i++) {
      turns.push(makeTurn(`conv-${cls}`, i, cls));
    }
  }
  for (let i = 0; i < 3; i++) {
    turns.push(makeTurn('conv-single-write', i, 'single-write'));
  }
  return turns;
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const gen1 = mulberry32(42);
    const gen2 = mulberry32(42);
    const seq1 = Array.from({ length: 5 }, () => gen1());
    const seq2 = Array.from({ length: 5 }, () => gen2());
    expect(seq1).toEqual(seq2);
  });

  it('produces values in [0, 1)', () => {
    const gen = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = gen();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('stratifiedSample', () => {
  it('same seed → identical selection across independent runs', () => {
    const pool = buildPool();
    const result1 = stratifiedSample(pool, { perClass: 4, seed: 7 });
    const result2 = stratifiedSample(pool, { perClass: 4, seed: 7 });
    expect(result2.turns).toEqual(result1.turns);
    expect(result2.shortfalls).toEqual(result1.shortfalls);
  });

  it('different seed → different selection', () => {
    const pool = buildPool();
    const result1 = stratifiedSample(pool, { perClass: 4, seed: 1 });
    const result2 = stratifiedSample(pool, { perClass: 4, seed: 2 });
    expect(result2.turns).not.toEqual(result1.turns);
  });

  it('honors per-class counts', () => {
    const pool = buildPool();
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 4, seed: 7 });
    // single-write only has 3 available, so it will show up in shortfalls
    // and contribute only 3 turns; every other class has 10 available and
    // should contribute exactly 4.
    const byClass = new Map<TurnClass, CorpusTurn[]>();
    for (const t of turns) {
      const list = byClass.get(t.turnClass) ?? [];
      list.push(t);
      byClass.set(t.turnClass, list);
    }
    expect(byClass.get('trivial')).toHaveLength(4);
    expect(byClass.get('single-read')).toHaveLength(4);
    expect(byClass.get('multi-read')).toHaveLength(4);
    expect(byClass.get('complex')).toHaveLength(4);
    expect(byClass.get('single-write')).toHaveLength(3);
    expect(shortfalls).toEqual([{ turnClass: 'single-write', requested: 4, available: 3 }]);
  });

  it('iterating the full TurnClass union does not shift the RNG stream for classes that already had turns (fix-round-1 regression guard)', () => {
    // Exact turns[]/shortfalls[] captured from stratifiedSample(buildPool(),
    // { perClass: 4, seed: 7 }) on the pre-fix implementation, which only
    // iterated classes present in the input map (buildPool covers all 5
    // classes, so that iteration was already the same alphabetical order as
    // ALL_TURN_CLASSES). Re-asserting the identical selection here proves
    // that making stratifiedSample walk the full TurnClass union — so
    // wholly-absent classes get a shortfall entry — did not change which
    // turns a given seed picks for classes that DO have turns: an empty
    // class's shuffle() is a 0-iteration no-op, so it consumes no rng()
    // draws and cannot shift later classes' selections.
    const pool = buildPool();
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 4, seed: 7 });
    expect(turns.map((t) => `${t.turnClass}:${t.conversationId}:${t.seq}`)).toEqual([
      'complex:conv-complex:6',
      'complex:conv-complex:5',
      'complex:conv-complex:8',
      'complex:conv-complex:1',
      'multi-read:conv-multi-read:8',
      'multi-read:conv-multi-read:6',
      'multi-read:conv-multi-read:4',
      'multi-read:conv-multi-read:9',
      'single-read:conv-single-read:9',
      'single-read:conv-single-read:5',
      'single-read:conv-single-read:3',
      'single-read:conv-single-read:4',
      'single-write:conv-single-write:1',
      'single-write:conv-single-write:0',
      'single-write:conv-single-write:2',
      'trivial:conv-trivial:1',
      'trivial:conv-trivial:0',
      'trivial:conv-trivial:2',
      'trivial:conv-trivial:6',
    ]);
    expect(shortfalls).toEqual([{ turnClass: 'single-write', requested: 4, available: 3 }]);
  });

  it('a class with 3 turns and perClass 40 returns all 3 plus a shortfall entry', () => {
    const pool = [
      makeTurn('conv-sw', 0, 'single-write'),
      makeTurn('conv-sw', 1, 'single-write'),
      makeTurn('conv-sw', 2, 'single-write'),
    ];
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 40, seed: 7 });
    expect(turns).toHaveLength(3);
    // The other 4 classes are entirely absent from the input pool — each
    // must still surface as a { available: 0 } shortfall, not be silently
    // skipped (they are absent from `turns` because there is nothing to
    // sample, but present in `shortfalls`).
    expect(shortfalls).toEqual(
      [{ turnClass: 'single-write', requested: 40, available: 3 }, ...zeroShortfallsExcept('single-write', 40)].sort(
        (a, b) => (a.turnClass < b.turnClass ? -1 : a.turnClass > b.turnClass ? 1 : 0)
      )
    );
  });

  it('never samples non-replayable turns', () => {
    const pool = [
      makeTurn('conv-a', 0, 'trivial', { partial: true }),
      makeTurn('conv-a', 1, 'trivial', { unknownTools: ['create-wiki'] }),
      makeTurn('conv-a', 2, 'trivial'),
    ];
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 40, seed: 7 });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.seq).toBe(2);
    // 'trivial' has 1 available (out of 3 in the pool, 2 non-replayable);
    // the 4 classes wholly absent from the input still report available: 0.
    expect(shortfalls).toEqual(
      [{ turnClass: 'trivial', requested: 40, available: 1 }, ...zeroShortfallsExcept('trivial', 40)].sort((a, b) =>
        a.turnClass < b.turnClass ? -1 : a.turnClass > b.turnClass ? 1 : 0
      )
    );
  });

  it('a class entirely absent from the input produces a shortfall entry with available: 0', () => {
    // Pool only contains 'single-write' turns, well above perClass, so that
    // class needs no shortfall of its own — but the other 4 classes never
    // appear in the input at all and must still be reported.
    const pool = Array.from({ length: 5 }, (_, i) => makeTurn('conv-sw', i, 'single-write'));
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 3, seed: 7 });
    expect(turns).toHaveLength(3);
    expect(turns.every((t) => t.turnClass === 'single-write')).toBe(true);
    expect(shortfalls).toEqual(
      zeroShortfallsExcept('single-write', 3).sort((a, b) => (a.turnClass < b.turnClass ? -1 : 1))
    );
    // Confirms no shortfall entry was emitted for the fully-satisfied class.
    expect(shortfalls.some((s) => s.turnClass === 'single-write')).toBe(false);
  });

  it('a class present but with every turn non-replayable produces a shortfall entry with available: 0, and none of its turns are sampled', () => {
    const pool = [
      makeTurn('conv-sw', 0, 'single-write', { partial: true }),
      makeTurn('conv-sw', 1, 'single-write', { unknownTools: ['create-wiki'] }),
      ...Array.from({ length: 5 }, (_, i) => makeTurn('conv-triv', i, 'trivial')),
    ];
    const { turns, shortfalls } = stratifiedSample(pool, { perClass: 3, seed: 7 });
    expect(turns.some((t) => t.turnClass === 'single-write')).toBe(false);
    const swShortfall = shortfalls.find((s) => s.turnClass === 'single-write');
    expect(swShortfall).toEqual({ turnClass: 'single-write', requested: 3, available: 0 });
  });

  it('input array order does not affect selection', () => {
    const pool = buildPool();

    // Shuffle a copy of the pool using a mechanism entirely independent of
    // mulberry32 (Array.sort with a deterministic-but-unrelated comparator
    // based on string comparison of a derived key), to prove that
    // stratifiedSample's internal (conversationId, seq) sort neutralizes
    // input order before the seeded shuffle runs.
    const shuffled = [...pool].sort((a, b) => {
      const ka = `${a.seq}-${a.conversationId}`;
      const kb = `${b.seq}-${b.conversationId}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    expect(shuffled).not.toEqual(pool); // sanity: order actually changed

    const resultOriginal = stratifiedSample(pool, { perClass: 4, seed: 7 });
    const resultShuffled = stratifiedSample(shuffled, { perClass: 4, seed: 7 });
    expect(resultShuffled.turns).toEqual(resultOriginal.turns);
    expect(resultShuffled.shortfalls).toEqual(resultOriginal.shortfalls);
  });

  it('does not mutate the caller-supplied input array', () => {
    const pool = buildPool();
    const poolCopy = [...pool];
    stratifiedSample(pool, { perClass: 4, seed: 7 });
    expect(pool).toEqual(poolCopy);
    expect(pool.map((t) => t.conversationId)).toEqual(poolCopy.map((t) => t.conversationId));
  });
});
