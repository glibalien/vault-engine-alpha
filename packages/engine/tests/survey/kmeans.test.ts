import { describe, expect, it } from 'vitest';
import {
  assignToCentres, fitCentres, normalizeAt, sampleVectors, seededRandom, type VectorSet,
} from '../../src/survey/kmeans.js';

const DIMS = 8;

/** Unit vectors scattered tightly around each axis in `axes`, `perAxis` of each, interleaved. */
function clustered(axes: number[], perAxis: number): VectorSet {
  const random = seededRandom(7);
  const count = axes.length * perAxis;
  const data = new Float32Array(count * DIMS);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < DIMS; d++) data[i * DIMS + d] = (random() - 0.5) * 0.2;
    data[i * DIMS + axes[i % axes.length]!] = 1;
    normalizeAt(data, i * DIMS, DIMS);
  }
  return { data, count, dims: DIMS };
}

describe('survey k-means', () => {
  it('separates well-separated clusters', () => {
    const vectors = clustered([0, 3, 6], 40);
    const { centre } = assignToCentres(vectors, fitCentres(vectors, 3));
    // Every vector built around the same axis lands on the same centre, and the three differ.
    const byAxis = [0, 1, 2].map(axis => new Set(Array.from(centre).filter((_, i) => i % 3 === axis)));
    for (const centres of byAxis) expect(centres.size).toBe(1);
    expect(new Set(byAxis.map(centres => [...centres][0])).size).toBe(3);
  });

  it('gives the same centres for the same vectors', () => {
    const vectors = clustered([1, 2, 4, 5], 25);
    expect(Array.from(fitCentres(vectors, 4))).toEqual(Array.from(fitCentres(vectors, 4)));
  });

  it('returns fewer centres when there are fewer distinct vectors than asked for', () => {
    const data = new Float32Array(6 * DIMS);
    for (let i = 0; i < 6; i++) data[i * DIMS + (i % 2)] = 1;
    const centres = fitCentres({ data, count: 6, dims: DIMS }, 5);
    expect(centres.length / DIMS).toBe(2);
  });

  it('fits nothing to nothing and one centre to one vector', () => {
    expect(fitCentres({ data: new Float32Array(0), count: 0, dims: DIMS }, 3).length).toBe(0);
    const one = clustered([2], 1);
    const centres = fitCentres(one, 3);
    expect(centres.length / DIMS).toBe(1);
    expect(assignToCentres(one, centres).similarity[0]).toBeCloseTo(1, 5);
  });

  it('samples evenly and leaves a small set alone', () => {
    const vectors = clustered([0, 1], 50);
    expect(sampleVectors(vectors, 200)).toBe(vectors);
    const sample = sampleVectors(vectors, 10);
    expect(sample.count).toBe(10);
    expect(Array.from(sample.data.subarray(DIMS, 2 * DIMS))).toEqual(Array.from(vectors.data.subarray(10 * DIMS, 11 * DIMS)));
  });
});
