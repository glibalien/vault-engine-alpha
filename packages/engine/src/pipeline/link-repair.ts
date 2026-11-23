// src/pipeline/link-repair.ts
//
// Startup repair for link damage already in the vault — the two classes
// vault-doctor reports as `links_unresolvable_by_filename` and
// `unresolved_near_miss`. New writes no longer produce either (the pipeline
// keeps titles equal to filenames and canonicalizes links on tool writes);
// this sweep corrects what earlier writes left behind, and anything a watcher
// edit introduces between restarts. Idempotent: a clean vault costs the two
// doctor scans and one pass over node titles.
//
// The Engine setting `linkRepair` chooses whether startup runs it (on), only
// reports what it would rewrite (report), or skips it (off) (#447).

import type Database from 'better-sqlite3';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { findFilenameUnresolvableLinks, LinkCanonicalizer, linksBoundThroughTitle } from '../resolver/file-link.js';
import { findNearMissTargets } from '../resolver/near-miss.js';
import { titleFromFilename } from '../parser/parse.js';
import { executeMutation, resaveWithCanonicalLinks, wouldResaveWithCanonicalLinks } from './execute.js';
import { loadNodeState } from './node-state.js';

export interface LinkRepairStats {
  /** Notes whose link text was rewritten to name the file. */
  notes_rewritten: number;
  /** Nodes whose stored title was reset to their filename. */
  titles_normalized: number;
  /** Drifted titles kept because a link whose note could not be re-saved is
   * still bound through them; retried on the next startup. */
  titles_kept: number;
}

export type LinkRepairMode = 'on' | 'report' | 'off';

/** What a repair would change, found without writing anything. */
export interface LinkRepairPreview {
  /** Notes a repair would re-save, each with the link text that puts it in the pass. */
  notes: Array<{ file_path: string; links: string[] }>;
  /** Stored titles that differ from their filenames. A repair resets them in
   * the database only, keeping any a link it could not rewrite still needs. */
  titles_drifted: number;
}

