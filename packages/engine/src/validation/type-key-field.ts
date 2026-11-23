// src/validation/type-key-field.ts
//
// A field named like the type key (#445, #480).
//
// The type key (`types` unless VAULT_TYPE_KEY names another) holds a note's types, and the
// renderer writes them under it, first. A field of that name would be written over them,
// and the next ingest of the file would read the field's value as the note's types. So no
// tool write may set one: every tool that takes field names refuses it, naming the
// parameters that change types there. Before #480 a field named `types` was accepted as an
// orphan field, so a note may still carry one in the database; the pipeline drops it at
// that note's next write and keeps its value in the edits log (pipeline/execute.ts).

import { typeKey } from '../parser/type-key.js';
import type { ValidationIssue } from './types.js';

/** Where a field write was made, so its refusal names the parameters that change types there. */
export type TypeKeyFieldSite =
  | 'create-node'
  | 'update-node'
  | 'update-node-query'
  | 'batch-create'
  | 'batch-update'
  | 'any';

/** The parameters that change a note's types at each site. */
const TYPE_PARAMS: Record<TypeKeyFieldSite, readonly string[]> = {
  'create-node': ['types'],
  'update-node': ['set_types', 'add_types', 'remove_types'],
  'update-node-query': ['add_types', 'remove_types'],
  'batch-create': ['types'],
  'batch-update': ['set_types', 'add_types', 'remove_types'],
  any: ['types', 'set_types', 'add_types', 'remove_types'],
};

/** The type names a refused value held, as a JSON list for an example call, or null. */
function exampleList(value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || !values.every(v => typeof v === 'string' && v.trim() !== '')) return null;
  return JSON.stringify([...new Set((values as string[]).map(v => v.trim()))]);
}

/**
 * The refusal for a write that sets a field named like the type key, written for the caller
 * to act on: it names the parameters that change types at that site and, when the value
 * named types, shows the call to make with them.
 */
export function typeKeyFieldMessage(site: TypeKeyFieldSite, value?: unknown, key: string = typeKey()): string {
  const head = `"${key}" is the frontmatter key that holds the note's types, so it cannot be set as a field.`;
  const list = exampleList(value);
  const clear = value === null;
  switch (site) {
    case 'create-node':
      return `${head} Remove "${key}" from fields and pass the note's types in create-node's types parameter`
        + (list ? `, for example types: ${list}.` : '.');
    case 'batch-create':
      return `${head} Remove "${key}" from this create operation's fields and pass the note's types in its types param`
        + (list ? `, for example types: ${list}.` : '.');
    case 'update-node':
    case 'batch-update': {
      const where = site === 'update-node' ? 'set_fields' : 'this update operation\'s set_fields';
      const params = site === 'update-node'
        ? 'update-node\'s set_types (replaces them all), add_types or remove_types'
        : 'its set_types (replaces them all), add_types or remove_types params';
      const example = clear
        ? '; to remove types, use remove_types, or set_types: [] to remove them all.'
        : list ? `, for example set_types: ${list}, or add_types: ${list} to keep the others.` : '.';
      return `${head} Remove "${key}" from ${where} and change types with ${params}${example}`;
    }
    case 'update-node-query': {
      const example = clear
        ? '; to remove types, use remove_types.'
        : list ? `, for example add_types: ${list}.` : '.';
      return `${head} Remove "${key}" from set_fields and change types with add_types or remove_types `
        + `(query mode has no set_types)${example}`;
    }
    case 'any':
      return `${head} Change types with the types parameters instead: types on create-node; set_types, `
        + 'add_types or remove_types on update-node (add_types or remove_types in query mode); the same '
        + 'names in batch-mutate operation params.';
  }
}

/** The TYPE_KEY_FIELD issue for `fields` when it names the type key, or null. */
export function typeKeyFieldIssue(
  fields: Readonly<Record<string, unknown>> | undefined,
  site: TypeKeyFieldSite,
): ValidationIssue | null {
  const key = typeKey();
  if (fields === undefined || !Object.hasOwn(fields, key)) return null;
  return {
    field: key,
    severity: 'error',
    code: 'TYPE_KEY_FIELD',
    message: typeKeyFieldMessage(site, fields[key], key),
    details: { type_key: key, use: TYPE_PARAMS[site] },
  };
}

/**
 * Remove, in place, a field named like the type key from a node's stored fields as a tool
 * just read them. Such a field, left by a tool write before #480, is dropped at the node's
 * next write, so a preview or a check made before that write leaves it out too.
 */
export function dropStoredTypeKeyField(fields: Record<string, unknown>): void {
  delete fields[typeKey()];
}
