import type Database from 'better-sqlite3';

/**
 * Deterministic pairwise near-pair computation over LIVE memories, across
 * sources and scopes — the candidate net for reconciliation (Memories v3 §4c)
 * and vault-doctor's memories_near_pair_band invariant.
 *
 * Pure JS pairwise cosine (not vec0 KNN): the stock is small (hundreds), the
 * vectors are already stored, and a self-join MATCH per row would be O(n·k)
 * with the same asymptotics anyway. MAX_ROWS caps the O(n²) loop; beyond it
 * the most recent rows win and `truncated` is set.
 */
const MAX_ROWS = 1500;

export interface NearPairsResult {
  pairs: Array<{ a_id: number; b_id: number; distance: number }>;
  total_in_band: number;
  considered: number;
  skipped_unembedded: number;
  truncated: boolean;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

/** limit: 0 = count-only (no pair hydration). */
export function computeNearPairs(
  db: Database.Database,
  opts: { near: number; far: number; limit: number },
): NearPairsResult {
  const skipped = db.prepare(
    'SELECT COUNT(*) AS c FROM memories WHERE expired_at IS NULL AND vec_id IS NULL',
  ).get() as { c: number };

  const rows = db.prepare(
    `SELECT m.id, v.vector AS vector
     FROM memories m JOIN memory_embedding_vec v ON v.id = m.vec_id
     WHERE m.expired_at IS NULL
     ORDER BY m.id DESC
     LIMIT ${MAX_ROWS + 1}`,
  ).all() as Array<{ id: number; vector: Buffer }>;

  const truncated = rows.length > MAX_ROWS;
  const live = (truncated ? rows.slice(0, MAX_ROWS) : rows).map((r) => ({
    id: r.id,
    vec: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4),
  }));

  const inBand: Array<{ a_id: number; b_id: number; distance: number }> = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const d = cosineDistance(live[i]!.vec, live[j]!.vec);
      if (d >= opts.near && d <= opts.far) {
        const [a_id, b_id] = live[i]!.id < live[j]!.id ? [live[i]!.id, live[j]!.id] : [live[j]!.id, live[i]!.id];
        inBand.push({ a_id, b_id, distance: d });
      }
    }
  }
  inBand.sort((x, y) => x.distance - y.distance || x.a_id - y.a_id || x.b_id - y.b_id);

  return {
    pairs: opts.limit > 0 ? inBand.slice(0, opts.limit) : [],
    total_in_band: inBand.length,
    considered: live.length,
    skipped_unembedded: skipped.c,
    truncated,
  };
}
