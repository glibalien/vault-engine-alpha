// src/mcp/tools/resolve-identity.ts
//
// Shared node identity resolution for all mutation tools.

import type Database from 'better-sqlite3';
import { resolveTarget } from '../../resolver/resolve.js';
import { LinkCanonicalizer } from '../../resolver/file-link.js';
import type { ErrorCode } from './errors.js';
import { memoryNotePathOrNull, settingsNoteDomain } from '../../settings/hook.js';
import { sameVaultFile } from '../../pipeline/safe-path.js';
import { chatClientEditor, type ToolCaller } from '../../auth/client-label.js';

export interface ResolvedNode {
  node_id: string;
  file_path: string;
  title: string;
}

export type ResolveResult =
  | { ok: true; node: ResolvedNode }
  | { ok: false; code: ErrorCode; message: string };

/**
 * The error for a node lookup given no identifier or more than one, naming what it received, or
 * null when exactly one of node_id, file_path or title is given.
 */
export function nodeIdentityParamsError(params: { node_id?: string; file_path?: string; title?: string }): string | null {
  const given = (['node_id', 'file_path', 'title'] as const).filter(key => params[key] !== undefined);
  if (given.length === 1) return null;
  const got = given.length === 0 ? 'none' : `${given.slice(0, -1).join(', ')} and ${given[given.length - 1]}`;
  return `Exactly one of node_id, file_path, or title is required; got ${got}`;
}

/**
 * Resolve a node from exactly one of: node_id, file_path, or title.
 * Returns the node's identity or an error result.
 */
export function resolveNodeIdentity(
  db: Database.Database,
  params: { node_id?: string; file_path?: string; title?: string },
): ResolveResult {
  const { node_id, file_path, title } = params;

  const identityError = nodeIdentityParamsError(params);
  if (identityError) return { ok: false, code: 'INVALID_PARAMS', message: identityError };

  type NodeRow = { id: string; file_path: string; title: string | null };
  let row: NodeRow | undefined;

  if (node_id) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(node_id) as NodeRow | undefined;
  } else if (file_path) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE file_path = ?').get(file_path) as NodeRow | undefined;
  } else if (title) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE title = ?').get(title) as NodeRow | undefined;
    if (!row) {
      const resolved = resolveTarget(db, title);
      if (resolved) {
        row = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(resolved.id) as NodeRow | undefined;
      }
    }
    if (!row) {
      // The title as requested rather than as stored: a stored title is the
      // filename's, so `A: B` was created as `A- B`. Unique matches only, and
      // never through an alias — a lookup names the note itself.
      row = new LinkCanonicalizer(db, { aliases: false }).match(title) ?? undefined;
    }
  }

  if (!row) {
    return { ok: false, code: 'NOT_FOUND', message: 'Node not found' };
  }

  return {
    ok: true,
    node: {
      node_id: row.id,
      file_path: row.file_path,
      title: row.title ?? row.file_path,
    },
  };
}

/**
 * Why a generic node edit may not touch `filePath`, or null when it may. A
 * domain settings note changes only through update-settings, which validates
 * the values and updates the effective settings the note renders.
 */
export function settingsNoteEditRefusal(filePath: string): string | null {
  const domain = settingsNoteDomain(filePath);
  if (domain === null) return null;
  return `"${filePath}" is the ${domain} settings note. Change it with update-settings (domain: "${domain}"); node edits would not change the effective settings.`;
}

/**
 * Why this caller may not write `filePath` as a node, or null when it may. An edit to the
 * memory note is read as the owner's own, so a signed-in chat client changes memories
 * through the memory tools, which record the client on what it writes (#532). The suite's
 * own callers (a service token, or no auth) are not refused.
 *
 * `filePath` is compared by where it lands, not by its text (`sameVaultFile`): a caller
 * chooses the folder and the title, so `Settings/./Memories.md` must not pass.
 */
export function memoryNoteEditRefusal(vaultPath: string, filePath: string, caller: ToolCaller | string | undefined): string | null {
  if (chatClientEditor(caller) === undefined) return null;
  const memoryNote = memoryNotePathOrNull();
  if (memoryNote === null || !sameVaultFile(vaultPath, filePath, memoryNote)) return null;
  return `"${filePath}" is the memory note, where an edit is read as the owner's own. Change memories with create-memory, update-memory and expire-memory.`;
}
