import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadNodeState } from '../../src/pipeline/node-state.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { ensureWikiSchema, upgradeWikiSchemaOnBoot } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { buildProjectEvidence, projectEvidenceHash, projectEvidenceHashBeforeTextHashes } from '../../src/wiki/evidence.js';
import { checkWikiStatuses, startWikiStatusChecks } from '../../src/wiki/status.js';
import { builtWikiStatus } from '../../src/wiki/reconcile-apply.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { getGlobalField } from '../../src/global-fields/crud.js';

// The Curator's default `meetingReads`, which its builds read evidence with.
const CURATOR_MEETING_READS = 10;

describe('wiki status check (#547)', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
    writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    for (const type of ['project', 'note', 'meeting', 'topic']) {
      db.prepare('INSERT INTO schemas (name, display_name, field_claims) VALUES (?, ?, \'[]\')').run(type, type);
    }
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    mkdirSync(join(vaultPath, 'Wikis'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function create(filePath: string, types: string[], fields: Record<string, unknown>, body: string): string {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: filePath,
      title: filePath.replace(/^.*\//u, '').replace(/\.md$/u, ''),
      types, fields, body,
    }).node_id;
  }

  function edit(nodeId: string, patch: { fields?: Record<string, unknown>; body?: string }): void {
    const state = loadNodeState(db, nodeId)!;
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: nodeId, file_path: state.file_path, title: state.title, types: state.types,
      fields: { ...state.currentFields, ...patch.fields }, body: patch.body ?? state.body,
      raw_field_texts: state.rawFieldTexts,
    });
  }

  /** A project with one note, and a home stamped as if a build had just read its evidence. */
  function builtWiki(status: string, root: { title?: string; types?: string[]; noteBody?: string } = {}) {
    const title = root.title ?? 'Alpha';
    const projectId = create(`${title}.md`, root.types ?? ['project'], {}, 'Project note.\n');
    const noteId = create(`Notes/${title} kickoff.md`, ['note'], {}, root.noteBody ?? `Kickoff for [[${title}]].\n`);
    const homeId = create(`Wikis/${title} Wiki.md`, ['wiki'], {
      wiki_for: title,
      wiki_evidence_hash: projectEvidenceHash(db, { project: projectId, meeting_recent_limit: CURATOR_MEETING_READS }),
      wiki_curated_at: '2026-11-15T12:00:00.000Z',
      wiki_status: status,
    }, 'Home prose.\n');
    return { projectId, noteId, homeId, homeFile: join(vaultPath, `Wikis/${title} Wiki.md`) };
  }

  function statusOf(homeId: string): unknown {
    return loadNodeState(db, homeId)!.currentFields.wiki_status;
  }

  const deps = () => ({ db, writeLock, vaultPath });

  it('computes the same evidence hash project-evidence returns', () => {
    const { projectId } = builtWiki('current');
    expect(projectEvidenceHash(db, { project: projectId, meeting_recent_limit: 7 }))
      .toBe(buildProjectEvidence(db, { project: projectId, meeting_recent_limit: 7 }).evidence_hash);
  });

  it('leaves a wiki whose evidence still matches its last build', () => {
    const { homeId } = builtWiki('current');
    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
  });

  function stampOf(homeId: string): unknown {
    return loadNodeState(db, homeId)!.currentFields.wiki_evidence_hash;
  }

  it('leaves a wiki current when a note only gains links around its words (#332)', () => {
    const { homeId, noteId } = builtWiki('current', { noteBody: 'Kickoff for [[Alpha]] with Dana Whitfield of Acme.\n' });
    edit(noteId, { body: 'Kickoff for [[Alpha]] with [[Dana Whitfield]] of [[Acme Inc|Acme]].\n' });

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
  });

  it('still writes behind when a link changes the words a note shows (#332)', () => {
    const { homeId, noteId } = builtWiki('current', { noteBody: 'Kickoff for [[Alpha]] with Acme.\n' });
    edit(noteId, { body: 'Kickoff for [[Alpha]] with [[Acme Inc]].\n' });

    checkWikiStatuses(deps());

    expect(statusOf(homeId)).toBe('behind');
  });

  it('stamps a wiki built before text hashes with the current formula, not behind (#332)', () => {
    const { homeId, projectId, noteId } = builtWiki('current', { noteBody: 'Kickoff for [[Alpha]] with Dana Whitfield.\n' });
    const options = { project: projectId, meeting_recent_limit: CURATOR_MEETING_READS };
    const before = projectEvidenceHashBeforeTextHashes(db, options);
    edit(homeId, { fields: { wiki_evidence_hash: before } });
    expect(before).not.toBe(projectEvidenceHash(db, options));

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
    expect(stampOf(homeId)).toBe(projectEvidenceHash(db, options));

    // From then on a link added to the note leaves it current.
    edit(noteId, { body: 'Kickoff for [[Alpha]] with [[Dana Whitfield]].\n' });
    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
  });

  it('writes behind to a wiki stamped before text hashes whose notes changed since (#332)', () => {
    const { homeId, projectId, noteId } = builtWiki('paused');
    const before = projectEvidenceHashBeforeTextHashes(db, { project: projectId, meeting_recent_limit: CURATOR_MEETING_READS });
    edit(homeId, { fields: { wiki_evidence_hash: before } });
    edit(noteId, { body: 'Kickoff for [[Alpha]]. The date moved.\n' });

    checkWikiStatuses(deps());

    expect(statusOf(homeId)).toBe('paused-behind');
    expect(stampOf(homeId)).toBe(before);
  });

  it('writes behind to the home, and to its file, once a note changes', () => {
    const { homeId, noteId, homeFile } = builtWiki('current');
    edit(noteId, { body: 'Kickoff for [[Alpha]]. The date moved.\n' });

    const changes = checkWikiStatuses(deps());

    expect(changes).toEqual([expect.objectContaining({ home_id: homeId, from: 'current', to: 'behind' })]);
    expect(statusOf(homeId)).toBe('behind');
    expect(readFileSync(homeFile, 'utf-8')).toMatch(/^wiki_status: behind$/mu);
    expect(checkWikiStatuses(deps())).toEqual([]);
  });

  it('writes paused-behind to a paused wiki', () => {
    const { homeId, noteId } = builtWiki('paused');
    edit(noteId, { body: 'Kickoff for [[Alpha]]. Moved.\n' });

    checkWikiStatuses(deps());

    expect(statusOf(homeId)).toBe('paused-behind');
  });

  it.each(['behind', 'paused-behind', 'building', 'failed'])('leaves a %s wiki to the Curator', (status) => {
    const { homeId, noteId } = builtWiki(status);
    edit(noteId, { body: 'Kickoff for [[Alpha]]. Moved.\n' });

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe(status);
  });

  it('keeps behind after the change is undone, until the next build', () => {
    const { homeId, noteId } = builtWiki('current');
    edit(noteId, { body: 'Kickoff for [[Alpha]]. Moved.\n' });
    checkWikiStatuses(deps());
    edit(noteId, { body: 'Kickoff for [[Alpha]].\n' });

    checkWikiStatuses(deps());

    expect(statusOf(homeId)).toBe('behind');
  });

  it('does not check a topic wiki', () => {
    const { homeId } = builtWiki('current', { title: 'Gardening', types: ['topic'] });
    edit(homeId, { fields: { wiki_evidence_hash: 'a-topic-synthesis-hash' } });

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
  });

  it('compares with the evidence read at the Curator\'s meetingReads', () => {
    setStoredSettings(db, 'curator', { meetingReads: 2 });
    const projectId = create('Alpha.md', ['project'], {}, 'Project note.\n');
    for (const day of ['01', '02', '03', '04']) {
      create(`Meetings/Sync 2026-10-${day}.md`, ['meeting'], { date: `2026-10-${day}` }, 'Sync on [[Alpha]].\n');
    }
    const homeId = create('Wikis/Alpha Wiki.md', ['wiki'], {
      wiki_for: 'Alpha',
      wiki_evidence_hash: projectEvidenceHash(db, { project: projectId, meeting_recent_limit: 2 }),
      wiki_status: 'current',
    }, 'Home prose.\n');
    expect(projectEvidenceHash(db, { project: projectId, meeting_recent_limit: 12 }))
      .not.toBe(projectEvidenceHash(db, { project: projectId, meeting_recent_limit: 2 }));

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(statusOf(homeId)).toBe('current');
  });

  it('never overwrites an edit the watcher has not read yet', () => {
    const { homeId, noteId, homeFile } = builtWiki('current');
    edit(noteId, { body: 'Kickoff for [[Alpha]]. Moved.\n' });
    const handEdited = readFileSync(homeFile, 'utf-8').replace('Home prose.', 'Home prose, typed in Obsidian.');
    writeFileSync(homeFile, handEdited, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(checkWikiStatuses(deps())).toEqual([]);
    expect(readFileSync(homeFile, 'utf-8')).toBe(handEdited);
    warn.mockRestore();

    processFileChange(homeFile, 'Wikis/Alpha Wiki.md', db, writeLock, vaultPath);
    checkWikiStatuses(deps());

    expect(statusOf(homeId)).toBe('behind');
    expect(readFileSync(homeFile, 'utf-8')).toContain('typed in Obsidian');
  });

  it('checks again only after something in the vault changes', () => {
    const { homeId, noteId } = builtWiki('current');
    const log = vi.fn();
    const checks = startWikiStatusChecks(deps(), { everyMs: 60_000, log });
    try {
      expect(checks.tick()).toEqual([]);
      edit(noteId, { body: 'Kickoff for [[Alpha]]. Moved.\n' });
      expect(checks.tick()).toEqual([expect.objectContaining({ home_id: homeId, to: 'behind' })]);
      expect(checks.tick()).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      checks.stop();
    }
  });
});

