import type { SettingsDomain } from './types.js';
import { descriptorsFor } from './registry.js';
import { validateValue } from './validate.js';

export function seedFromEnv(
  domain: SettingsDomain,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of descriptorsFor(domain)) {
    if (!d.envSeed) continue;
    const raw = env[d.envSeed.var];
    if (raw === undefined || raw.trim() === '') continue;
    const value = d.envSeed.parse ? d.envSeed.parse(raw.trim()) : raw.trim();
    if (validateValue(d, value) === null) out[d.key] = value;
  }
  return out;
}

/** Migrated env vars still set for `domain` — each service warns for its own domains. */
export function staleEnvVars(
  domain: SettingsDomain,
  env: Record<string, string | undefined>,
): Array<{ var: string; key: string }> {
  const out: Array<{ var: string; key: string }> = [];
  for (const d of descriptorsFor(domain)) {
    const raw = d.envSeed ? env[d.envSeed.var] : undefined;
    if (d.envSeed && raw !== undefined && raw.trim() !== '') {
      out.push({ var: d.envSeed.var, key: d.key });
    }
  }
  return out;
}
