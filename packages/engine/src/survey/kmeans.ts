/**
 * Deterministic spherical k-means for the note survey (#642).
 *
 * Vectors are unit length and stored flat (`count * dims` floats), so similarity is a dot
 * product and a centre is the normalized mean of its members. Every run over the same vectors
 * in the same order gives the same groups: seeding uses a fixed-seed generator, and ties go to
 * the lower index.
 */

export interface VectorSet {
  /** `count * dims` floats; row `i` starts at `i * dims`. Rows are unit length. */
  data: Float32Array;
  count: number;
  dims: number;
}

export interface Assignment {
  /** Centre index per vector. */
  centre: Int32Array;
  /** Cosine similarity of each vector to its centre. */
  similarity: Float32Array;
}

export interface FitOptions {
  /** Most refinement passes per start. */
  iterations?: number;
  /** Independent seedings; the tightest result wins. */
  restarts?: number;
  seed?: number;
}

const DEFAULT_ITERATIONS = 15;
const DEFAULT_RESTARTS = 2;
const DEFAULT_SEED = 0x642;

/** Small fixed-seed generator (mulberry32), so seeding never depends on `Math.random`. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scales `dims` floats at `offset` to unit length in place. False for a zero vector. */
export function normalizeAt(data: Float32Array, offset: number, dims: number): boolean {
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += data[offset + i]! * data[offset + i]!;
  if (sum === 0) return false;
  const scale = 1 / Math.sqrt(sum);
  for (let i = 0; i < dims; i++) data[offset + i] = data[offset + i]! * scale;
  return true;
}

function dot(a: Float32Array, aOffset: number, b: Float32Array, bOffset: number, dims: number): number {
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += a[aOffset + i]! * b[bOffset + i]!;
  return sum;
}

/** Assigns every vector to its most similar centre; ties go to the lower centre index. */
export function assignToCentres(vectors: VectorSet, centres: Float32Array): Assignment {
  const { data, count, dims } = vectors;
  const k = centres.length / dims;
  const centre = new Int32Array(count);
  const similarity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let best = 0;
    let bestSimilarity = -Infinity;
    for (let c = 0; c < k; c++) {
      const s = dot(data, i * dims, centres, c * dims, dims);
      if (s > bestSimilarity) {
        bestSimilarity = s;
        best = c;
      }
    }
    centre[i] = best;
    similarity[i] = bestSimilarity;
  }
  return { centre, similarity };
}

/** k-means++ seeding: each next centre is drawn in proportion to its distance from the chosen ones. */
function seedCentres(vectors: VectorSet, k: number, random: () => number): Float32Array {
  const { data, count, dims } = vectors;
  const centres = new Float32Array(k * dims);
  const distance = new Float64Array(count).fill(Infinity);
  let chosen = Math.min(count - 1, Math.floor(random() * count));
  let used = 0;
  for (let c = 0; c < k; c++) {
    centres.set(data.subarray(chosen * dims, (chosen + 1) * dims), c * dims);
    used = c + 1;
    let total = 0;
    for (let i = 0; i < count; i++) {
      const d = Math.max(0, 1 - dot(data, i * dims, centres, c * dims, dims));
      if (d < distance[i]!) distance[i] = d;
      total += distance[i]!;
    }
    // Every remaining vector sits on a chosen centre: there are fewer distinct notes than k.
    if (total <= 1e-9) break;
    const target = random() * total;
    let running = 0;
    chosen = count - 1;
    for (let i = 0; i < count; i++) {
      running += distance[i]!;
      if (running >= target) {
        chosen = i;
        break;
      }
    }
  }
  return used === k ? centres : centres.slice(0, used * dims);
}

function refine(vectors: VectorSet, start: Float32Array, iterations: number): { centres: Float32Array; score: number } {
  const { data, count, dims } = vectors;
  const k = start.length / dims;
  let centres = start;
  let assignment = assignToCentres(vectors, centres);
  for (let pass = 0; pass < iterations; pass++) {
    const next = new Float32Array(k * dims);
    const members = new Int32Array(k);
    for (let i = 0; i < count; i++) {
      const c = assignment.centre[i]!;
      members[c] = members[c]! + 1;
      for (let j = 0; j < dims; j++) next[c * dims + j] = next[c * dims + j]! + data[i * dims + j]!;
    }
    for (let c = 0; c < k; c++) {
      // A centre that lost every member, or whose members cancel out, keeps its old position.
      if (members[c] === 0 || !normalizeAt(next, c * dims, dims)) {
        next.set(centres.subarray(c * dims, (c + 1) * dims), c * dims);
      }
    }
    const reassigned = assignToCentres(vectors, next);
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (reassigned.centre[i] !== assignment.centre[i]) {
        changed = true;
        break;
      }
    }
    centres = next;
    assignment = reassigned;
    if (!changed) break;
  }
  let score = 0;
  for (let i = 0; i < count; i++) score += assignment.similarity[i]!;
  return { centres, score };
}

/**
 * Fits up to `k` centres to the vectors. Returns fewer when there are fewer distinct vectors
 * than `k`. The result is a flat array of unit-length centres.
 */
export function fitCentres(vectors: VectorSet, k: number, options: FitOptions = {}): Float32Array {
  const wanted = Math.max(1, Math.min(k, vectors.count));
  if (vectors.count === 0) return new Float32Array(0);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const restarts = Math.max(1, options.restarts ?? DEFAULT_RESTARTS);
  const random = seededRandom(options.seed ?? DEFAULT_SEED);
  let best: { centres: Float32Array; score: number } | null = null;
  for (let attempt = 0; attempt < restarts; attempt++) {
    const result = refine(vectors, seedCentres(vectors, wanted, random), iterations);
    if (best === null || result.score > best.score) best = result;
  }
  return best!.centres;
}

/** Every `stride`-th vector, at most `limit` of them: the sample centres are fitted on. */
export function sampleVectors(vectors: VectorSet, limit: number): VectorSet {
  if (vectors.count <= limit) return vectors;
  const { data, count, dims } = vectors;
  const sample = new Float32Array(limit * dims);
  for (let i = 0; i < limit; i++) {
    const source = Math.floor((i * count) / limit);
    sample.set(data.subarray(source * dims, (source + 1) * dims), i * dims);
  }
  return { data: sample, count: limit, dims };
}
