import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { correctionInputs, runLocalCorrections } from '../src/db/provenance.js';
import { defaultsFor } from '@vault/settings-registry';

describe('provenance activation and correction identities', () => {
  it('is disabled until explicitly enabled', () => {
    expect(defaultsFor('curator').projectHomeProvenanceEnabled).toBe(false);
  });
  it('persists the installation namespace while content changes get new digests', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      db.prepare("INSERT INTO wiki_corrections(project_title,note,created_at,status) VALUES ('Project','Corrected input','2026-09-17','active')").run();
      const first = correctionInputs(db, 'Project');
      runMigrations(db);
      db.prepare("UPDATE wiki_corrections SET note='Updated correction'").run();
      const second = correctionInputs(db, 'Project');
      expect(second[0]?.observation.source).toEqual(first[0]?.observation.source);
      expect(second[0]?.observation.observation_digest).not.toBe(first[0]?.observation.observation_digest);
      expect(second[0]?.observation.authority).toBe('caller');
      expect(db.pragma('user_version', { simple: true })).toBe(41);
    } finally { db.close(); }
  });
  it('scopes corrections without a Curator DB to the current run', () => {
    const first = runLocalCorrections(['Synthetic'], 'run-one');
    const second = runLocalCorrections(['Synthetic'], 'run-two');
    expect(first[0]?.observation.source.namespace).not.toBe(second[0]?.observation.source.namespace);
  });
});
