import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { descriptorsFor } from '@vault/settings-registry';

const MARKER = 'MIGRATED TO SETTINGS NOTES';
const example = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../.env.example'), 'utf8');

describe('.env.example ↔ registry sync (engine domain)', () => {
  it('lists every engine envSeed var in the migrated section and none in the bootstrap section', () => {
    const at = example.indexOf(MARKER);
    expect(at).toBeGreaterThan(-1);
    const bootstrap = example.slice(0, at);
    const migrated = example.slice(at);
    for (const v of descriptorsFor('engine').flatMap(d => (d.envSeed ? [d.envSeed.var] : []))) {
      expect(migrated).toMatch(new RegExp(`^# ${v}=`, 'm'));
      expect(bootstrap).not.toMatch(new RegExp(`^#? ?${v}=`, 'm'));
    }
  });

  it('has no envSeed vars for the wiki domain (wiki_config migrates in-place, not via env)', () => {
    expect(descriptorsFor('wiki').every(d => !d.envSeed)).toBe(true);
  });
});
