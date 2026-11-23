import type { YamlRecord, YamlValue } from '../parser/types.js';

const MAX_ANALYZER_VALUE_DEPTH = 64;

type UnsupportedReason =
  | 'cyclic_reference'
  | 'depth_limit'
  | 'non_finite_number'
  | 'non_json_value';

/** Analyzer frontmatter must begin with an ordinary YAML mapping, not a tagged collection. */
export function isPlainAnalyzerMapping(value: unknown): value is YamlRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone parser output into the JSON-safe value domain used by Analyzer reports. */
export function sanitizeAnalyzerMapping(mapping: YamlRecord): YamlRecord {
  return sanitizeValue(mapping, new WeakSet<object>(), 0) as YamlRecord;
}

function sanitizeValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): YamlValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return unsupported('non_finite_number', numberSummary(value));
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    return unsupported('non_json_value', typeof value);
  }
  if (depth >= MAX_ANALYZER_VALUE_DEPTH) {
    return unsupported('depth_limit', `Values deeper than ${MAX_ANALYZER_VALUE_DEPTH} levels`);
  }
  if (ancestors.has(value)) return unsupported('cyclic_reference', 'YAML alias cycle');

  if (value instanceof Date) {
    return unsupported(
      'non_json_value',
      Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(),
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => sanitizeValue(item, ancestors, depth + 1));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported('non_json_value', Object.prototype.toString.call(value));
    }

    const output: YamlRecord = {};
    for (const key of Object.keys(value).sort(compareExact)) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: sanitizeValue((value as Record<string, unknown>)[key], ancestors, depth + 1),
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function unsupported(reason: UnsupportedReason, summary: string): YamlRecord {
  return {
    analyzer_value: 'unsupported',
    reason,
    summary,
  };
}

function numberSummary(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
