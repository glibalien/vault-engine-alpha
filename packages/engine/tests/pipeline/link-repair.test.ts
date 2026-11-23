import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { repairVaultLinks, runStartupLinkRepair } from '../../src/pipeline/link-repair.js';
import { findFilenameUnresolvableLinks } from '../../src/resolver/file-link.js';
import { findNearMissTargets } from '../../src/resolver/near-miss.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

let db: Database.Database;
let vault: string;
let lock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  vault = mkdtempSync(join(tmpdir(), 'link-repair-'));
  lock = new WriteLockManager();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

// Legacy state is seeded through the watcher path: tool writes can no longer
// store a drifted title or an engine-only link.
function seed(file_path: string, title: string, body = '') {
  return executeMutation(db, lock, vault, {
    source: 'watcher', node_id: null, file_path, title, types: [], fields: {}, body,
  } satisfies ProposedMutation).node_id;
}
const node = (id: string) => db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(id) as { title: string; body: string };

describe('repairVaultLinks', () => {
  it('rewrites engine-only and near-miss links, then resets drifted titles', () => {
    const drifted = seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    const plain = seed('Tasks/Ping Tomas on vendor-onboarding status.md', 'Ping Tomas on vendor-onboarding status');
    const byTitle = seed('Notes/Daily 1.md', 'Daily 1', 'Did [[Site audit: link checker]].');
    const nearMiss = seed('Notes/Daily 2.md', 'Daily 2', 'Follow [[Ping Tomas on vendor/onboarding status]].');
    expect(findFilenameUnresolvableLinks(db)).toHaveLength(1);
    expect(findNearMissTargets(db)).toHaveLength(1);

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 2, titles_normalized: 1, titles_kept: 0 });

    expect(node(byTitle).body).toBe('Did [[Site audit- link checker|Site audit: link checker]].');
    expect(readFileSync(join(vault, 'Notes/Daily 1.md'), 'utf8')).toContain('[[Site audit- link checker|Site audit: link checker]]');
    expect(node(nearMiss).body).toBe('Follow [[Ping Tomas on vendor-onboarding status|Ping Tomas on vendor/onboarding status]].');
    expect(node(drifted).title).toBe('Site audit- link checker');
    expect(node(plain).title).toBe('Ping Tomas on vendor-onboarding status');
    expect(findFilenameUnresolvableLinks(db)).toEqual([]);
    expect(findNearMissTargets(db)).toEqual([]);
    const unresolved = db.prepare('SELECT COUNT(*) AS c FROM relationships WHERE resolved_target_id IS NULL').get() as { c: number };
    expect(unresolved.c).toBe(0);
  });

  it('keeps a reset title identifying its note for the rest of the pass', () => {
    seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    // Drift no near-miss key recovers (a template-style filename); its own
    // repairable link puts it first in the pass, ahead of the note linking to it.
    const b = seed('Notes/2026-01-01-B.md', 'B', 'Did [[Site audit: link checker]].');
    seed('Notes/Other.md', 'Other', 'Also [[Site audit: link checker]].');
    const linker = seed('Notes/Linker.md', 'Linker', 'See [[B]].');

    repairVaultLinks(db, lock, vault);

    expect(node(b).title).toBe('2026-01-01-B');
    expect(node(linker).body).toBe('See [[2026-01-01-B|B]].');
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(linker)).toEqual({ resolved_target_id: b });
  });

  it('keeps a drifted title while a link it could not rewrite still needs it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = seed('Notes/2026-01-01-B.md', 'B');
    const linker = seed('Notes/Linker.md', 'Linker', 'See [[B]].');
    // An edit the watcher has not indexed yet: the re-save must skip this file.
    writeFileSync(join(vault, 'Notes/Linker.md'), 'See [[B]] — edited.\n');

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 0, titles_normalized: 0, titles_kept: 1 });
    expect(node(b).title).toBe('B');
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(linker)).toEqual({ resolved_target_id: b });
  });

  it('rewrites a title-bound link an alias spells, then resets the title (#211)', () => {
    // Obsidian resolves no bare [[alias]], so the alias never kept this link
    // working anywhere but the engine's title tier.
    const b = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Notes/2026-01-01-B.md', title: 'B', types: [],
      fields: { aliases: ['B'] }, body: '',
    }).node_id;
    const linker = seed('Notes/Linker.md', 'Linker', 'See [[B]].');

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 1, titles_normalized: 1, titles_kept: 0 });
    expect(node(b).title).toBe('2026-01-01-B');
    expect(node(linker).body).toBe('See [[2026-01-01-B|B]].');
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(linker)).toEqual({ resolved_target_id: b });
  });

  it('rewrites a bare alias link to name the file', () => {
    const ada = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Persons/Ada Lovelace.md', title: 'Ada Lovelace', types: [],
      fields: { aliases: ['Ada L.'] }, body: '',
    }).node_id;
    const linker = seed('Notes/Linker.md', 'Linker', 'Met [[Ada L.]] and [[ada l.|her]].');
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').all(linker))
      .toEqual([{ resolved_target_id: null }, { resolved_target_id: null }]);

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 1, titles_normalized: 0, titles_kept: 0 });
    expect(node(linker).body).toBe('Met [[Ada Lovelace|Ada L.]] and [[Ada Lovelace|her]].');
    expect(readFileSync(join(vault, 'Notes/Linker.md'), 'utf8')).toContain('[[Ada Lovelace|Ada L.]]');
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(linker)).toEqual({ resolved_target_id: ada });
    expect(findNearMissTargets(db)).toEqual([]);
  });

  it('rewrites a bare alias beside a bracketed email address', () => {
    // remark-gfm builds the text around `[[jo@example.com]]` without positions.
    executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Persons/Grace Hopper.md', title: 'Grace Hopper', types: [],
      fields: { aliases: ['grace'] }, body: '',
    });
    const linker = seed('Notes/Linker.md', 'Linker', '- **Jo** ([[jo@example.com]]) sent it to you, [[Grace]], and [[rj@example.com]].');

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 1, titles_normalized: 0, titles_kept: 0 });
    expect(node(linker).body).toBe('- **Jo** ([[jo@example.com]]) sent it to you, [[Grace Hopper|Grace]], and [[rj@example.com]].');
    expect(findNearMissTargets(db)).toEqual([]);
  });

  it('leaves an attachment embed an alias spells alone', () => {
    executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Notes/Summary.md', title: 'Summary', types: [],
      fields: { aliases: ['report.pdf'] }, body: '',
    });
    writeFileSync(join(vault, 'report.pdf'), 'pdf');
    const linker = seed('Notes/Linker.md', 'Linker', 'Read ![[report.pdf]].');

    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 0, titles_normalized: 0, titles_kept: 0 });
    expect(node(linker).body).toBe('Read ![[report.pdf]].');
  });

  it('rewrites a legacy link held in an unclaimed frontmatter field', () => {
    const target = seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    const source = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Notes/Source.md', title: 'Source', types: [],
      fields: { related: 'Site audit: link checker' }, body: '',
      raw_field_texts: { related: '[[Site audit: link checker]]' },
    }).node_id;

    repairVaultLinks(db, lock, vault);

    expect(readFileSync(join(vault, 'Notes/Source.md'), 'utf8')).toContain('related: "[[Site audit- link checker]]"');
    expect(db.prepare("SELECT value_text, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'related'").get(source))
      .toEqual({ value_text: 'Site audit- link checker', value_raw_text: '[[Site audit- link checker]]' });
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(source)).toEqual({ resolved_target_id: target });
  });

  it('rewrites the retained raw text of an unclaimed typed reference field (policy v2)', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
    createSchemaDefinition(db, { name: 'project', field_claims: [] });
    const target = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Projects/2026-01-01-Quarter Plan.md', title: 'Quarter Plan',
      types: ['project'], fields: {}, body: '',
    }).node_id;
    const source = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Notes/Source.md', title: 'Source', types: [],
      fields: { project: 'Quarter Plan' }, raw_field_texts: { project: '[[Quarter Plan]]' }, body: '',
    }).node_id;

    repairVaultLinks(db, lock, vault);

    expect(readFileSync(join(vault, 'Notes/Source.md'), 'utf8')).toContain('project: "[[2026-01-01-Quarter Plan]]"');
    expect(db.prepare("SELECT value_text, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(source))
      .toEqual({ value_text: '2026-01-01-Quarter Plan', value_raw_text: '[[2026-01-01-Quarter Plan]]' });
    expect(db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ?').get(source)).toEqual({ resolved_target_id: target });
  });

  it('writes a field from its value when its raw text is left from an earlier value (#668)', () => {
    seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    const source = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Notes/Source.md', title: 'Source', types: [],
      fields: { lead: 'Dana W' }, raw_field_texts: { lead: '[[Dana W]]' }, body: 'Did [[Site audit: link checker]].',
    }).node_id;
    // An older watcher path stored an edit's value beside the link it replaced.
    db.prepare("UPDATE node_fields SET value_text = 'Lee Okafor' WHERE node_id = ? AND field_name = 'lead'").run(source);

    expect(repairVaultLinks(db, lock, vault).notes_rewritten).toBe(1);

    const text = readFileSync(join(vault, 'Notes/Source.md'), 'utf8');
    expect(text).toContain('lead: Lee Okafor\n');
    expect(text).not.toContain('Dana W');
    expect(db.prepare("SELECT value_text, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = 'lead'").get(source))
      .toEqual({ value_text: 'Lee Okafor', value_raw_text: null });
  });

  it('is a no-op on a clean vault and on a second run', () => {
    seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    seed('Notes/Daily.md', 'Daily', 'Did [[Site audit: link checker]].');
    repairVaultLinks(db, lock, vault);
    expect(repairVaultLinks(db, lock, vault)).toEqual({ notes_rewritten: 0, titles_normalized: 0, titles_kept: 0 });
  });

  it('leaves engine-owned projections alone — their bytes are a render that is read back', () => {
    seed('Tasks/Q4- Pricing.md', 'Q4- Pricing');
    const projection = executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Settings/Memories.md', title: 'Memories', types: [],
      fields: { vault_engine_projection: 'memories' }, body: 'Remember [[Q4: Pricing]].',
    }).node_id;

    expect(repairVaultLinks(db, lock, vault).notes_rewritten).toBe(0);
    expect(node(projection).body).toBe('Remember [[Q4: Pricing]].');
  });

  it('skips a note whose file is gone and carries on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed('Tasks/Q4- Pricing.md', 'Q4- Pricing');
    const gone = seed('Notes/Gone.md', 'Gone', 'See [[Q4: Pricing]].');
    const kept = seed('Notes/Kept.md', 'Kept', 'See [[Q4: Pricing]].');
    unlinkSync(join(vault, 'Notes/Gone.md'));

    expect(repairVaultLinks(db, lock, vault).notes_rewritten).toBe(1);
    expect(node(gone).body).toBe('See [[Q4: Pricing]].');
    expect(node(kept).body).toBe('See [[Q4- Pricing|Q4: Pricing]].');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Notes/Gone.md'));
  });
});

