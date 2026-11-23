// src/pipeline/carried-raw-text.ts
//
// The link text an unclaimed field keeps across a write (#663).
//
// An unclaimed field that holds links is stored twice: its value, with every link reduced to
// its target (`Dana W`), and the raw text it was written from (`[[Dana W]]`), which the file
// is rendered from. Callers read and write the value. So once a write changes the value, the
// stored raw text describes what the field used to hold, and rendering from it would put the
// old value back in the file while the database kept the new one.
//
// The rule: what a write leaves as it was keeps its links, and what it changes is written as
// the caller gave it. A value is one item or a list of items, and an item that is still there
// keeps its written form. So adding a name to a list of links leaves the other links alone,
// and a text that changes holds a link only where the caller wrote one.
//
// A raw text is used only while it still reads as the value stored beside it (#668). Rows an
// older watcher path left with the raw text of an earlier value fail that, and the field is
// written from its value, which is what the user last typed.

import { isDeepStrictEqual } from 'node:util';
import { cleanFieldValue } from '../parser/frontmatter.js';
import type { YamlValue } from '../parser/types.js';
import { renderedRawText, writtenFormOf } from '../parser/raw-field-texts.js';

export interface CarriedText {
  /** The text the file is rendered from. */
  raw: string;
  /** The value that text reads as: every link reduced to its target, as the parser reads it. */
  value: unknown;
}

export interface CarryOptions {
  /**
   * The field is defined as a list of references (reference policy 2 reads a definition for a
   * field no kind of the note claims). With no raw text the renderer writes each of its items
   * as a link, so a new item beside a carried one is written as a link too.
   */
  listOfReferences?: boolean;
}

/** The value the parser reads from one written value: links reduced to their targets. */
const valueOf = (written: unknown): unknown => cleanFieldValue(written as YamlValue);

/**
 * The written form of each stored item, or null when the raw text does not read as the stored
 * value and so says nothing about its items. A list's raw text is JSON. Any other raw text is
 * the written form of a single item: a text, or a map kept as JSON, or the one item of a list
 * a change of field type made of it. The stored items decide which reading applies, so a text
 * that looks like JSON is still a text.
 */
function writtenItems(items: readonly unknown[], raw: string): unknown[] | null {
  const asList = writtenFormOf(raw, items);
  if (Array.isArray(asList)) return asList;
  if (items.length !== 1) return null;
  const one = writtenFormOf(raw, items[0]);
  return one === null ? null : [one];
}

/**
 * Whether a stored raw text still describes the value stored beside it (#668): it reads as
 * that value, item by item as `writtenItems` reads it, or it is that very value, as when the
 * value keeps its brackets itself (the Engine stores a settings note's model fields as written,
 * `[[Model]]`). A raw text left from an earlier value does neither, and rendering from it would
 * put the earlier value back in the file.
 */
export function rawTextFitsValue(stored: unknown, raw: string): boolean {
  return writtenItems(Array.isArray(stored) ? stored : [stored], raw) !== null
    || isDeepStrictEqual(renderedRawText(raw, stored), stored);
}

/**
 * The raw text an unclaimed field is written from after a write, or null when it is written
 * from its value alone.
 *
 * `stored` and `storedRaw` are the field's row before the write, and `next` is the value the
 * write leaves in it. An unchanged value keeps its raw text whole while the text still fits
 * it (`rawTextFitsValue`), and is written from its value when it does not. Of a changed value,
 * each item that was there before keeps its written form, each stored item once, so two equal
 * items are not both given the one link. An item that is new is written as given. When no
 * item carries a written form, there is no raw text.
 */
export function carriedRawText(stored: unknown, storedRaw: string, next: unknown, options: CarryOptions = {}): CarriedText | null {
  if (isDeepStrictEqual(next, stored)) return rawTextFitsValue(stored, storedRaw) ? { raw: storedRaw, value: next } : null;
  if (next === null || next === undefined) return null;

  const before = Array.isArray(stored) ? stored : [stored];
  const written = writtenItems(before, storedRaw);
  if (written === null) return null;

  const taken = new Set<number>();
  let carried = false;
  const items = (Array.isArray(next) ? next : [next]).map((item): unknown => {
    const index = before.findIndex((value, at) => !taken.has(at) && isDeepStrictEqual(value, item));
    if (index === -1) {
      return options.listOfReferences === true && typeof item === 'string' && !item.includes('[[') ? `[[${item}]]` : item;
    }
    taken.add(index);
    if (!isDeepStrictEqual(written[index], item)) carried = true;
    return written[index];
  });
  if (!carried) return null;

  // An item the caller wrote as a link is read as the parser will read the file.
  if (Array.isArray(next)) return { raw: JSON.stringify(items), value: items.map(valueOf) };
  const [only] = items;
  if (typeof only === 'string') return { raw: only, value: valueOf(only) };
  return only !== null && typeof only === 'object' ? { raw: JSON.stringify(only), value: valueOf(only) } : null;
}
