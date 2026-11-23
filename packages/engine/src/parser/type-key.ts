/**
 * The frontmatter key that holds a note's types (#445).
 *
 * Chosen at install and read once at Engine start from `VAULT_TYPE_KEY` (default
 * `types`). Every note Engine parses reads its types from this key, and every note it
 * renders writes them under it, first. It is bootstrap configuration, not a setting:
 * changing it on a live vault would leave every note untyped, so Engine refuses to start
 * with a key other than the one its database was built with (`db/type-key.ts`).
 *
 * Only the on-disk key is designable. MCP parameters (`types`, `add_types`, ...), the
 * database's tables and every internal name stay `types`.
 */

import { DOMAINS, VAULT_ALIASES, descriptorsFor } from '@vault/settings-registry';

export const DEFAULT_TYPE_KEY = 'types';

/**
 * Frontmatter keys Engine writes in its own notes, besides the settings keys: a type key
 * named like one would read Engine's value as types and write the types over it.
 */
const ENGINE_NOTE_KEYS = new Set([
  // Settings/Models/ catalog notes
  'provider', 'model', 'enabled', 'vision', 'tools', 'context_length',
  'price_input', 'price_output', 'price_cache_read', 'price_cache_write',
  // Transcript notes (materialize-transcript)
  'source', 'captured_at', 'media_type', 'extractor_id', 'source_deleted', 'content_hash',
  // The memory note (Settings/Memories.md)
  'vault_engine_projection', 'memory_log_version', 'snapshot_at', 'live_count', 'historical_count',
  // Link resolution reads these as a note's other names
  'aliases', 'alias',
]);

/**
 * Whether `key` is one Engine itself writes in its notes: a setting in any settings note
 * (old names included), a key of its model, transcript or memory notes, or a wiki page's
 * `wiki_` field. Such a key cannot also hold note types.
 */
export function isEngineNoteKey(key: string): boolean {
  if (key.startsWith('wiki_') || ENGINE_NOTE_KEYS.has(key)) return true;
  if (VAULT_ALIASES.some(alias => alias.key === key)) return true;
  return DOMAINS.some(domain => descriptorsFor(domain).some(descriptor => descriptor.key === key));
}

let current = DEFAULT_TYPE_KEY;

/** The frontmatter key Engine reads and writes a note's types under. */
export function typeKey(): string {
  return current;
}

/** Set at Engine start, after the database check; tests restore the default after. */
export function setTypeKey(key: string): void {
  current = key;
}

export class TypeKeyError extends Error {
  override readonly name = 'TypeKeyError';
}

/**
 * The key `VAULT_TYPE_KEY` names: trimmed, `types` when unset or blank. A key with a
 * line break or other control character cannot be a frontmatter key, and one Engine
 * writes in its own notes cannot hold types.
 */
export function resolveTypeKey(raw: string | undefined): string {
  const key = raw?.trim() ?? '';
  if (key === '') return DEFAULT_TYPE_KEY;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeKeyError('VAULT_TYPE_KEY must be a frontmatter key on one line, without control characters');
  }
  if (isEngineNoteKey(key)) {
    throw new TypeKeyError(`VAULT_TYPE_KEY cannot be "${key}": Engine writes that key in its own notes, so it cannot also hold note types`);
  }
  return key;
}
