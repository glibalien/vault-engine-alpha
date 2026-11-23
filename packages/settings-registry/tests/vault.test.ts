import { describe, expect, it } from 'vitest';
import {
  DOMAINS, VAULT_ALIASES, VAULT_FIELD_KEYS, VAULT_KIND_KEYS, defaultsFor, descriptorsFor,
  deviationsOnly, entityKinds, validateDomainPatch, vaultAliasFor, vaultAliasValues, vaultAliasesOf, vaultSettingsFrom,
} from '../src/index.js';
import type { VaultSettings } from '../src/index.js';

describe('vault domain', () => {
  it('is registered with today\'s names as defaults', () => {
    expect(DOMAINS).toContain('vault');
    expect(defaultsFor('vault')).toEqual({
      projectType: 'project', taskType: 'task', meetingType: 'meeting', personType: 'person',
      companyType: 'company', journalType: 'note', topicType: 'topic', wikiType: 'wiki',
      transcriptType: 'transcript', dailyNoteType: 'daily-note', entityTypes: null, ownerNote: null,
      dueField: 'due', dateField: 'date', peopleField: 'people involved', companyField: 'company',
      priorityField: 'priority', scheduledField: 'scheduled', wikiFlagField: 'wiki',
      projectStatusField: 'status',
      projectActiveStatuses: ['open', 'in-progress'], projectDoneStatuses: ['done'],
      projectBlockedStatuses: ['blocked'], projectBacklogStatuses: ['backlog'], projectIgnoredStatuses: ['dropped'],
      taskStatusField: 'status',
      taskActiveStatuses: ['open', 'in-progress'], taskDoneStatuses: ['done'],
      taskBlockedStatuses: ['blocked'], taskBacklogStatuses: ['backlog'], taskIgnoredStatuses: ['dropped'],
      taskTickStatus: 'done', taskUntickStatus: 'open',
      wikiDir: 'Wikis', topicDir: null, transcriptDir: 'Transcripts',
    } satisfies VaultSettings);
  });

  it('reads the kinds memories can be about: the person, company and project kinds unless listed (#554)', () => {
    const vault = defaultsFor('vault') as unknown as VaultSettings;
    expect(entityKinds(vault)).toEqual(['person', 'company', 'project']);
    expect(entityKinds({ ...vault, personType: 'contact', companyType: null })).toEqual(['contact', 'project']);
    expect(entityKinds({ ...vault, entityTypes: ['person', 'pet', 'pet'] })).toEqual(['person', 'pet']);
    expect(entityKinds({ ...vault, entityTypes: [] })).toEqual([]);
    expect(validateDomainPatch('vault', { entityTypes: null }).issues).toEqual([]);
    expect(validateDomainPatch('vault', { entityTypes: ['pet'] }).issues).toEqual([]);
    expect(validateDomainPatch('vault', { entityTypes: [' '] }).issues).toHaveLength(1);
  });

  it('accepts null (none) for every kind and field, and rejects an empty name', () => {
    for (const key of [...VAULT_KIND_KEYS, ...VAULT_FIELD_KEYS]) {
      expect(validateDomainPatch('vault', { [key]: null }).issues, key).toEqual([]);
      expect(validateDomainPatch('vault', { [key]: ' ' }).issues, key).toHaveLength(1);
    }
    // A none that differs from the default is a stored deviation.
    expect(deviationsOnly('vault', { projectType: null, topicDir: null })).toEqual({ projectType: null });
  });

  it('does not allow none for status values or the wiki and transcript folders', () => {
    for (const key of ['taskTickStatus', 'taskUntickStatus', 'wikiDir', 'transcriptDir']) {
      expect(validateDomainPatch('vault', { [key]: null }).issues, key).toHaveLength(1);
    }
    expect(validateDomainPatch('vault', { taskDoneStatuses: [] }).issues).toEqual([]);
    expect(validateDomainPatch('vault', { taskDoneStatuses: ['done', ''] }).issues).toHaveLength(1);
  });

  it('kind and field lists name nullable vault descriptors', () => {
    const byKey = new Map(descriptorsFor('vault').map(d => [d.key, d]));
    for (const key of [...VAULT_KIND_KEYS, ...VAULT_FIELD_KEYS]) {
      expect(byKey.get(key)?.type, key).toMatchObject({ kind: 'string', nonEmpty: true, nullable: true });
    }
  });
});

