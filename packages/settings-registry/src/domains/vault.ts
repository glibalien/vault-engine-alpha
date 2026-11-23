import type { SettingDescriptor } from '../types.js';

/**
 * The vault's vocabulary: the names the suite expects in a user's notes (`Settings/Vault.md`).
 * A kind or field set to `null` is "none": whatever depends on it is off. Read it with
 * `vaultSettingsFrom` (MCP clients) or the Engine's `getVaultSettings`; see the README.
 */
export interface VaultSettings {
  // Kinds of notes (node types).
  projectType: string | null; taskType: string | null; meetingType: string | null;
  personType: string | null; companyType: string | null; journalType: string | null;
  topicType: string | null; wikiType: string | null; transcriptType: string | null;
  dailyNoteType: string | null;
  /** The kinds whose notes memories can be about (#554). Null: the person, company and project
   *  kinds above (`entityKinds` reads it). A list replaces them; `[]` is none. */
  entityTypes: string[] | null;
  /** The vault owner's own person note (#554): memories are the owner's, so the owner is never
   *  made a memory's subject except by the owner's own edit. Null: none set. */
  ownerNote: string | null;
  // Fields.
  dueField: string | null; dateField: string | null; peopleField: string | null;
  companyField: string | null; priorityField: string | null; scheduledField: string | null;
  wikiFlagField: string | null;
  // Status meaning, separately for projects and tasks.
  projectStatusField: string | null;
  projectActiveStatuses: string[]; projectDoneStatuses: string[]; projectBlockedStatuses: string[];
  projectBacklogStatuses: string[]; projectIgnoredStatuses: string[];
  taskStatusField: string | null;
  taskActiveStatuses: string[]; taskDoneStatuses: string[]; taskBlockedStatuses: string[];
  taskBacklogStatuses: string[]; taskIgnoredStatuses: string[];
  taskTickStatus: string; taskUntickStatus: string;
  // Folders. The settings and attachments folders are set at install (VAULT_SETTINGS_DIR,
  // VAULT_ATTACHMENT_DIR) and reported by get-settings, not stored here.
  wikiDir: string; topicDir: string | null; transcriptDir: string;
}

export type VaultKey = keyof VaultSettings;

const D = 'vault' as const;
const NONE = 'Empty = none:';
const name = (key: VaultKey, dflt: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string', nonEmpty: true, nullable: true }, default: dflt, reload: 'next-use',
     description: `${description} ${NONE} ${offText(key)}` });
