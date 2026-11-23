import type Database from 'better-sqlite3';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { getVaultSettings } from '../settings/vault.js';
import { fieldTags, inlineTags } from './inline.js';

/**
 * The tags of a vault, with the notes that carry each (#647). Read-only and stateless.
 *
 * Some apps mark what a note is with a `#tag` in its text. Nothing else in the Engine reads
 * those, so a query cannot find "the notes tagged #meeting", and the kind hiding in a tag stays
 * hidden. This lists every tag with its notes, so a caller can turn a tag into a kind or into a
 * field value with the tools that already write in bulk.
 *
 * A tag in the `tags` frontmatter field is the same tag, so both are counted, and each note
 * says where it holds it. A nested tag counts for the tags it is nested under, as in Obsidian:
 * a note with `#project/alpha` is one of the notes of `project`. The owner's decision (2026-11-18): the `#tag` text stays in the note
 * after its tag has been mapped; nothing here writes.
 */

export const TAG_LIMITS = {
  defaultTags: 50,
  maxTags: 200,
  defaultNotes: 200,
  maxNotes: 500,
  /** Notes shown per tag, and kinds counted per tag. */
  examples: 3,
  kinds: 3,
} as const;

/** The frontmatter fields that hold tags, as Obsidian names them. */
const TAG_FIELDS = ['tags', 'tag'] as const;

export class TagError extends Error {
  override readonly name = 'TagError';
  constructor(readonly code: 'INVALID_PARAMS' | 'NOT_FOUND', message: string) {
    super(message);
  }
}

