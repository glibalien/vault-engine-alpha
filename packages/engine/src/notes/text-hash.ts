// src/notes/text-hash.ts
//
// A note's text hash: its kinds, its fields (explicit nulls included) and its body as stored, with each body link read as
// the words it shows (`withoutWikiLinks`). Wikis compare notes by it, not by `content_hash`, so an
// edit that only adds or removes links around words already in the note (the Curator's link
// sweep, the owner linking a name by hand) does not put a wiki behind or rebuild it. Any other
// edit changes it as it changes the content hash. A rename changes neither.
//
// It is computed from the database, not the file: the stored body, kinds and field values say the
// same as the file. Results are cached by node, version and content hash: every write moves the
// version (a tool write) or the content hash (a file read), so either says when to compute again. The wiki build fingerprints (`UNRENDERED_FIELDS`) are left out: they are not in
// the file either.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { withoutWikiLinks } from '@vault/contract';
import { UNRENDERED_FIELDS } from '../fields/unrendered.js';

const TEXT_HASH_VERSION = 'text-v1';
const CACHE_LIMIT = 50_000;
const BATCH = 500;

/** Text hash by `id|version|content hash`, per database. */
const caches = new WeakMap<Database.Database, Map<string, string>>();

function cacheOf(db: Database.Database): Map<string, string> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  return cache;
}

interface FieldRow {
  node_id: string;
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

/**
 * `nulls` are the fields the note writes as an explicit null (`node_explicit_null_fields`); such a
 * field reads as null whatever value row it has, as `projectFieldDetails` reads it, so adding or
 * removing one is a change (Codex, #696).
 */
function computeTextHash(body: string | null, types: string[], fields: FieldRow[], nulls: readonly string[]): string {
  const markers = new Set(nulls);
  const projection = {
    v: TEXT_HASH_VERSION,
    types: [...types].sort(),
    fields: [
      ...fields
        .filter(field => !markers.has(field.field_name))
        .map(field => [field.field_name, 'value', field.value_text, field.value_number, field.value_date, field.value_json]),
      ...[...markers].map(name => [name, 'null']),
    ]
      .filter(field => !UNRENDERED_FIELDS.has(String(field[0])))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    body: withoutWikiLinks(body ?? ''),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

/** The text hash of each of `ids` that is a node; ids of no node are left out. */
export function textHashes(db: Database.Database, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const cache = cacheOf(db);
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += BATCH) {
    const chunk = unique.slice(start, start + BATCH);
    const marks = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, version, content_hash FROM nodes WHERE id IN (${marks})`).all(...chunk) as
      Array<{ id: string; version: number; content_hash: string | null }>;
    const misses: Array<{ id: string; key: string }> = [];
    for (const row of rows) {
      const key = `${row.id}|${row.version}|${row.content_hash ?? ''}`;
      const hit = cache.get(key);
      if (hit !== undefined) out.set(row.id, hit);
      else misses.push({ id: row.id, key });
    }
    if (misses.length === 0) continue;
    const missIds = misses.map(row => row.id);
    const missMarks = missIds.map(() => '?').join(',');
    const bodies = new Map((db.prepare(`SELECT id, body FROM nodes WHERE id IN (${missMarks})`).all(...missIds) as
      Array<{ id: string; body: string | null }>).map(row => [row.id, row.body]));
    const types = new Map<string, string[]>();
    for (const row of db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${missMarks})`).all(...missIds) as
      Array<{ node_id: string; schema_type: string }>) {
      const list = types.get(row.node_id) ?? [];
      list.push(row.schema_type);
      types.set(row.node_id, list);
    }
    const fields = new Map<string, FieldRow[]>();
    for (const row of db.prepare(`SELECT node_id, field_name, value_text, value_number, value_date, value_json
      FROM node_fields WHERE node_id IN (${missMarks})`).all(...missIds) as FieldRow[]) {
      const list = fields.get(row.node_id) ?? [];
      list.push(row);
      fields.set(row.node_id, list);
    }
    const nulls = new Map<string, string[]>();
    for (const row of db.prepare(`SELECT node_id, field_name FROM node_explicit_null_fields WHERE node_id IN (${missMarks})`).all(...missIds) as
      Array<{ node_id: string; field_name: string }>) {
      const list = nulls.get(row.node_id) ?? [];
      list.push(row.field_name);
      nulls.set(row.node_id, list);
    }
    for (const row of misses) {
      const hash = computeTextHash(bodies.get(row.id) ?? null, types.get(row.id) ?? [], fields.get(row.id) ?? [], nulls.get(row.id) ?? []);
      out.set(row.id, hash);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(row.key, hash);
    }
  }
  return out;
}

/** The text hash of one node, or null when there is no such node. */
export function textHashOf(db: Database.Database, id: string): string | null {
  return textHashes(db, [id]).get(id) ?? null;
}

/** Empty the cache (tests that rewrite a node's row without changing its version or content hash). */
export function clearTextHashCache(db: Database.Database): void {
  caches.delete(db);
}
