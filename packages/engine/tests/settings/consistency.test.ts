import { describe, expect, it } from 'vitest';
import { DOMAINS, FALLBACK_MODELS, defaultsFor, descriptorsFor, validateDomainPatch } from '@vault/settings-registry';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { DEFAULT_CONSOLIDATION_MODEL } from '../../src/mcp/tools/memory-consolidation.js';

describe('registry ↔ engine consistency', () => {
  it('DEFAULT_WIKI_CONFIG is exactly the wiki and vault registry defaults', () => {
    expect({ ...defaultsFor('wiki'), ...defaultsFor('vault') }).toEqual(DEFAULT_WIKI_CONFIG);
  });
  it('memoryConsolidationModel default equals DEFAULT_CONSOLIDATION_MODEL', () => {
    // The registry default is now a catalog ref ('[[Qwen 3.7 Plus]]'), not the
    // raw provider id — the fallback map (last resort when even a seeded ref
    // dangles) is the one place that still carries the raw id, so pin against
    // that instead.
    expect(FALLBACK_MODELS['Qwen 3.7 Plus']!.model).toBe(DEFAULT_CONSOLIDATION_MODEL);
  });
  it('every descriptor key is unique within its domain', () => {
    for (const domain of DOMAINS) {
      const keys = descriptorsFor(domain).map(d => d.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it('every default in every domain validates against its own descriptor', () => {
    for (const domain of DOMAINS) {
      const defaults = defaultsFor(domain);
      for (const d of descriptorsFor(domain)) {
        expect(validateDomainPatch(domain, { [d.key]: defaults[d.key] }).issues).toEqual([]);
      }
    }
  });
  it('envSeed vars are globally unique across domains', () => {
    const vars = DOMAINS.flatMap(dom => descriptorsFor(dom).flatMap(d => d.envSeed ? [d.envSeed.var] : []));
    expect(new Set(vars).size).toBe(vars.length);
  });
});