export interface TagRequest {
  /** List the notes of this one tag instead of the tags. */
  tag?: string;
  /** Only tags starting with this, e.g. `project/`. */
  prefix?: string;
  /** Only tags at least this many notes carry (default 1). */
  min_notes?: number;
  /** Only notes whose vault path starts with this. */
  path_prefix?: string;
  /** Only notes with no kind. */
  untyped_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface TagNote { id: string; title: string; path: string; types: string[]; inline: boolean; in_field: boolean; nested_only: boolean }

export interface TagRow {
  tag: string;
  /** Notes that carry it, in their text or in the tags field. */
  notes: number;
  /** Of those: in their text, in the tags field, and with no kind. */
  inline: number;
  in_field: number;
  untyped: number;
  /** Of those: notes that carry it only through a tag nested under it (`project/alpha` for `project`). */
  nested_only: number;
  /** The kinds those notes have, most notes first. */
  types: Array<{ type: string; notes: number }>;
  /** The newest notes that carry it. */
  examples: Array<{ id: string; title: string; path: string }>;
}

export interface TagListing {
  scope: { notes: number; tagged: number };
  total_tags: number;
  offset: number;
  /** Most notes first. */
  tags: TagRow[];
}

export interface TagNotes {
  tag: string;
  total: number;
  offset: number;
  /** Newest first. */
  notes: TagNote[];
}

interface Carrier { id: string; title: string; path: string; inline: boolean; inField: boolean; nestedOnly: boolean }

/** A tag and the tags it is nested under: `project/alpha/q1` is also `project/alpha` and `project`, as in Obsidian. */
function withParents(tags: Iterable<string>): Set<string> {
  const all = new Set<string>();
  for (const tag of tags) {
    const parts = tag.split('/').filter(part => part !== '');
    for (let depth = 1; depth <= parts.length; depth++) all.add(parts.slice(0, depth).join('/'));
  }
  return all;
}

/** Every tag in scope with the notes that carry it, newest note first. */
function scan(db: Database.Database, request: TagRequest, settingsDir: string | undefined): { notes: number; tagged: number; byTag: Map<string, Carrier[]> } {
  const user = userNotesWhere({ vault: getVaultSettings(db), settingsDir });
  const where = [user.sql];
  const params: string[] = [...user.params];
  if (request.path_prefix) {
    where.push(`n.file_path LIKE ? ${LIKE_ESCAPE}`);
    params.push(literalPrefixPattern(request.path_prefix));
  }
  if (request.untyped_only === true) where.push('NOT EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id)');
  const rows = db.prepare<string[], { id: string; title: string | null; path: string; body: string | null }>(
    `SELECT n.id, n.title, n.file_path AS path, n.body FROM nodes n WHERE ${where.join(' AND ')} ORDER BY n.file_mtime DESC, n.id`,
  );
  const inFields = new Map<string, Set<string>>();
  const fieldRows = db.prepare<string[], { id: string; text: string | null; json: string | null }>(
    `SELECT node_id AS id, value_text AS text, value_json AS json FROM node_fields WHERE field_name IN (${TAG_FIELDS.map(() => '?').join(', ')})`,
  );
  for (const row of fieldRows.iterate(...TAG_FIELDS)) {
    const tags = fieldTags(row.text, row.json);
    if (tags.length === 0) continue;
    const known = inFields.get(row.id);
    if (known) for (const tag of tags) known.add(tag);
    else inFields.set(row.id, new Set(tags));
  }

  const byTag = new Map<string, Carrier[]>();
  let notes = 0;
  let tagged = 0;
  for (const row of rows.iterate(...params)) {
    notes += 1;
    const written = new Set(row.body === null || !row.body.includes('#') ? [] : inlineTags(row.body));
    const fielded = inFields.get(row.id) ?? new Set<string>();
    if (written.size === 0 && fielded.size === 0) continue;
    tagged += 1;
    const inline = withParents(written);
    const inField = withParents(fielded);
    for (const tag of new Set([...inline, ...inField])) {
      const carrier: Carrier = {
        id: row.id, title: row.title ?? '', path: row.path, inline: inline.has(tag), inField: inField.has(tag),
        nestedOnly: !written.has(tag) && !fielded.has(tag),
      };
      const list = byTag.get(tag);
      if (list) list.push(carrier);
      else byTag.set(tag, [carrier]);
    }
  }
  return { notes, tagged, byTag };
}

/** A tag as a caller writes it: with or without `#`, in any letter case. */
const tagKey = (tag: string): string => tag.trim().replace(/^#/, '').toLowerCase();

export function listTags(db: Database.Database, request: TagRequest, options: { settingsDir?: string } = {}): TagListing | TagNotes {
  const found = scan(db, request, options.settingsDir);
  const typesOf = db.prepare<[string], { schema_type: string }>('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type');
  const offset = request.offset ?? 0;

  if (request.tag !== undefined) {
    const tag = tagKey(request.tag);
    const carriers = found.byTag.get(tag);
    if (!carriers) throw new TagError('NOT_FOUND', `No note in scope carries the tag "${tag}". Call this with no tag to list the tags there are.`);
    return {
      tag,
      total: carriers.length,
      offset,
      notes: carriers.slice(offset, offset + (request.limit ?? TAG_LIMITS.defaultNotes)).map(carrier => ({
        id: carrier.id, title: carrier.title, path: carrier.path,
        types: typesOf.all(carrier.id).map(type => type.schema_type),
        inline: carrier.inline, in_field: carrier.inField, nested_only: carrier.nestedOnly,
      })),
    };
  }

  const prefix = request.prefix === undefined ? null : tagKey(request.prefix);
  const atLeast = request.min_notes ?? 1;
  const ranked = [...found.byTag.entries()]
    .filter(([tag, carriers]) => carriers.length >= atLeast && (prefix === null || tag.startsWith(prefix)))
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  return {
    scope: { notes: found.notes, tagged: found.tagged },
    total_tags: ranked.length,
    offset,
    tags: ranked.slice(offset, offset + (request.limit ?? TAG_LIMITS.defaultTags)).map(([tag, carriers]) => {
      const kinds = new Map<string, number>();
      let untyped = 0;
      for (const carrier of carriers) {
        const types = typesOf.all(carrier.id);
        if (types.length === 0) untyped += 1;
        for (const type of types) kinds.set(type.schema_type, (kinds.get(type.schema_type) ?? 0) + 1);
      }
      return {
        tag,
        notes: carriers.length,
        inline: carriers.filter(carrier => carrier.inline).length,
        in_field: carriers.filter(carrier => carrier.inField).length,
        untyped,
        nested_only: carriers.filter(carrier => carrier.nestedOnly).length,
        types: [...kinds.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TAG_LIMITS.kinds).map(([type, count]) => ({ type, notes: count })),
        examples: carriers.slice(0, TAG_LIMITS.examples).map(carrier => ({ id: carrier.id, title: carrier.title, path: carrier.path })),
      };
    }),
  };
}
