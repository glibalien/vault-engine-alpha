import { sha256 } from '../indexer/hash.js';
import { ClassificationError, type EnumGroupsV1 } from './types.js';
function invalid(message: string): never { throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG', message); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected an enum group object.');
  if (Object.keys(value).some(k => !keys.includes(k))) return invalid('Unknown enum group property.');
  return value as Record<string, unknown>;
}
export function parseEnumGroups(input: unknown, allowedValues: readonly string[]): EnumGroupsV1 {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { return invalid('Enum groups must be JSON data.'); }
  if (!encoded || Buffer.byteLength(encoded) > 65536) return invalid('Enum group definition exceeds 64 KiB.');
  const obj = record(input, ['version', 'groups']);
  if (obj.version !== 1 || !Array.isArray(obj.groups) || obj.groups.length > 64) return invalid('Expected version 1 and at most 64 groups.');
  const names = new Set<string>();
  const allowed = new Set(allowedValues);
  const groups = obj.groups.map(raw => {
    const g = record(raw, ['name', 'values', 'label', 'description']);
    if (typeof g.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(g.name) || names.has(g.name)) return invalid('Invalid or duplicate group name.');
    names.add(g.name);
    if (!Array.isArray(g.values) || g.values.length > 512 || g.values.some(v => typeof v !== 'string' || !allowed.has(v)) || new Set(g.values).size !== g.values.length) return invalid(`Group '${g.name}' must contain at most 512 distinct allowed enum values.`);
    for (const [key, max] of [['label', 80], ['description', 280]] as const) {
      if (g[key] !== undefined && (typeof g[key] !== 'string' || [...g[key] as string].length > max)) return invalid(`Invalid group ${key}.`);
    }
    return { name: g.name, values: [...g.values as string[]].sort(), ...(g.label !== undefined ? { label: g.label as string } : {}), ...(g.description !== undefined ? { description: g.description as string } : {}) };
  });
  return { version: 1, groups: groups.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}
/** Inputs must already have canonical object key order; sets are normalized by their owner. */
export function classificationHash(value: unknown): string { return sha256(JSON.stringify(value)); }
export function globalClassificationHash(field: { field_type: string; enum_values: string[] | null; enum_groups?: EnumGroupsV1 | null; overrides_allowed: { enum_groups?: boolean } }): string {
  return classificationHash({ field_type: field.field_type, enum_values: field.enum_values ? [...field.enum_values].sort() : null, enum_groups: field.enum_groups ? parseEnumGroups(field.enum_groups, field.enum_values ?? []) : null, override_allowed: field.overrides_allowed.enum_groups === true });
}