export function repairVaultLinks(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
): LinkRepairStats {
  // 1. Rewrite the links first, while titles that drifted from their filenames
  //    still identify the note those links mean.
  // One catalog for the whole pass: a re-save resets its own drifted title,
  // and a later note linking to that title must still find it.
  const canonicalizer = new LinkCanonicalizer(db);
  let notesRewritten = 0;
  for (const id of repairSources(db).keys()) {
    if (resaveWithCanonicalLinks(db, writeLock, vaultPath, id, syncLogger, undefined, undefined, canonicalizer)) notesRewritten++;
  }

  // 2. Then reset the remaining drifted titles — except one a link is still
  //    bound through because its note could not be re-saved: resetting would
  //    strand that binding with nothing left to identify its note. The file
  //    content does not change, so this is DB-only; the stored content hash
  //    stays as it was.
  const drifted = driftedTitles(db);
  let titlesNormalized = 0;
  let titlesKept = 0;
  for (const node of drifted) {
    if (node.title !== null && linksBoundThroughTitle(db, node.id, node.title, node.file_path)) {
      titlesKept++;
      continue;
    }
    const state = loadNodeState(db, node.id);
    if (!state) continue;
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'propagation',
        node_id: node.id,
        file_path: state.file_path,
        title: titleFromFilename(state.file_path),
        types: state.types,
        fields: state.currentFields,
        body: state.body,
        raw_field_texts: state.rawFieldTexts,
        db_only: true,
        ...(node.content_hash !== null ? { source_content_hash: node.content_hash } : {}),
      }, syncLogger);
      titlesNormalized++;
    } catch (err) {
      console.warn(`[links] could not reset the title of ${node.file_path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { notes_rewritten: notesRewritten, titles_normalized: titlesNormalized, titles_kept: titlesKept };
}

/**
 * What `repairVaultLinks` would do, without writing a file or a row: each note
 * whose re-save would change it (a preview of that re-save through the
 * pipeline), and how many stored titles have drifted from their filenames.
 */
export function previewVaultLinkRepair(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): LinkRepairPreview {
  const canonicalizer = new LinkCanonicalizer(db);
  const pathOf = db.prepare('SELECT file_path FROM nodes WHERE id = ?');
  const notes: LinkRepairPreview['notes'] = [];
  for (const [id, links] of repairSources(db)) {
    if (!wouldResaveWithCanonicalLinks(db, writeLock, vaultPath, id, canonicalizer)) continue;
    const row = pathOf.get(id) as { file_path: string } | undefined;
    if (row) notes.push({ file_path: row.file_path, links: [...links].sort() });
  }
  notes.sort((a, b) => (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0));
  return { notes, titles_drifted: driftedTitles(db).length };
}

/**
 * The startup step, as the Engine setting `linkRepair` chooses: repair (on),
 * log what a repair would change without writing (report), or nothing (off).
 */
export function runStartupLinkRepair(
  mode: LinkRepairMode,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  log: (line: string) => void = console.log,
): void {
  if (mode === 'off') return;
  if (mode === 'report') {
    for (const line of describeLinkRepairPreview(previewVaultLinkRepair(db, writeLock, vaultPath))) log(line);
    return;
  }
  const stats = repairVaultLinks(db, writeLock, vaultPath, syncLogger);
  if (stats.notes_rewritten > 0 || stats.titles_normalized > 0 || stats.titles_kept > 0) {
    log(`Link repair: ${stats.notes_rewritten} notes rewritten, ${stats.titles_normalized} titles reset to their filenames, ${stats.titles_kept} kept for links not yet rewritten.`);
  }
}

/** Log lines for a report-only run; none when there is nothing to repair. */
export function describeLinkRepairPreview(preview: LinkRepairPreview, limit = 50): string[] {
  const lines: string[] = [];
  const { notes } = preview;
  if (notes.length > 0) {
    lines.push(`Link repair (report only; Engine setting linkRepair): ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} would be re-saved with links that name their file. Nothing was written.`);
    for (const note of notes.slice(0, limit)) {
      lines.push(`  ${note.file_path}: ${note.links.map(link => `[[${link}]]`).join(', ')}`);
    }
    if (notes.length > limit) lines.push(`  ...and ${notes.length - limit} more; vault-doctor lists the links.`);
  }
  const titles = preview.titles_drifted;
  if (titles > 0) {
    lines.push(`Link repair (report only): ${titles} stored ${titles === 1 ? 'title differs from its filename' : 'titles differ from their filenames'}; a repair would reset ${titles === 1 ? 'it' : 'them'} in the database (no file changes).`);
  }
  return lines;
}

/** Notes holding a link the repair rewrites, each with that link text, in pass order. */
function repairSources(db: Database.Database): Map<string, Set<string>> {
  const sources = new Map<string, Set<string>>();
  const add = (id: string, target: string) => {
    const links = sources.get(id);
    if (links) links.add(target);
    else sources.set(id, new Set([target]));
  };
  for (const group of findFilenameUnresolvableLinks(db)) {
    for (const id of group.source_ids) add(id, group.target);
  }
  const unresolvedSources = db.prepare(
    'SELECT DISTINCT source_id FROM relationships WHERE resolved_target_id IS NULL AND target = ?',
  );
  for (const group of findNearMissTargets(db)) {
    for (const row of unresolvedSources.all(group.target) as Array<{ source_id: string }>) add(row.source_id, group.target);
  }
  return sources;
}

function driftedTitles(db: Database.Database): Array<{
  id: string; file_path: string; title: string | null; content_hash: string | null;
}> {
  return (db.prepare('SELECT id, file_path, title, content_hash FROM nodes').all() as Array<{
    id: string; file_path: string; title: string | null; content_hash: string | null;
  }>).filter(node => node.title !== titleFromFilename(node.file_path));
}
