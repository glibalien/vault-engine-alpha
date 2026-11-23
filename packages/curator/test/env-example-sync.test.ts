import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { descriptorsFor } from '@vault/settings-registry';

const MARKER = 'MIGRATED TO SETTINGS NOTES';
const example = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.env.example'), 'utf8');

describe('.env.example ↔ registry sync (curator domain)', () => {
  it('lists every curator envSeed var in the migrated section and none in the bootstrap section', () => {
    const at = example.indexOf(MARKER);
    expect(at).toBeGreaterThan(-1);
    const bootstrap = example.slice(0, at);
    const migrated = example.slice(at);
    for (const v of descriptorsFor('curator').flatMap(d => (d.envSeed ? [d.envSeed.var] : []))) {
      expect(migrated).toMatch(new RegExp(`^# ${v}=`, 'm'));
      expect(bootstrap).not.toMatch(new RegExp(`^#? ?${v}=`, 'm'));
    }
  });

  it('the dead CURATOR_THEMED_PAGE_CAP alias is gone', () => {
    expect(example).not.toMatch(/^#? ?CURATOR_THEMED_PAGE_CAP=/m);
  });

  it('CURATOR_PROVIDER is gone — provider now derives from the model\'s Settings/Models entry', () => {
    expect(example).not.toMatch(/^#? ?CURATOR_PROVIDER=/m);
  });

  it('documents the field guess seed defaults in the migrated section', () => {
    const migrated = example.slice(example.indexOf(MARKER));
    expect(migrated).toMatch(/^# CURATOR_FIELD_GUESS_MODEL=\[\[GPT-OSS 120B\]\]$/m);
    expect(migrated).toMatch(/^# CURATOR_FIELD_GUESS_CAP=25$/m);
    expect(migrated).toMatch(/^# CURATOR_FIELD_GUESS_MAX_TOKENS=2000$/m);
  });
});