describe('vault aliases', () => {
  it('map every old wiki and curator vocabulary key one to one onto a vault key', () => {
    const vaultKeys = new Set(descriptorsFor('vault').map(d => d.key));
    for (const alias of VAULT_ALIASES) {
      expect(vaultKeys.has(alias.vaultKey), alias.key).toBe(true);
      expect(descriptorsFor(alias.domain).some(d => d.key === alias.key), alias.key).toBe(false);
    }
    expect(vaultAliasesOf('wiki').map(a => a.key)).toEqual([
      'projectType', 'taskType', 'meetingType', 'personType', 'companyType', 'wikiType',
      'dueField', 'peopleField', 'companyField', 'statusField', 'statusOpen', 'statusDone',
      'statusBlocked', 'statusIgnored', 'statusBacklog', 'wikiDir',
    ]);
    expect(vaultAliasesOf('curator').map(a => [a.key, a.vaultKey])).toEqual([
      ['topicDir', 'topicDir'],
      ['projectStatusField', 'projectStatusField'],
      ['activeStatuses', 'projectActiveStatuses'],
    ]);
    expect(vaultAliasFor('wiki', 'statusField')?.vaultKey).toBe('taskStatusField');
    expect(vaultAliasFor('wiki', 'subpageCap')).toBeUndefined();
    expect(vaultAliasFor('engine', 'projectType')).toBeUndefined();
  });

  it('reports vault values under the old names', () => {
    const vault = { ...defaultsFor('vault'), projectType: null, taskStatusField: 'state' } as unknown as VaultSettings;
    expect(vaultAliasValues('wiki', vault)).toMatchObject({ projectType: null, statusField: 'state', wikiDir: 'Wikis' });
    expect(vaultAliasValues('curator', vault)).toEqual({
      topicDir: null, projectStatusField: 'status', activeStatuses: ['open', 'in-progress'],
    });
  });
});

describe('vaultSettingsFrom', () => {
  it('reads the vault domain of a get-settings payload, keeping none and filling gaps', () => {
    const vault = vaultSettingsFrom({
      vault: { effective: { projectType: null, taskType: 'todo', dueField: 7, wikiDir: 'Pages' } },
      wiki: { effective: { projectType: 'ignored' } },
    });
    expect(vault.projectType).toBeNull();
    expect(vault.taskType).toBe('todo');
    expect(vault.dueField).toBe('due');          // malformed value: default
    expect(vault.wikiDir).toBe('Pages');
    expect(vault.meetingType).toBe('meeting');   // missing: default
  });

  it('reads an older Engine\'s wiki and curator keys when it reports no vault domain', () => {
    const vault = vaultSettingsFrom({
      wiki: { effective: { projectType: 'initiative', statusField: 'state', statusDone: ['closed'], wikiDir: 'W' } },
      curator: { effective: { projectStatusField: 'stage', activeStatuses: ['live'], topicDir: 'T' } },
    });
    expect(vault).toMatchObject({
      projectType: 'initiative', taskStatusField: 'state', taskDoneStatuses: ['closed'], wikiDir: 'W',
      projectStatusField: 'stage', projectActiveStatuses: ['live'], topicDir: 'T',
      projectDoneStatuses: ['done'],
    });
  });

  it('returns the defaults for a missing payload', () => {
    expect(vaultSettingsFrom(undefined)).toEqual(defaultsFor('vault'));
    expect(vaultSettingsFrom({ vault: null })).toEqual(defaultsFor('vault'));
  });
});
