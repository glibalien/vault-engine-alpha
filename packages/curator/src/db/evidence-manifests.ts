import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { EvidenceComponents } from '../types.js';

/** The evidence a project's narrative was last written from; lets a run tell which part changed. */
export interface EvidenceManifest {
  evidenceHash: string;
  components: EvidenceComponents;
  curatedAt: string;
}

const componentsSchema = z.object({
  status: z.string(), tasks: z.string(), notes: z.string(), meetings: z.string(), contacts: z.string(),
}).strict();

/** DDL for migration 26. */
export function createEvidenceManifestTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE wiki_evidence_manifests (
      project         TEXT PRIMARY KEY,
      evidence_hash   TEXT NOT NULL,
      components_json TEXT NOT NULL,
      curated_at      TEXT NOT NULL
    );
  `);
}

/** The stored manifest, or null when absent or unreadable (callers then refresh fully). */
export function readEvidenceManifest(db: Database.Database, project: string): EvidenceManifest | null {
  const row = db.prepare('SELECT evidence_hash, components_json, curated_at FROM wiki_evidence_manifests WHERE project = ?')
    .get(project) as { evidence_hash: string; components_json: string; curated_at: string } | undefined;
  if (!row) return null;
  try {
    const components = componentsSchema.parse(JSON.parse(row.components_json));
    return { evidenceHash: row.evidence_hash, components, curatedAt: row.curated_at };
  } catch {
    return null;
  }
}

export function writeEvidenceManifest(db: Database.Database, project: string, manifest: EvidenceManifest): void {
  db.prepare(`
    INSERT INTO wiki_evidence_manifests (project, evidence_hash, components_json, curated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET evidence_hash = excluded.evidence_hash,
      components_json = excluded.components_json, curated_at = excluded.curated_at
  `).run(project, manifest.evidenceHash, JSON.stringify(manifest.components), manifest.curatedAt);
}

export function deleteEvidenceManifest(db: Database.Database, project: string): void {
  db.prepare('DELETE FROM wiki_evidence_manifests WHERE project = ?').run(project);
}

/** Names of the components whose fingerprints differ, in a stable order. */
export function changedEvidenceComponents(prior: EvidenceComponents, current: EvidenceComponents): Array<keyof EvidenceComponents> {
  return (['status', 'tasks', 'notes', 'meetings', 'contacts'] as const).filter(key => prior[key] !== current[key]);
}
