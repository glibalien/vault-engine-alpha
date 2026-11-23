import { createHash } from 'node:crypto';
import type { Json } from './types.js';

/** Exact JSON strings: no Unicode normalization or omission of undefined values. */
export function canonicalJson(value: Json): string {
  const ancestors = new Set<object>();
  function encode(v: unknown, depth: number): string {
    if (depth > 64) throw new Error('Invalid canonical JSON');
    if (v === null) return 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || ancestors.has(v)) throw new Error('Invalid canonical JSON');
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length || Reflect.ownKeys(v).length !== v.length + 1) throw new Error('Invalid canonical JSON');
        return '[' + Array.from(v, item => encode(item, depth + 1)).join(',') + ']';
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new Error('Invalid canonical JSON');
      }
      if (Reflect.ownKeys(v).length !== Object.keys(v).length) throw new Error('Invalid canonical JSON');
      return '{' + Object.keys(v).sort().map(key =>
        JSON.stringify(key) + ':' + encode((v as Record<string, unknown>)[key], depth + 1),
      ).join(',') + '}';
    } finally { ancestors.delete(v); }
  }
  return encode(value, 0);
}

export function digestText(text: string): string {
  return 'sha256:text-v1:' + createHash('sha256').update('text-v1\0').update(text, 'utf8').digest('hex');
}

export function digestJson(value: Json): string {
  return 'sha256:json-v1:' + createHash('sha256').update('json-v1\0').update(canonicalJson(value), 'utf8').digest('hex');
}
