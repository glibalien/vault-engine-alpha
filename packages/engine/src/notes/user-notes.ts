import type { VaultSettings } from '@vault/settings-registry';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { notSuiteNoteSql } from './suite-notes.js';

/**
 * Conditions on `nodes n` for the user's own notes: not one of the suite's notes (the memory
 * note, the Curator Journal), not in the settings folder, and not a wiki page. The suite writes
 * those itself, so a gap in one is not the user's to fix, and a copy of one is not a duplicate.
 * The clean-up report (#643) and the duplicate finder (#646) both count these notes.
 */
export function userNotesWhere(context: { vault: VaultSettings; settingsDir: string | undefined }): { sql: string; params: string[] } {
  const where = [notSuiteNoteSql('n')];
  const params: string[] = [];
  if (context.settingsDir) {
    where.push(`n.file_path NOT LIKE ? ${LIKE_ESCAPE}`);
    params.push(literalPrefixPattern(`${context.settingsDir}/`));
  }
  if (context.vault.wikiType !== null) {
    where.push('NOT EXISTS (SELECT 1 FROM node_types wiki WHERE wiki.node_id = n.id AND wiki.schema_type = ?)');
    params.push(context.vault.wikiType);
  }
  return { sql: where.join(' AND '), params };
}