describe('wiki status on build (#547)', () => {
  it('stamps what the Curator asks for', () => {
    expect(builtWikiStatus('paused', 'current')).toBe('paused');
    expect(builtWikiStatus('current', 'paused')).toBe('current');
  });

  it('keeps a paused wiki paused and makes any other current when not told', () => {
    expect(builtWikiStatus(undefined, 'paused')).toBe('paused');
    expect(builtWikiStatus(undefined, 'paused-behind')).toBe('paused');
    for (const stored of ['current', 'behind', 'building', 'failed', undefined]) {
      expect(builtWikiStatus(undefined, stored)).toBe('current');
    }
  });
});

describe('wiki schema upgrade at boot (#547)', () => {
  it('claims wiki_status on an existing wiki schema without touching a file', () => {
    const db = createTestDb();
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    db.prepare("DELETE FROM schema_field_claims WHERE schema_name = 'wiki' AND field = 'wiki_status'").run();
    db.prepare("DELETE FROM global_fields WHERE name = 'wiki_status'").run();

    const added = upgradeWikiSchemaOnBoot(db);

    expect(added?.created_global_fields).toEqual(['wiki_status']);
    expect(added?.added_schema_claims).toEqual(['wiki_status']);
    expect(getGlobalField(db, 'wiki_status')?.enum_values).toEqual(
      ['current', 'behind', 'paused', 'paused-behind', 'building', 'failed'],
    );
    expect(upgradeWikiSchemaOnBoot(db)).toBeNull();
    db.close();
  });

  it('creates no wiki schema in a vault that has none', () => {
    const db = createTestDb();
    expect(upgradeWikiSchemaOnBoot(db)).toBeNull();
    expect(db.prepare("SELECT 1 FROM schemas WHERE name = 'wiki'").get()).toBeUndefined();
    db.close();
  });
});