// #447: the Engine setting linkRepair chooses on, report only, or off.
describe('runStartupLinkRepair', () => {
  const snapshot = () => ({
    rows: db.prepare('SELECT id, title, body, content_hash, version FROM nodes ORDER BY id').all(),
    relationships: db.prepare('SELECT source_id, target, resolved_target_id FROM relationships ORDER BY source_id, target').all(),
    files: ['Tasks/Site audit- link checker.md', 'Notes/Daily 1.md', 'Notes/Daily 2.md', 'Notes/Daily 3.md']
      .map(path => readFileSync(join(vault, path), 'utf8')),
  });
  function seedDamage() {
    seed('Tasks/Site audit- link checker.md', 'Site audit: link checker');
    seed('Tasks/Ping Tomas on vendor-onboarding status.md', 'Ping Tomas on vendor-onboarding status');
    seed('Notes/Daily 1.md', 'Daily 1', 'Did [[Site audit: link checker]] and [[Ping Tomas on vendor/onboarding status]].');
    seed('Notes/Daily 2.md', 'Daily 2', 'Follow [[Ping Tomas on vendor/onboarding status]].');
    seed('Notes/Daily 3.md', 'Daily 3', 'Nothing to repair here.');
  }

  it('report only says what a repair would rewrite and writes nothing', () => {
    seedDamage();
    const before = snapshot();
    const lines: string[] = [];

    runStartupLinkRepair('report', db, lock, vault, undefined, line => lines.push(line));

    expect(snapshot()).toEqual(before);
    expect(lines).toEqual([
      'Link repair (report only; Engine setting linkRepair): 2 notes would be re-saved with links that name their file. Nothing was written.',
      '  Notes/Daily 1.md: [[Ping Tomas on vendor/onboarding status]], [[Site audit: link checker]]',
      '  Notes/Daily 2.md: [[Ping Tomas on vendor/onboarding status]]',
      'Link repair (report only): 1 stored title differs from its filename; a repair would reset it in the database (no file changes).',
    ]);
  });

  it('report only leaves out notes a repair would skip', () => {
    seed('Tasks/Q4- Pricing.md', 'Q4- Pricing');
    seed('Notes/Gone.md', 'Gone', 'See [[Q4: Pricing]].');
    seed('Notes/Kept.md', 'Kept', 'See [[Q4: Pricing]].');
    executeMutation(db, lock, vault, {
      source: 'watcher', node_id: null, file_path: 'Settings/Memories.md', title: 'Memories', types: [],
      fields: { vault_engine_projection: 'memories' }, body: 'Remember [[Q4: Pricing]].',
    });
    unlinkSync(join(vault, 'Notes/Gone.md'));
    const lines: string[] = [];

    runStartupLinkRepair('report', db, lock, vault, undefined, line => lines.push(line));

    expect(lines).toEqual([
      'Link repair (report only; Engine setting linkRepair): 1 note would be re-saved with links that name their file. Nothing was written.',
      '  Notes/Kept.md: [[Q4: Pricing]]',
    ]);
  });

  it('report only is silent on a clean vault', () => {
    seed('Notes/Clean.md', 'Clean', 'Plain text.');
    const lines: string[] = [];
    runStartupLinkRepair('report', db, lock, vault, undefined, line => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('off leaves the vault alone and says nothing', () => {
    seedDamage();
    const before = snapshot();
    const lines: string[] = [];

    runStartupLinkRepair('off', db, lock, vault, undefined, line => lines.push(line));

    expect(snapshot()).toEqual(before);
    expect(lines).toEqual([]);
  });

  it('on repairs, as before', () => {
    seedDamage();
    const lines: string[] = [];

    runStartupLinkRepair('on', db, lock, vault, undefined, line => lines.push(line));

    expect(lines).toEqual(['Link repair: 2 notes rewritten, 1 titles reset to their filenames, 0 kept for links not yet rewritten.']);
    expect(readFileSync(join(vault, 'Notes/Daily 2.md'), 'utf8'))
      .toContain('[[Ping Tomas on vendor-onboarding status|Ping Tomas on vendor/onboarding status]]');
    expect(findFilenameUnresolvableLinks(db)).toEqual([]);
    expect(findNearMissTargets(db)).toEqual([]);
  });
});
