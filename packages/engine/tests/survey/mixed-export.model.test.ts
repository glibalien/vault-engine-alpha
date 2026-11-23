import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createSubprocessEmbedder } from '../../src/search/embedder-host.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import { surveyMembers, surveyNodes, type SurveyResult } from '../../src/survey/service.js';
import { APPS, KINDS, insertNotes, mixedExportNotes, type FixtureNote } from './mixed-export-fixture.js';

const configuredModelsDir = process.env.VAULT_ENGINE_MODELS_DIR?.trim();
if (!configuredModelsDir) {
  throw new Error('VAULT_ENGINE_MODELS_DIR is required for real-model tests; point it at the dedicated test cache');
}
const modelsDir = resolve(configuredModelsDir);
const workerPath = resolve(import.meta.dirname, '..', '..', 'dist', 'search', 'embedder-worker.js');
if (!existsSync(workerPath)) {
  throw new Error(`Compiled embedder worker not found: ${workerPath}; run npm run build -w vault-engine first`);
}

/** The fixture notes of each group, read back through the survey's own member listing. */
function membersByGroup(db: Database.Database, result: SurveyResult, notes: readonly FixtureNote[]): FixtureNote[][] {
  const byId = new Map(notes.map(note => [note.id, note]));
  return result.groups.map(group =>
    surveyMembers(db, { survey_id: result.survey_id, group: group.group }, { limit: 500 }).members.map(member => byId.get(member.id)!));
}

function largestShare<T>(members: readonly FixtureNote[], values: readonly T[], of: (note: FixtureNote) => T): { value: T; share: number } {
  const counted = values.map(value => ({ value, share: members.filter(note => of(note) === value).length / members.length }));
  return counted.sort((a, b) => b.share - a.share)[0]!;
}

describe('survey of a mixed export (real model)', () => {
  let embedder: ReturnType<typeof createSubprocessEmbedder> | null = null;
  let db: Database.Database | null = null;

  afterEach(async () => {
    try {
      if (embedder) await embedder.shutdown();
    } finally {
      embedder = null;
      db?.close();
      db = null;
    }
  });

  // Stored embeddings include each note's title and folder. Three apps' exports, each in its own
  // folder and style, hold the same five kinds of note: the groups must follow the kinds.
  it('groups the notes of three apps by kind, not by the folder each app exported to', async () => {
    db = createTestDb();
    const notes = mixedExportNotes(15);
    insertNotes(db, notes);
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const indexer = createEmbeddingIndexer(db, embedder);
    for (const note of notes) indexer.enqueue({ node_id: note.id, source_type: 'node' });
    await indexer.processAll();

    // Asked for as many groups as there are kinds: one group per kind, each drawing on every app.
    const five = surveyNodes(db, { max_groups: KINDS.length });
    expect(five.scope).toMatchObject({ notes: notes.length, surveyed: notes.length, not_indexed: 0 });
    const fiveGroups = membersByGroup(db, five, notes);
    expect(fiveGroups).toHaveLength(KINDS.length);
    const kinds = fiveGroups.map(members => largestShare(members, KINDS, note => note.kind));
    expect(new Set(kinds.map(kind => kind.value)).size).toBe(KINDS.length);
    for (const kind of kinds) expect(kind.share).toBeGreaterThanOrEqual(0.9);
    for (const members of fiveGroups) {
      expect(largestShare(members, APPS, note => note.app).share).toBeLessThanOrEqual(0.6);
      expect(new Set(members.map(note => note.app)).size).toBe(APPS.length);
    }

    // What the notes share survives three ways of writing a labelled line.
    const meetings = five.groups[kinds.findIndex(kind => kind.value === 'meeting')]!;
    expect(meetings.shared.label_lines.map(label => label.name)).toEqual(expect.arrayContaining(['Attendees', 'Date']));
    expect(meetings.shared.folders.map(folder => folder.name).sort()).toEqual([...APPS].sort());

    // Asked for more groups than kinds, a kind is split, but no group mixes kinds.
    const twelve = surveyNodes(db, {});
    const twelveGroups = membersByGroup(db, twelve, notes);
    expect(twelveGroups.length).toBeGreaterThan(KINDS.length);
    for (const members of twelveGroups) expect(largestShare(members, KINDS, note => note.kind).share).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
