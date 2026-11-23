import { describe, expect, it } from 'vitest';
import {
  validateDomainPatch, effectiveSettings, defaultsFor, descriptorsFor,
} from '../src/index.js';
import type { EngineSettings } from '../src/index.js';

describe('validateDomainPatch(engine)', () => {
  it('accepts valid values and rejects invalid ones individually', () => {
    const { valid, issues } = validateDomainPatch('engine', {
      backupIntervalHours: 12,
      backupKeep: 0,                    // int min 1 → invalid
      visionProvider: 'claude',
      normalizeCron: 'not a cron',      // invalid
      excludeDirs: ['Templates'],
      nonsenseKey: true,                // unknown
    });
    expect(valid).toEqual({ backupIntervalHours: 12, visionProvider: 'claude', excludeDirs: ['Templates'] });
    expect(issues).toHaveLength(3);
    expect(issues.map(i => i.code).sort()).toEqual(
      ['SETTINGS_INVALID_VALUE', 'SETTINGS_INVALID_VALUE', 'SETTINGS_UNKNOWN_KEY']);
    expect(issues.find(i => i.key === 'backupKeep')!.message).toMatch(/>= 1/);
  });

  it('rejects wrong primitive types', () => {
    const { valid, issues } = validateDomainPatch('engine', {
      backupsEnabled: 'yes', excludeDirs: 'Templates', normalizeQuiescenceMinutes: 4.5,
    });
    expect(valid).toEqual({});
    expect(issues).toHaveLength(3);
  });

  it('accepts an empty cron (disabled) and a 5-field cron', () => {
    expect(validateDomainPatch('engine', { normalizeCron: '' }).issues).toHaveLength(0);
    expect(validateDomainPatch('engine', { normalizeCron: '0 3 * * *' }).issues).toHaveLength(0);
  });

  it('takes linkRepair on, report or off; on by default, read at restart (#447)', () => {
    expect(defaultsFor('engine').linkRepair).toBe('on');
    const descriptor = descriptorsFor('engine').find(d => d.key === 'linkRepair');
    expect(descriptor?.reload).toBe('restart');
    expect(descriptor?.envSeed).toBeUndefined();
    for (const mode of ['on', 'report', 'off']) {
      expect(validateDomainPatch('engine', { linkRepair: mode }).issues).toEqual([]);
    }
    expect(validateDomainPatch('engine', { linkRepair: 'dry-run' }).issues).toHaveLength(1);
  });
});

describe('effectiveSettings', () => {
  it('merges stored over defaults', () => {
    const eff = effectiveSettings<EngineSettings>('engine', { backupKeep: 3 });
    expect(eff.backupKeep).toBe(3);
    expect(eff.backupIntervalHours).toBe(24);
    expect(eff.excludeDirs).toEqual([]);
    expect(eff.visionProvider).toBe('gemini');
    expect(eff.visionModel).toBe('[[Qwen 3.7 Plus]]');
  });
});

describe('registry shape', () => {
  it('every engine descriptor has a description and its default validates', () => {
    for (const d of descriptorsFor('engine')) {
      expect(d.description.length).toBeGreaterThan(10);
      const { issues } = validateDomainPatch('engine', { [d.key]: defaultsFor('engine')[d.key] });
      expect(issues).toEqual([]);
    }
  });
});
