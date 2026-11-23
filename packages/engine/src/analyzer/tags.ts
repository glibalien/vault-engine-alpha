/**
 * Tags as a source of kinds at install (#650). A note's tags are its inline `#tags` (read as
 * Obsidian reads them, `tags/inline.ts`) and its frontmatter `tags` (or `tag`). A nested tag
 * also counts as its parents: a note tagged `#meeting/standup` is tagged `meeting`, as
 * `list-inline-tags` counts it. The tag text stays in the note; a kind is added beside it.
 */
import type { YamlRecord, YamlValue } from '../parser/types.js';
import { fieldTags, inlineTags } from '../tags/inline.js';
import { isApplySafeSchemaName } from './schema-name.js';

/** At most this many tags are offered, most notes first. */
export const MAX_TAG_CANDIDATES = 50;
/** A tag on fewer notes than this is not offered as a kind. */
export const MIN_TAG_DOCUMENTS = 2;

export interface TagCandidate {
  /** Lowercase, without the `#`. */
  tag: string;
  /** Notes carrying it, directly or through a nested tag under it. */
  documents: number;
}

/** The frontmatter keys that hold a note's tags. */
const TAG_KEYS = ['tags', 'tag'] as const;

/** A note's tags, each once, with the parents of every nested tag. */
export function noteTags(body: string, data: YamlRecord): string[] {
  const tags = new Set<string>();
  const add = (tag: string) => {
    const parts = tag.split('/').filter(part => part !== '');
    for (let depth = 1; depth <= parts.length; depth++) tags.add(parts.slice(0, depth).join('/'));
  };
  for (const tag of inlineTags(body)) add(tag);
  for (const key of TAG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value: YamlValue = data[key] as YamlValue;
    const text = typeof value === 'string' ? value : null;
    const json = Array.isArray(value) ? JSON.stringify(value) : null;
    for (const tag of fieldTags(text, json)) add(tag);
  }
  return [...tags];
}

/** Whether a tag can name a kind as it is: one word or name, with no `/`, usable as a schema file name. */
export function isKindTag(tag: string): boolean {
  return !tag.includes('/') && isApplySafeSchemaName(tag);
}

/** The tags worth offering as kinds, from each note's tags: the most used first. */
export function tagCandidates(notes: Iterable<readonly string[]>): { candidates: TagCandidate[]; truncated: boolean } {
  const counts = new Map<string, number>();
  for (const tags of notes) {
    for (const tag of new Set(tags)) {
      if (isKindTag(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const all = [...counts]
    .filter(([, documents]) => documents >= MIN_TAG_DOCUMENTS)
    .map(([tag, documents]) => ({ tag, documents }))
    .sort((left, right) => right.documents - left.documents || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
  return { candidates: all.slice(0, MAX_TAG_CANDIDATES), truncated: all.length > MAX_TAG_CANDIDATES };
}
