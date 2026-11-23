// Stratified sampler: picks an even number of turns per TurnClass from the
// replay corpus, deterministically (seeded PRNG, never Math.random()) so
// separate benchmark runs sample the same turns given the same seed. Classes
// are very unevenly sized (see packages/bench task briefs), so this samples
// evenly ACROSS classes rather than proportionally.

import type { CorpusTurn } from './corpus.js';
import { replayable } from './corpus.js';
import type { TurnClass } from './classify.js';

export interface SampleResult {
  turns: CorpusTurn[];
  shortfalls: { turnClass: TurnClass; requested: number; available: number }[];
}

// Exhaustiveness guard: this object literal must have exactly one property
// per TurnClass member — TypeScript's mapped-type ("missing property") and
// object-literal excess-property checks both fire on it, so adding a member
// to (or removing one from) the TurnClass union without mirroring the
// change here fails the build. ALL_TURN_CLASSES below is derived from this
// object rather than hand-written, so it can never silently drift from the
// union.
const TURN_CLASS_MEMBERSHIP: { [K in TurnClass]: true } = {
  trivial: true,
  'single-write': true,
  'single-read': true,
  complex: true,
  'multi-read': true,
};

/** Every TurnClass, in a fixed order (alphabetical) — used so every class
 *  yields either sampled turns or a shortfall entry, even one with zero
 *  available turns. See TURN_CLASS_MEMBERSHIP above for why this can't
 *  silently miss a class. */
export const ALL_TURN_CLASSES: readonly TurnClass[] = (
  Object.keys(TURN_CLASS_MEMBERSHIP) as TurnClass[]
).sort();

/** Deterministic PRNG in [0, 1). Verbatim mulberry32 per the task brief. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle, driven by the given PRNG. */
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue; // unreachable: i,j < items.length
    items[i] = b;
    items[j] = a;
  }
}

export function stratifiedSample(turns: CorpusTurn[], opts: { perClass: number; seed: number }): SampleResult {
  const rng = mulberry32(opts.seed);

  const byClass = new Map<TurnClass, CorpusTurn[]>();
  for (const t of turns) {
    if (!replayable(t)) continue;
    const list = byClass.get(t.turnClass);
    if (list) {
      list.push(t);
    } else {
      byClass.set(t.turnClass, [t]);
    }
  }

  const selected: CorpusTurn[] = [];
  const shortfalls: SampleResult['shortfalls'] = [];

  // Iterate the full TurnClass union (fixed alphabetical order), not just
  // the classes present in `turns` — a class absent from the input, or
  // present but 100% filtered out by replayable(), must still surface a
  // shortfall entry rather than being silently skipped. A class with no
  // turns produces an empty `sorted` array below, whose shuffle is a no-op
  // (0 rng() calls), so inserting it into this fixed loop does not consume
  // any PRNG draws and therefore cannot shift the selection made for any
  // other class — determinism for classes that DO have turns is unchanged.
  for (const turnClass of ALL_TURN_CLASSES) {
    const pool = byClass.get(turnClass) ?? [];

    // Stable order before shuffling: DB/array iteration order is not a
    // contract, so without this two runs over the same logical data but
    // different input ordering could select different turns for the same
    // seed.
    const sorted = [...pool].sort((a, b) => {
      if (a.conversationId !== b.conversationId) {
        return a.conversationId < b.conversationId ? -1 : 1;
      }
      return a.seq - b.seq;
    });

    shuffle(sorted, rng);

    const take = Math.min(opts.perClass, sorted.length);
    for (let i = 0; i < take; i++) {
      const turn = sorted[i];
      if (turn !== undefined) selected.push(turn);
    }

    if (sorted.length < opts.perClass) {
      shortfalls.push({ turnClass, requested: opts.perClass, available: sorted.length });
    }
  }

  return { turns: selected, shortfalls };
}
