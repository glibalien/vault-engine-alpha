import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { changedEvidenceComponents, readEvidenceManifest, writeEvidenceManifest } from '../src/db/evidence-manifests.js';

const components = { status: 's', tasks: 't', notes: 'n', meetings: 'm', contacts: 'c' };

describe('evidence manifests', () => {
  it('round-trips and replaces a project manifest', () => {
    const db = new Database(':memory:'); runMigrations(db);
    expect(readEvidenceManifest(db, 'P')).toBeNull();
    writeEvidenceManifest(db, 'P', { evidenceHash: 'h1', components, curatedAt: '2026-10-25T05:00:00.000Z' });
    writeEvidenceManifest(db, 'P', { evidenceHash: 'h2', components: { ...components, tasks: 't2' }, curatedAt: '2026-10-26T05:00:00.000Z' });
    expect(readEvidenceManifest(db, 'P')).toEqual({ evidenceHash: 'h2', components: { ...components, tasks: 't2' },
      curatedAt: '2026-10-26T05:00:00.000Z' });
    db.close();
  });

  it('treats an unreadable manifest as absent', () => {
    const db = new Database(':memory:'); runMigrations(db);
    db.prepare("INSERT INTO wiki_evidence_manifests VALUES ('P', 'h', '{\"tasks\":1}', 'now')").run();
    expect(readEvidenceManifest(db, 'P')).toBeNull();
    db.close();
  });

  it('lists changed components in a stable order', () => {
    expect(changedEvidenceComponents(components, components)).toEqual([]);
    expect(changedEvidenceComponents(components, { ...components, contacts: 'x', tasks: 'y' })).toEqual(['tasks', 'contacts']);
  });
});
