// src/field-guess/file-held.ts
//
// What a note's file holds for a field that the database does not (#644).
//
// A value typed into a note that fails its field's type ("TBD" in a date field) is not stored:
// the watcher logs `value-rejected`, the database keeps no value, and the file keeps what was
// typed (#501). To the database such a field is simply empty. An on-demand field-filling run
// must not take it for empty: filling it would replace the typed text, and undo could not put
// that text back, because no snapshot ever held it. So for a requested run the listing and the
// write guard read the file as well, and treat typed text the database does not hold as the
// field's value: one that fails its type, replaced only by a run that asks to.

import { readFileOrNull } from '../pipeline/file-writer.js';
import { readFileFields } from '../pipeline/kept-file-fields.js';
import { safeVaultPath } from '../pipeline/safe-path.js';

/** No value to speak of: nothing, blank text, or an empty list. */
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

/**
 * For each of `fields` the database holds no value to speak of (`holdsValue` says which it does),
 * the value the note's file holds, as the watcher would read it. Empty when the file cannot be
 * read, has no frontmatter, or holds nothing for them. An empty value in the file is not typed
 * text.
 *
 * "No value to speak of" includes an empty stored value: when someone types text the watcher
 * refuses into a field that held an empty list or an empty key, the watcher keeps that empty
 * value, and the file holds the text. So a caller must pass `holdsValue` false for a blank stored
 * value, and let what this returns stand in place of it.
 */
export function fileHeldValues(
  vaultPath: string,
  filePath: string,
  fields: Iterable<string>,
  holdsValue: (field: string) => boolean,
): Map<string, unknown> {
  const held = new Map<string, unknown>();
  const wanted = new Set<string>();
  for (const field of fields) if (!holdsValue(field)) wanted.add(field);
  if (wanted.size === 0) return held;
  let content: string | null;
  try {
    content = readFileOrNull(safeVaultPath(vaultPath, filePath));
  } catch {
    return held;
  }
  for (const field of readFileFields(content)) {
    if (wanted.has(field.name) && !isBlank(field.value)) held.set(field.name, field.value);
  }
  return held;
}

const HELD_TEXT_MAX_CHARS = 200;

/** A held value as short text, for showing what a replacement would replace. */
export function heldValueText(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > HELD_TEXT_MAX_CHARS ? `${text.slice(0, HELD_TEXT_MAX_CHARS - 1)}…` : text;
}
