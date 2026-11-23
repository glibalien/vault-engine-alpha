import { describe, expect, it } from 'vitest';
import { defaultsFor, descriptorsFor, validateDomainPatch } from '../src/index.js';

describe('provenance settings', () => {
  it('provides bounded defaults with no environment seeds', () => {
    const values = defaultsFor('engine');
    expect(values.provenanceRequestBytes).toBe(1024 * 1024);
    expect(values.provenanceTotalBytes).toBe(2 * 1024 * 1024);
    expect(values.provenanceCapacityBytes).toBe(1024 ** 3);
    expect(descriptorsFor('engine').filter(d => d.key.startsWith('provenance')).every(d => d.envSeed === undefined)).toBe(true);
    expect(validateDomainPatch('engine', { provenanceRequestBytes: 1024 * 1024 + 1 }).issues).not.toHaveLength(0);
    expect(validateDomainPatch('engine', { provenanceRequestBytes: 512 }).issues).toHaveLength(0);
  });
});