const list = (key: VaultKey, dflt: string[], description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string-list' }, default: dflt, reload: 'next-use', description });
const value = (key: VaultKey, dflt: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string', nonEmpty: true }, default: dflt, reload: 'next-use', description });
const folder = (key: VaultKey, dflt: string, description: string): SettingDescriptor =>
  ({ key, domain: D, type: { kind: 'string', nonEmpty: true }, default: dflt, reload: 'next-use', description });

function offText(key: VaultKey): string {
  return VAULT_KIND_KEYS.includes(key) ? 'no note is treated as this kind.' : 'nothing reads or writes this field.';
}

/**
 * The kinds whose notes memories can be about (#554): the vault map's `entityTypes` when it is
 * set, else its person, company and project kinds, each when it is not none.
 */
export function entityKinds(vault: Pick<VaultSettings, 'entityTypes' | 'personType' | 'companyType' | 'projectType'>): string[] {
  if (vault.entityTypes !== null) return [...new Set(vault.entityTypes)];
  return [...new Set([vault.personType, vault.companyType, vault.projectType].filter((type): type is string => type !== null))];
}

/** The keys that name a kind of note (a type). Each is `string | null`; null is none. */
export const VAULT_KIND_KEYS: readonly VaultKey[] = [
  'projectType', 'taskType', 'meetingType', 'personType', 'companyType',
  'journalType', 'topicType', 'wikiType', 'transcriptType', 'dailyNoteType',
];

/** The keys that name a field. Each is `string | null`; null is none. */
export const VAULT_FIELD_KEYS: readonly VaultKey[] = [
  'dueField', 'dateField', 'peopleField', 'companyField', 'priorityField', 'scheduledField',
  'wikiFlagField', 'projectStatusField', 'taskStatusField',
];

/**
 * Kinds and fields the suite creates on first use (wiki pages, topic notes, transcripts,
 * the journal, the wiki request flag), so a vault that lacks them yet is not misconfigured.
 * Engine's missing-name warning skips them.
 */
export const VAULT_SELF_CREATED_KEYS: readonly VaultKey[] = [
  'wikiType', 'topicType', 'transcriptType', 'journalType', 'wikiFlagField',
];

export const VAULT_DESCRIPTORS: SettingDescriptor[] = [
  // --- Kinds of notes ---
  name('projectType', 'project', 'Kind (type) of a project note. Project wikis, project evidence and memory filing read it.'),
  name('taskType', 'task', 'Kind of a task note. Wiki task groups read it.'),
  name('meetingType', 'meeting', 'Kind of a meeting note. Wiki meeting evidence reads it.'),
  name('personType', 'person', 'Kind of a person note. Wiki contacts read it.'),
  name('companyType', 'company', 'Kind of a company note. Wiki contacts read it.'),
  name('journalType', 'note', 'Kind of the notes Curator writes itself: its journal and the notes it captures from chats.'),
  name('topicType', 'topic', 'Kind of the topic notes topic wikis are built on.'),
  name('wikiType', 'wiki', 'Kind of the wiki pages Engine writes.'),
  name('transcriptType', 'transcript', 'Kind of the transcript notes Engine makes from recordings.'),
  name('dailyNoteType', 'daily-note', 'Kind of a daily note. Search ranks daily notes, like meetings and transcripts, a little below other notes that match a question as well.'),
  { key: 'ownerNote', domain: D, type: { kind: 'string', nonEmpty: true, nullable: true }, default: null, reload: 'next-use',
    description: 'Your own person note, by its title (e.g. Dana Whitfield). Memories are yours, so you are left out of their subjects: a sweep, a tool or the subject backfill never links a memory to this note; you still can, in the memory note. Empty = none set.' },
  { key: 'entityTypes', domain: D, type: { kind: 'string-list', nullable: true }, default: null, reload: 'next-use',
    description: 'Kinds whose notes memories can be about: a memory\'s subjects link only to notes of these kinds. Empty = the person, company and project kinds above. To add a kind (a pet, a vehicle, a product), list every kind, e.g. [person, company, project, pet]. [] = none: no memory links to a note.' },
  // --- Fields ---
  name('dueField', 'due', 'Field holding a task\'s due date.'),
  name('dateField', 'date', 'Field holding a meeting\'s or note\'s date.'),
  name('peopleField', 'people involved', 'Field linking a note to people.'),
  name('companyField', 'company', 'Field linking a note to a company.'),
  name('priorityField', 'priority', 'Field holding a task\'s priority.'),
  name('scheduledField', 'scheduled', 'Field holding the date a task is scheduled for.'),
  name('wikiFlagField', 'wiki', 'Field a project note sets to true to ask Curator for a project wiki.'),
  // --- Status meaning: projects ---
  name('projectStatusField', 'status', 'Field holding a project\'s status.'),
  list('projectActiveStatuses', ['open', 'in-progress'], 'Project statuses that count as active. Curator\'s nightly sweep curates the wikis of these projects.'),
  list('projectDoneStatuses', ['done'], 'Project statuses that count as done.'),
  list('projectBlockedStatuses', ['blocked'], 'Project statuses that count as blocked.'),
  list('projectBacklogStatuses', ['backlog'], 'Project statuses that count as backlog.'),
  list('projectIgnoredStatuses', ['dropped'], 'Project statuses that are ignored (dropped work).'),
  // --- Status meaning: tasks ---
  name('taskStatusField', 'status', 'Field holding a task\'s status.'),
  list('taskActiveStatuses', ['open', 'in-progress'], 'Task statuses that count as open work.'),
  list('taskDoneStatuses', ['done'], 'Task statuses that count as done.'),
  list('taskBlockedStatuses', ['blocked'], 'Task statuses that count as blocked.'),
  list('taskBacklogStatuses', ['backlog'], 'Task statuses that count as backlog.'),
  list('taskIgnoredStatuses', ['dropped'], 'Task statuses left out of wiki task groups.'),
  value('taskTickStatus', 'done', 'Status value written when a task is ticked off in a list.'),
  value('taskUntickStatus', 'open', 'Status value written when a ticked task is unticked.'),
  // --- Folders ---
  folder('wikiDir', 'Wikis', 'Folder where Engine writes wiki pages, and where Curator keeps its monthly journal note.'),
  { key: 'topicDir', domain: D, type: { kind: 'string', nonEmpty: true, nullable: true }, default: null, reload: 'next-use',
    description: 'Folder for the topic notes that topic wikis are built on. Empty = the topic kind\'s own folder (Topics/ when Curator creates the kind). Applies to topics created after a change; existing topic notes stay where they are.' },
  folder('transcriptDir', 'Transcripts', 'Folder for transcript notes.'),
];

/** An older key that still reads and writes one vault key. */
export interface VaultAlias {
  readonly domain: 'wiki' | 'curator';
  readonly key: string;
  readonly vaultKey: VaultKey;
}

/**
 * Keys that moved to the vault domain. Each still works under its old domain, one to one:
 * get-settings reports the vault value under the old name, and update-settings or an edit of
 * the old note writes the vault key. Nothing is stored under the old name.
 */
export const VAULT_ALIASES: readonly VaultAlias[] = [
  { domain: 'wiki', key: 'projectType', vaultKey: 'projectType' },
  { domain: 'wiki', key: 'taskType', vaultKey: 'taskType' },
  { domain: 'wiki', key: 'meetingType', vaultKey: 'meetingType' },
  { domain: 'wiki', key: 'personType', vaultKey: 'personType' },
  { domain: 'wiki', key: 'companyType', vaultKey: 'companyType' },
  { domain: 'wiki', key: 'wikiType', vaultKey: 'wikiType' },
  { domain: 'wiki', key: 'dueField', vaultKey: 'dueField' },
  { domain: 'wiki', key: 'peopleField', vaultKey: 'peopleField' },
  { domain: 'wiki', key: 'companyField', vaultKey: 'companyField' },
  { domain: 'wiki', key: 'statusField', vaultKey: 'taskStatusField' },
  { domain: 'wiki', key: 'statusOpen', vaultKey: 'taskActiveStatuses' },
  { domain: 'wiki', key: 'statusDone', vaultKey: 'taskDoneStatuses' },
  { domain: 'wiki', key: 'statusBlocked', vaultKey: 'taskBlockedStatuses' },
  { domain: 'wiki', key: 'statusIgnored', vaultKey: 'taskIgnoredStatuses' },
  { domain: 'wiki', key: 'statusBacklog', vaultKey: 'taskBacklogStatuses' },
  { domain: 'wiki', key: 'wikiDir', vaultKey: 'wikiDir' },
  { domain: 'curator', key: 'topicDir', vaultKey: 'topicDir' },
  { domain: 'curator', key: 'projectStatusField', vaultKey: 'projectStatusField' },
  { domain: 'curator', key: 'activeStatuses', vaultKey: 'projectActiveStatuses' },
];
