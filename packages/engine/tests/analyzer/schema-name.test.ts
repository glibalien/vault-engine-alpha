import { describe, expect, it } from 'vitest';
import {
  isApplySafeSchemaName,
  portableSchemaNameKey,
} from '../../src/analyzer/schema-name.js';

describe('isApplySafeSchemaName', () => {
  it.each(['project', 'Project Notes', 'release.'])(
    'accepts a portable schema stem: %s',
    (name) => expect(isApplySafeSchemaName(name)).toBe(true),
  );

  it.each([
    '.', '..', '_fields', '_internal', '../../escape', 'nested/type',
    'nested\\type', 'CON', 'nul.txt', 'bad:name', `bad\u0000name`,
  ])('rejects an unsafe or Engine-reserved schema stem: %s', (name) => {
    expect(isApplySafeSchemaName(name)).toBe(false);
  });

  it.each(['COM¹', 'COM².txt', 'COM³', 'LPT¹', 'LPT².yaml', 'LPT³'])
    ('rejects the Unicode superscript Windows device alias: %s', (name) => {
      expect(isApplySafeSchemaName(name)).toBe(false);
    });

  it('rejects a final schema filename longer than one portable component', () => {
    expect(isApplySafeSchemaName('x'.repeat(251))).toBe(false);
  });
});

describe('portableSchemaNameKey', () => {
  it('folds case and canonical Unicode normalization', () => {
    expect(portableSchemaNameKey('Project')).toBe(portableSchemaNameKey('project'));
    expect(portableSchemaNameKey('Caf\u00e9')).toBe(portableSchemaNameKey('Cafe\u0301'));
    expect(portableSchemaNameKey('\u03a3')).toBe(portableSchemaNameKey('\u03c2'));
  });
});
