import { describe, expect, it } from 'vitest';
import { validateValue, deviationsOnly } from '../src/index.js';
import type { SettingDescriptor } from '../src/index.js';

const d = (type: SettingDescriptor['type']): SettingDescriptor =>
  ({ key: 'k', domain: 'engine', type, default: null, reload: 'next-use', description: 'test descriptor' });

describe('nullable kinds', () => {
  it('nullable string accepts null; plain string rejects it', () => {
    expect(validateValue(d({ kind: 'string', nonEmpty: true, nullable: true }), null)).toBeNull();
    expect(validateValue(d({ kind: 'string', nonEmpty: true, nullable: true }), 'x')).toBeNull();
    expect(validateValue(d({ kind: 'string', nonEmpty: true, nullable: true }), '')).toMatch(/non-empty/);
    expect(validateValue(d({ kind: 'string' }), null)).toMatch(/string/);
  });
  it('nullable int accepts null; plain int rejects it', () => {
    expect(validateValue(d({ kind: 'int', min: 1, nullable: true }), null)).toBeNull();
    expect(validateValue(d({ kind: 'int', min: 1, nullable: true }), 4000)).toBeNull();
    expect(validateValue(d({ kind: 'int', min: 1, nullable: true }), 0)).toMatch(/>= 1/);
    expect(validateValue(d({ kind: 'int', min: 1 }), null)).toMatch(/integer/);
  });
});

describe('hhmm', () => {
  it.each(['05:00', '00:00', '23:59'])('accepts %s', (v) =>
    expect(validateValue(d({ kind: 'hhmm' }), v)).toBeNull());
  it.each(['5:00', '24:00', '12:60', '1200', '', 12, null])('rejects %s', (v) =>
    expect(validateValue(d({ kind: 'hhmm' }), v)).not.toBeNull());
});

describe('timezone', () => {
  it('accepts a valid IANA zone and the empty sentinel', () => {
    expect(validateValue(d({ kind: 'timezone' }), 'America/New_York')).toBeNull();
    expect(validateValue(d({ kind: 'timezone' }), 'UTC')).toBeNull();
    expect(validateValue(d({ kind: 'timezone' }), '')).toBeNull();   // '' = system zone
  });
  it('rejects junk zones and non-strings', () => {
    expect(validateValue(d({ kind: 'timezone' }), 'Mars/Olympus_Mons')).toMatch(/timezone/i);
    expect(validateValue(d({ kind: 'timezone' }), 5)).not.toBeNull();
  });
});

describe('text', () => {
  it('accepts any string, including blank and multi-line text', () => {
    expect(validateValue(d({ kind: 'text' }), '')).toBeNull();
    expect(validateValue(d({ kind: 'text' }), '  ')).toBeNull();
    expect(validateValue(d({ kind: 'text' }), 'line 1\nline 2')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(validateValue(d({ kind: 'text' }), null)).toMatch(/string/);
    expect(validateValue(d({ kind: 'text' }), 1)).toMatch(/string/);
  });
});

describe('duration', () => {
  // Leading zeros ('07d') are valid — parity with the curator's parseCadence, which
  // accepts them; a file-edited value the wiki tooling honors must not be flagged here.
  it.each(['7d', '24h', '90m', '2w', '7D', '3 d', '07d', '007w'])('accepts %s', (v) =>
    expect(validateValue(d({ kind: 'duration' }), v)).toBeNull());
  it.each(['0d', '00d', '-1d', 'd', '7', '7y', '', null, 7])('rejects %s', (v) =>
    expect(validateValue(d({ kind: 'duration' }), v)).not.toBeNull());
});

describe('deviationsOnly', () => {
  it('drops values equal to the registry default (deep-equal for arrays)', () => {
    expect(deviationsOnly('engine', { backupKeep: 7, backupIntervalHours: 12, excludeDirs: [] }))
      .toEqual({ backupIntervalHours: 12 });
    expect(deviationsOnly('vault', { taskActiveStatuses: ['open', 'in-progress'], wikiDir: 'W2' }))
      .toEqual({ wikiDir: 'W2' });
  });

  it('model-ref keys compare by normalized title, not raw string, against the default', () => {
    // The default is '[[Qwen 3.7 Plus]]'; the engine's frontmatter parser
    // strips wikilink brackets on every ingest, so a settings-note round trip
    // hands this back bracket-free. Raw-string comparison would misclassify
    // that echo as a permanent deviation (see settings-registry validate.ts).
    expect(deviationsOnly('engine', { visionModel: 'Qwen 3.7 Plus' })).toEqual({});
    expect(deviationsOnly('engine', { visionModel: '[[Qwen 3.7 Plus]]' })).toEqual({});
    expect(deviationsOnly('engine', { visionModel: '[[Custom Model]]' }))
      .toEqual({ visionModel: '[[Custom Model]]' });
  });

  it('text keys treat blank and whitespace-only values as default-equivalent', () => {
    expect(deviationsOnly('chat', { chatSystemPrompt: '', chatTieringNote: '  \n' })).toEqual({});
    expect(deviationsOnly('chat', { chatSystemPrompt: 'custom' })).toEqual({ chatSystemPrompt: 'custom' });
  });
});
