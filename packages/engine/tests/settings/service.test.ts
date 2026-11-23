import { describe, expect, it, vi } from 'vitest';
import { normalizeModelRef, settingsNotesOf } from '@vault/settings-registry';
import type { ModelCatalogEntry } from '@vault/settings-registry';
import { createTestDb } from '../helpers/db.js';
import { SettingsService } from '../../src/settings/service.js';
import { noteFor } from '../helpers/settings-notes.js';

function svc() { return new SettingsService(createTestDb(), { settingsDir: 'Settings' }); }

/** Build a minimal catalog entry for the resolver hook (fireworks + enabled by default). */
const entry = (title: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry =>
  ({ title, provider: 'fireworks', model: 'm', enabled: true, ...extra });

describe('SettingsService', () => {
  it('serves defaults before any write, live snapshot after apply', () => {
    const s = svc();
    expect(s.engine().backupKeep).toBe(7);
    const r = s.applyPatch('engine', { backupKeep: 3 });
    expect(r).toMatchObject({ applied: ['backupKeep'], changed: true });
    expect(s.engine().backupKeep).toBe(3);
    expect(s.stored('engine')).toEqual({ backupKeep: 3 });
    expect(s.version('engine')).toBe(1);
  });

  it('rejects invalid keys individually, keeps last-good live', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    const r = s.applyPatch('engine', { backupKeep: 0, normalizeCron: '0 3 * * *' });
    expect(r.applied).toEqual(['normalizeCron']);
    expect(r.issues).toHaveLength(1);
    expect(s.engine().backupKeep).toBe(3);              // last-good
    expect(s.engine().normalizeCron).toBe('0 3 * * *'); // valid part applied
    expect(s.issues('engine')).toHaveLength(1);
  });

  it('null in a patch resets the key to default', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    const r = s.applyPatch('engine', { backupKeep: null });
    expect(r.changed).toBe(true);
    expect(s.engine().backupKeep).toBe(7);
    expect(s.stored('engine')).toEqual({});
  });

  it('replaceFromFile treats absent keys as reset and preserves last-good on invalid', () => {
    // A note is a snapshot of the keys it shows (#746): Backups and retention here.
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3, backupIntervalHours: 12, normalizeQuiescenceMinutes: 30 });
    const r = s.replaceFromFile(noteFor('engine', 'backupKeep'), { backupKeep: 'bogus', editsLogRetentionDays: 30 });
    expect(s.engine().backupKeep).toBe(3);               // invalid → last-good survives
    expect(s.engine().backupIntervalHours).toBe(24);     // absent → reset
    expect(s.engine().editsLogRetentionDays).toBe(30);
    expect(s.engine().normalizeQuiescenceMinutes).toBe(30); // another note's key keeps its value
    expect(r.issues.map(i => i.key)).toEqual(['backupKeep']);
  });

  it('replaceFromFile does not apply a key another note shows, and names that note', () => {
    const s = svc();
    s.applyPatch('engine', { normalizeCron: '0 3 * * *' });
    const r = s.replaceFromFile(noteFor('engine', 'backupKeep'), { backupKeep: 3, normalizeCron: '0 4 * * *' });
    expect(s.engine().backupKeep).toBe(3);
    expect(s.engine().normalizeCron).toBe('0 3 * * *');
    expect(r.issues).toEqual([expect.objectContaining({ key: 'normalizeCron', code: 'SETTINGS_UNKNOWN_KEY' })]);
    expect(r.issues[0]!.message).toContain('Settings/Engine/General.md');
    expect(s.noteIssues(noteFor('engine', 'backupKeep')).map(i => i.key)).toEqual(['normalizeCron']);
    expect(s.noteIssues(noteFor('engine', 'normalizeCron'))).toEqual([]);
  });

  it('rejects excludeDirs covering the settings folder', () => {
    const s = svc();
    const r = s.applyPatch('engine', { excludeDirs: ['Settings'] });
    expect(r.applied).toEqual([]);
    expect(r.issues[0]).toMatchObject({ key: 'excludeDirs', code: 'SETTINGS_INVALID_VALUE' });
    expect(s.engine().excludeDirs).toEqual([]);
  });

  it('fires onChange per domain only when something changed', () => {
    const s = svc();
    const cb = vi.fn();
    s.onChange('engine', cb);
    s.applyPatch('engine', { backupKeep: 3 });
    s.applyPatch('engine', { backupKeep: 3 });           // no-op, values identical
    s.applyPatch('wiki', { wikiDir: 'Wiki' });           // other domain
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('replaceFromFile with identical values in different key order is a no-op', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    s.applyPatch('engine', { backupIntervalHours: 12 });
    const v = s.version('engine');
    const cb = vi.fn();
    s.onChange('engine', cb);
    s.replaceFromFile(noteFor('engine', 'backupKeep'), { backupIntervalHours: 12, backupKeep: 3 });
    expect(s.version('engine')).toBe(v);
    expect(cb).not.toHaveBeenCalled();
  });

  it('rejects excludeDirs covering the settings folder with a trailing slash', () => {
    const s = svc();
    const r = s.applyPatch('engine', { excludeDirs: ['Settings/'] });
    expect(r.applied).toEqual([]);
    expect(r.issues[0]).toMatchObject({ key: 'excludeDirs', code: 'SETTINGS_INVALID_VALUE' });
    expect(s.engine().excludeDirs).toEqual([]);
  });

  it('no-op replaceFromFile does not bump the version', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    const v = s.version('engine');
    s.replaceFromFile(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    expect(s.version('engine')).toBe(v);
  });

  it('a value equal to the registry default is not stored (deviations only)', () => {
    const s = svc();
    const r = s.applyPatch('engine', { backupKeep: 7 });   // 7 is the default
    expect(r.changed).toBe(false);
    expect(s.stored('engine')).toEqual({});
  });

  it('replaceFromFile of a fully-materialized canonical file stores only deviations', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    const effective = s.effective('engine');                // all keys, one deviation
    const v = s.version('engine');
    // Every note of the domain, each materializing the keys it shows.
    for (const note of settingsNotesOf('engine')) {
      const canonical = Object.fromEntries(note.keys.map(key => [key, effective[key]]));
      const r = s.replaceFromFile(note, canonical);
      expect(r.changed).toBe(false);
      expect(r.issues).toEqual([]);
    }
    expect(s.version('engine')).toBe(v);
    expect(s.stored('engine')).toEqual({ backupKeep: 3 });
  });

  it('setting a stored key back to its default clears it from stored', () => {
    const s = svc();
    s.applyPatch('engine', { backupKeep: 3 });
    const r = s.applyPatch('engine', { backupKeep: 7 });
    expect(r.changed).toBe(true);
    expect(s.stored('engine')).toEqual({});
    expect(s.engine().backupKeep).toBe(7);
  });

  it('null on an unknown key surfaces SETTINGS_UNKNOWN_KEY instead of silently no-oping', () => {
    const s = svc();
    const r = s.applyPatch('engine', { nonsense: null });
    expect(r.changed).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ key: 'nonsense', code: 'SETTINGS_UNKNOWN_KEY' });
  });

  it('a throwing change listener does not block later listeners nor make applyPatch throw', () => {
    const s = svc();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    s.onChange('engine', () => { order.push('first'); throw new Error('boom'); });
    s.onChange('engine', () => { order.push('second'); });
    expect(() => s.applyPatch('engine', { backupKeep: 3 })).not.toThrow();
    expect(order).toEqual(['first', 'second']);
    spy.mockRestore();
  });

  it('rejects unresolvable model-refs contextually, keeping last-good', () => {
    const s = svc();
    s.setModelRefResolver((ref) => normalizeModelRef(ref) === 'Qwen 3.7 Plus' ? entry('Qwen 3.7 Plus') : null);
    expect(s.applyPatch('engine', { memoryConsolidationModel: '[[Qwen 3.7 Plus]]' }).applied).toEqual(['memoryConsolidationModel']);
    const r = s.applyPatch('engine', { memoryConsolidationModel: '[[Ghost]]' });
    expect(r.issues[0]).toMatchObject({ code: 'SETTINGS_MODEL_REF_UNRESOLVED' });
    expect(s.engine().memoryConsolidationModel).toBe('[[Qwen 3.7 Plus]]');   // last-good
  });

  it('no resolver set → shape-valid refs pass (boot ordering safety)', () => {
    const s = svc();
    const r = s.applyPatch('engine', { memoryConsolidationModel: '[[Whatever]]' });
    expect(r.applied).toEqual(['memoryConsolidationModel']);
    expect(r.issues).toEqual([]);
    expect(s.engine().memoryConsolidationModel).toBe('[[Whatever]]');
  });

  it('a resolver rejection does not touch other valid keys in the same patch', () => {
    const s = svc();
    s.setModelRefResolver((ref) => normalizeModelRef(ref) === 'Qwen 3.7 Plus' ? entry('Qwen 3.7 Plus') : null);
    const r = s.applyPatch('engine', { backupKeep: 3, memoryConsolidationModel: '[[Ghost]]' });
    expect(r.applied).toEqual(['backupKeep']);
    expect(r.issues).toHaveLength(1);
    expect(s.engine().backupKeep).toBe(3);
    expect(s.engine().memoryConsolidationModel).toBe('[[Qwen 3.7 Plus]]'); // default, unchanged
  });

  it('replaceFromFile keeps last-good on an unresolvable model-ref (not just SETTINGS_INVALID_VALUE)', () => {
    // Regression (Task 4 review, Issue 1): the last-good restore loop used to
    // recognize only SETTINGS_INVALID_VALUE, so a SETTINGS_MODEL_REF_UNRESOLVED
    // rejection dropped the stored deviation and silently reverted the
    // effective value to the registry default.
    const s = svc();
    s.setModelRefResolver((ref) => normalizeModelRef(ref) === 'Ghost' ? null : entry(normalizeModelRef(ref)));
    s.applyPatch('engine', { memoryConsolidationModel: '[[Kimi K2.6]]' });
    const r = s.replaceFromFile(noteFor('engine', 'memoryConsolidationModel'), { memoryConsolidationModel: '[[Ghost]]' });
    expect(r.issues[0]).toMatchObject({ key: 'memoryConsolidationModel', code: 'SETTINGS_MODEL_REF_UNRESOLVED' });
    expect(s.engine().memoryConsolidationModel).toBe('[[Kimi K2.6]]');   // last-good, NOT the default
  });

  it('rejects a visionModel ref that resolves to a non-vision-capable model, keeping last-good', () => {
    const s = svc();
    s.setModelRefResolver((ref) => {
      const title = normalizeModelRef(ref);
      if (title === 'Seeing Eye') return entry('Seeing Eye', { provider: 'openrouter', vision: true });
      if (title === 'Text Only') return entry('Text Only', { vision: false });
      return null;
    });
    // A vision-capable openrouter ref is accepted.
    expect(s.applyPatch('engine', { visionModel: '[[Seeing Eye]]' }).applied).toEqual(['visionModel']);
    // A resolvable-but-non-vision ref is rejected with the reused issue code.
    const r = s.applyPatch('engine', { visionModel: '[[Text Only]]' });
    expect(r.applied).toEqual([]);
    expect(r.issues[0]).toMatchObject({ key: 'visionModel', code: 'SETTINGS_MODEL_REF_UNRESOLVED' });
    expect(r.issues[0]!.message).toBe('visionModel resolves to "Text Only" which is not marked vision-capable (vision: true)');
    expect(normalizeModelRef(s.engine().visionModel)).toBe('Seeing Eye');   // last-good
  });

  it('memoryConsolidationModel does NOT get the vision-capability check (only visionModel does)', () => {
    const s = svc();
    s.setModelRefResolver((ref) => entry(normalizeModelRef(ref), { vision: false }));
    // vision:false is fine for memoryConsolidationModel — no vision gate there.
    const r = s.applyPatch('engine', { memoryConsolidationModel: '[[Text Only]]' });
    expect(r.applied).toEqual(['memoryConsolidationModel']);
    expect(r.issues).toEqual([]);
  });

  it('a model-ref value that changes only in bracket-wrapping is not treated as a change', () => {
    // Mirrors what a settings-note re-ingest produces: the frontmatter parser
    // strips wikilink brackets on every read, so the same catalog reference
    // can arrive bracketed (API patch) or bare (file ingest). Neither should
    // spuriously bump the version or fire onChange.
    const s = svc();
    s.applyPatch('engine', { memoryConsolidationModel: '[[Custom Model]]' });
    const v = s.version('engine');
    const cb = vi.fn();
    s.onChange('engine', cb);
    s.applyPatch('engine', { memoryConsolidationModel: 'Custom Model' });
    expect(s.version('engine')).toBe(v);
    expect(cb).not.toHaveBeenCalled();
  });

  it('tracks prompt default hashes and stale text overrides', () => {
    const s = svc();
    expect(s.registerPromptDefaults('chat', { chatSystemPrompt: 'default v1' })).toMatchObject({ changed: true, applied: ['chatSystemPrompt'] });
    s.applyPatch('chat', { chatSystemPrompt: 'custom prompt' });
    expect(s.stalePrompts('chat')).toEqual(new Set());

    s.registerPromptDefaults('chat', { chatSystemPrompt: 'default v2' });
    expect(s.stalePrompts('chat')).toEqual(new Set(['chatSystemPrompt']));

    s.applyPatch('chat', { chatSystemPrompt: '   ' });
    expect(s.stored('chat')).toEqual({});
    expect(s.stalePrompts('chat')).toEqual(new Set());
  });

  it('registerPromptDefaults warns for non-text keys without rejecting valid prompt defaults', () => {
    const s = svc();
    const r = s.registerPromptDefaults('chat', { chatSystemPrompt: 'base', maxSteps: 'not a prompt' });
    expect(r.changed).toBe(true);
    expect(r.applied).toEqual(['chatSystemPrompt']);
    expect(r.issues[0]).toMatchObject({ key: 'maxSteps', code: 'SETTINGS_UNKNOWN_KEY' });
    expect(s.promptDefaults('chat')).toEqual({ chatSystemPrompt: 'base' });
  });
});
