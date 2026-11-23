import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { SettingsService } from '../../src/settings/service.js';
import { readProvenanceLimits } from '../../src/provenance/limits.js';
import { getPendingSettingsNoteFields } from '../../src/settings/store.js';
import { noteFor } from '../helpers/settings-notes.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = createTestDb(); databases.push(db);
  return { db, service: new SettingsService(db, { settingsDir: 'Settings' }) };
}
const small = { provenanceRequestBytes: 4096, provenanceComponentBytes: 1024,
  provenanceOutputBytes: 2048, provenanceTotalBytes: 8192, provenanceCapacityBytes: 16384 };

describe('coupled provenance settings', () => {
  it.each([
    { provenanceTotalBytes: 1024 },
    { provenanceRequestBytes: 1024 },
    { provenanceCapacityBytes: 1024 },
    { provenanceRequestBytes: 1024, provenanceComponentBytes: 1024, provenanceTotalBytes: 2048 },
  ])('rejects an inconsistent effective configuration: %j', patch => {
    const { db, service } = fixture(); const listener = vi.fn();
    service.onChange('engine', listener);
    const before = service.engine();
    const result = service.applyPatch('engine', patch, { journalProjection: true });
    expect(result).toMatchObject({ changed: false, applied: [] });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every(i => i.code === 'SETTINGS_INVALID_VALUE')).toBe(true);
    expect(service.engine()).toEqual(before);
    expect(service.version('engine')).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(getPendingSettingsNoteFields(db, 'engine')).toEqual([]);
    expect(() => readProvenanceLimits(service.engine())).not.toThrow();
  });

  it('accepts coordinated reductions and rejects a partial reset, retaining unrelated changes', () => {
    const { service } = fixture();
    expect(service.applyPatch('engine', small).issues).toEqual([]);
    const result = service.applyPatch('engine', { provenanceRequestBytes: null, backupKeep: 3, provenanceLeaseHours: 12 });
    expect(result.applied).toEqual(['backupKeep', 'provenanceLeaseHours']);
    expect(result.issues).toEqual([expect.objectContaining({ key: 'provenanceRequestBytes' })]);
    expect(service.engine()).toMatchObject({ ...small, backupKeep: 3, provenanceLeaseHours: 12 });
    expect(() => readProvenanceLimits(service.engine())).not.toThrow();
    expect(service.applyPatch('engine', Object.fromEntries(Object.keys(small).map(k => [k, null]))).issues).toEqual([]);
    expect(service.stored('engine')).toEqual({ backupKeep: 3, provenanceLeaseHours: 12 });
  });

  it('validates file snapshots including implicit resets against last-good coupled values', () => {
    const { service } = fixture(); service.applyPatch('engine', small);
    // The limits are shown in Settings/Engine/Provenance.md (#746), with the lease hours.
    const provenance = noteFor('engine', 'provenanceComponentBytes');
    const { provenanceComponentBytes: _omitted, ...partial } = small;
    const result = service.replaceFromFile(provenance, { ...partial, provenanceLeaseHours: 12 });
    expect(result.applied).toEqual(['provenanceLeaseHours']);
    expect(result.issues).toContainEqual(expect.objectContaining({ key: 'provenanceComponentBytes' }));
    expect(service.engine()).toMatchObject({ ...small, provenanceLeaseHours: 12 });
    expect(() => readProvenanceLimits(service.engine())).not.toThrow();
    expect(service.replaceFromFile(provenance, {}).issues).toEqual([]);
    expect(service.stored('engine')).toEqual({});
  });
});
