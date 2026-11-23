import { describe, expect, it } from 'vitest';
import {
  DOMAINS, SETTINGS_GROUPS, descriptorsFor, settingsNoteLabel, settingsNoteOfKey, settingsNotePath,
  settingsNoteTitle, settingsNotesOf, settingsNotesForKeys, settingsNoteForIssue,
} from '../src/index.js';

describe('settings notes (#746)', () => {
  it('shows every setting in exactly one note, and no note lists a key that is not a setting', () => {
    for (const domain of DOMAINS) {
      const known = descriptorsFor(domain).map(d => d.key).sort();
      const shown = settingsNotesOf(domain).flatMap(note => note.keys);
      expect(shown.slice().sort()).toEqual(known);
      expect(new Set(shown).size).toBe(shown.length);
    }
    // A group list names each key itself: a key no group lists would land in General
    // only by the fallback, which is for keys added in a hurry, not a place to keep them.
    for (const [domain, groups] of Object.entries(SETTINGS_GROUPS)) {
      const listed = groups!.flatMap(g => g.keys).sort();
      expect(listed).toEqual(descriptorsFor(domain as never).map(d => d.key).sort());
    }
  });

  it('gives the grouped domains a folder and the rest one note', () => {
    expect(settingsNotesOf('curator').map(n => n.group)).toEqual(
      ['General', 'Models', 'Wikis', 'Memories', 'Conversation capture', 'Organization', 'Prompts']);
    expect(settingsNotesOf('engine').map(n => n.group)).toEqual(
      ['General', 'Models', 'Backups and retention', 'Provenance']);
    for (const domain of ['chat', 'wiki', 'vault'] as const) {
      expect(settingsNotesOf(domain).map(n => n.group)).toEqual([null]);
    }
    expect(settingsNotePath('Settings', { domain: 'curator', group: 'Models' })).toBe('Settings/Curator/Models.md');
    expect(settingsNotePath('Config', { domain: 'chat', group: null })).toBe('Config/Chat.md');
    expect(settingsNoteTitle({ domain: 'engine', group: 'Backups and retention' })).toBe('Backups and retention');
    expect(settingsNoteTitle({ domain: 'wiki', group: null })).toBe('Wiki');
  });

  it('keeps each job\'s model, token cap and reasoning in the Models note', () => {
    const models = settingsNoteOfKey('curator', 'model')!;
    expect(models.group).toBe('Models');
    for (const d of descriptorsFor('curator')) {
      if (d.type.kind === 'model-ref' || /MaxTokens$|Reasoning(Effort|Budget)$|^reasoningEffort$/.test(d.key)) {
        expect(settingsNoteOfKey('curator', d.key)?.group, d.key).toBe('Models');
      }
      if (/Prompt$/.test(d.key)) expect(settingsNoteOfKey('curator', d.key)?.group, d.key).toBe('Prompts');
    }
    // A text setting that is no prompt stays with its feature.
    expect(settingsNoteOfKey('curator', 'dossierSections')?.group).toBe('Wikis');
    expect(settingsNoteOfKey('curator', 'nope')).toBeNull();
  });

  it('lists the notes a write changes', () => {
    expect(settingsNotesForKeys('curator', ['model', 'linkSweepMode', 'wikiHomeModel']).map(n => n.group))
      .toEqual(['Models', 'Organization']);
    // An unknown key or an old vault name goes to the first note; no keys means every note.
    expect(settingsNotesForKeys('curator', ['activeStatuses']).map(n => n.group)).toEqual(['General']);
    expect(settingsNotesForKeys('engine', []).length).toBe(4);
    expect(settingsNotesForKeys('chat', ['maxSteps']).map(n => n.group)).toEqual([null]);
    expect(settingsNoteForIssue('engine', 'frontmatter').group).toBe('General');
  });

  it('names where a setting is edited', () => {
    expect(settingsNoteLabel('curator', 'linkSweepMode')).toBe('Settings/Curator/Organization.md');
    expect(settingsNoteLabel('curator')).toBe('Settings/Curator/');
    expect(settingsNoteLabel('curator', 'unknownKey')).toBe('Settings/Curator/');
    expect(settingsNoteLabel('chat', 'maxSteps')).toBe('Settings/Chat.md');
    expect(settingsNoteLabel('engine', 'backupKeep', 'Config')).toBe('Config/Engine/Backups and retention.md');
  });
});
