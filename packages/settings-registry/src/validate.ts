import type { SettingDescriptor, SettingIssue, SettingsDomain } from './types.js';
import { descriptorsFor, defaultsFor } from './registry.js';
import { normalizeModelRef } from './models.js';

export function validateValue(d: SettingDescriptor, value: unknown): string | null {
  const t = d.type;
  switch (t.kind) {
    case 'string':
      if (value === null) return t.nullable ? null : 'must be a string';
      if (typeof value !== 'string') return 'must be a string';
      if (t.nonEmpty && value.trim() === '') return 'must be a non-empty string';
      return null;
    case 'text':
      return typeof value === 'string' ? null : 'must be a string';
    case 'int':
      if (value === null) return t.nullable ? null : 'must be an integer';
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be an integer';
      if (t.min !== undefined && value < t.min) return `must be >= ${t.min}`;
      if (t.max !== undefined && value > t.max) return `must be <= ${t.max}`;
      return null;
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return typeof value === 'string' && t.values.includes(value)
        ? null : `must be one of: ${t.values.join(', ')}`;
    case 'string-list':
      if (value === null) return t.nullable ? null : 'must be a list of non-empty strings';
      return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim() !== '')
        ? null : 'must be a list of non-empty strings';
    case 'cron-or-empty': {
      if (typeof value !== 'string') return 'must be a string';
      if (value.trim() === '') return null;
      const fields = value.trim().split(/\s+/);
      return fields.length === 5 || fields.length === 6
        ? null : 'must be a 5- or 6-field cron expression (or empty to disable)';
    }
    case 'hhmm':
      return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
        ? null : 'must be HH:MM (24h), e.g. "05:00"';
    case 'timezone': {
      if (typeof value !== 'string') return 'must be a string';
      if (value === '') return null; // sentinel: service resolves the system zone
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return null;
      } catch {
        return 'must be a valid IANA timezone, e.g. "America/New_York"';
      }
    }
    case 'duration':
      // Leading zeros allowed ("07d") — the curator's parseCadence accepts them, so a
      // file-edited value the wiki tooling honors must not be flagged invalid here.
      // A zero total ("0d") stays rejected, matching parseCadence's amount >= 1 rule.
      return typeof value === 'string' && /^0*[1-9]\d*\s*[mhdw]$/i.test(value.trim())
        ? null : 'must be <amount><unit> with unit m|h|d|w, e.g. "7d"';
    case 'model-ref': {
      if (value === null) return t.nullable ? null : 'must be a model reference';
      return normalizeModelRef(value) !== ''
        ? null
        : 'must be a model catalog reference, e.g. "[[Qwen 3.7 Plus]]"';
    }
  }
}

export function validateDomainPatch(
  domain: SettingsDomain,
  patch: Record<string, unknown>,
): { valid: Record<string, unknown>; issues: SettingIssue[] } {
  const byKey = new Map(descriptorsFor(domain).map(d => [d.key, d]));
  const valid: Record<string, unknown> = {};
  const issues: SettingIssue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const d = byKey.get(key);
    if (!d) {
      issues.push({ key, code: 'SETTINGS_UNKNOWN_KEY', message: `Unknown ${domain} setting: ${key}` });
      continue;
    }
    const err = validateValue(d, value);
    if (err) {
      issues.push({ key, code: 'SETTINGS_INVALID_VALUE', message: `${key} ${err}` });
    } else {
      valid[key] = value;
    }
  }
  return { valid, issues };
}

export function effectiveSettings<T>(domain: SettingsDomain, stored: Record<string, unknown>): T {
  return { ...defaultsFor(domain), ...stored } as T;
}

/**
 * Deviations-only storage invariant (spec): a stored domain patch holds explicit
 * deviations from registry defaults only. Values equal to their default are
 * dropped (per-value JSON.stringify — values are scalars or arrays whose order
 * IS meaningful). Single source of truth for the filter; SettingsService and
 * the wiki-config legacy writer both use it.
 *
 * `model-ref` kind keys compare by `normalizeModelRef` instead of raw string
 * equality: the engine's frontmatter parser unconditionally strips `[[...]]`
 * brackets from every field value it reads back off disk (wiki-link
 * extraction, universal — not settings-aware), so a default like
 * `'[[Qwen 3.7 Plus]]'` round-trips through a settings-note ingest as the
 * bracket-free `'Qwen 3.7 Plus'`. Raw string comparison would misclassify
 * that echo as a deviation forever (spurious version bumps on every re-ingest
 * of the engine's own canonical output); normalized comparison recognizes it
 * as still-the-default.
 */
export function deviationsOnly(domain: SettingsDomain, values: Record<string, unknown>): Record<string, unknown> {
  const defaults = defaultsFor(domain);
  const modelRefKeys = new Set(
    descriptorsFor(domain).filter(d => d.type.kind === 'model-ref').map(d => d.key),
  );
  const textKeys = new Set(
    descriptorsFor(domain).filter(d => d.type.kind === 'text').map(d => d.key),
  );
  return Object.fromEntries(
    Object.entries(values).filter(([k, v]) => {
      if (modelRefKeys.has(k)) return normalizeModelRef(v) !== normalizeModelRef(defaults[k]);
      if (textKeys.has(k)) return typeof v === 'string' ? v.trim() !== '' : JSON.stringify(v) !== JSON.stringify(defaults[k]);
      return JSON.stringify(v) !== JSON.stringify(defaults[k]);
    }),
  );
}
