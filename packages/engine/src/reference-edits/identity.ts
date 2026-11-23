import { basename } from 'node:path';
import { candidateKeysForNode } from '../resolver/candidate-keys.js';
import { REFERENCE_EDIT_LIMITS, ReferenceEditError, type IdentityIndex, type IdentityRow } from './types.js';

const stripMd = (s: string) => s.endsWith('.md') ? s.slice(0, -3) : s;
const fold = (s: string) => s.normalize('NFC').trim().toLowerCase();

/** Transaction-local catalog. Preserve the resolver's tiers, but never choose an ambiguous winner. */
export function buildIdentityIndex(rows: Iterable<IdentityRow>): IdentityIndex {
  const tiers = Array.from({ length: 5 }, () => new Map<string, IdentityRow[]>());
  const filenames = new Map<string, IdentityRow[]>();
  const ids = new Map<string, IdentityRow>();
  const insert = (map: Map<string, IdentityRow[]>, key: string, row: IdentityRow) => {
    const values = map.get(key);
    if (values) values.push(row); else map.set(key, [row]);
  };
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    count++;
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (count > REFERENCE_EDIT_LIMITS.catalogNodes || bytes > REFERENCE_EDIT_LIMITS.catalogBytes) {
      throw new ReferenceEditError('NOT_ELIGIBLE', 'Identity catalog exceeds the member-edit limit', { reason: 'catalog_limit' });
    }
    ids.set(row.id, row);
    const keys = candidateKeysForNode(row);
    [keys.file_path, keys.title, keys.basename, keys.basenameLower, keys.basenameNfcLower].forEach((key, i) => {
      if (key !== null) insert(tiers[i], key, row);
    });
    for (const key of new Set([fold(stripMd(row.file_path)), fold(basename(row.file_path, '.md'))])) insert(filenames, key, row);
  }
  const candidates = (value: string): readonly IdentityRow[] => {
    const base = stripMd(value);
    const keys = [value, value, base, base.toLowerCase(), base.normalize('NFC').toLowerCase()];
    for (let i = 0; i < tiers.length; i++) {
      const found = tiers[i].get(keys[i]);
      if (found?.length) return found;
    }
    return [];
  };
  return {
    candidates,
    additionTitle(targetId) {
      const row = ids.get(targetId);
      if (!row) throw new ReferenceEditError('NOT_FOUND', 'Reference target not found', { reason: 'target_missing' });
      const title = row.title;
      if (!title || title.trim() !== title || /[\[\]|#^\u0000-\u001f\u007f-\u009f]/u.test(title)) {
        throw new ReferenceEditError('NOT_ELIGIBLE', 'Target title cannot be stored as a safe reference', { reason: 'unsafe_title' });
      }
      const engine = candidates(title);
      const filename = filenames.get(fold(stripMd(title))) ?? [];
      if (engine.length > 1 || filename.length > 1) {
        throw new ReferenceEditError('AMBIGUOUS_MATCH', 'Target title is ambiguous', { reason: 'ambiguous_title' });
      }
      if (engine[0]?.id !== targetId || filename[0]?.id !== targetId) {
        throw new ReferenceEditError('NOT_ELIGIBLE', 'Target title does not uniquely resolve by filename', { reason: 'filename_mismatch' });
      }
      return title;
    },
  };
}
