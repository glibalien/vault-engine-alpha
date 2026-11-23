import { defaultsFor } from '@vault/settings-registry';
import type { AnalyzeReport } from './analyzer.js';
import type { CuratorPlan } from './curator-plan.js';
import { ROLES, STARTER_STATUS_VALUES, type Role } from './starter-types.js';
import type { StructurePlan } from './structure.js';
import { portableTypeKey } from './type-names.js';
import type { VaultPlan } from './vault.js';

/**
 * The vocabulary map the installer plans and writes to Engine's `vault` settings domain
 * (`Settings/Vault.md`): which type holds each kind of note, which field holds the status
 * of projects and of tasks and what its values mean, and the folders. Every designation
 * may be none. The functions here are pure, so a screen that proposes the whole map at
 * once can build on them.
 */

/** Kinds whose notes carry a status, each with its own status field and value meanings. */
export const STATUS_KINDS = ['project', 'task'] as const;
export type StatusKind = typeof STATUS_KINDS[number];

/** Status values grouped beyond the active ones. */
export interface StatusGroups {
  done: string[];
  blocked: string[];
  backlog: string[];
  ignored: string[];
}
export const STATUS_GROUPS = ['done', 'blocked', 'backlog', 'ignored'] as const;
export const NO_STATUS_GROUPS: StatusGroups = { done: [], blocked: [], backlog: [], ignored: [] };

/** A kind's status field: one the notes have, a new one the user chose to add, or none (null). */
export type StatusFieldChoice = { field: string; starter: boolean } | null;

/** A kind's status field and what its values mean; with no field, every list is empty. */
export interface StatusPlan {
  field: string | null;
  /** A field the plan adds, because the user chose a new one. */
  starter: boolean;
  active: string[];
  groups: StatusGroups;
}
export const NO_STATUS: StatusPlan = { field: null, starter: false, active: [], groups: NO_STATUS_GROUPS };

/** The kind Curator's journal writes unless the notes have one; Curator creates it when it first writes. */
export const DEFAULT_JOURNAL_TYPE = 'note';

const ROLE_PATTERNS: Record<Role, RegExp> = {
  project: /^projects?$/i,
  task: /^(tasks?|todos?)$/i,
  meeting: /^meetings?$/i,
  person: /^(person|people|persons|contacts?)$/i,
  company: /^(company|companies|organi[sz]ations?|orgs?)$/i,
};
const STATUS_FIELD_RE = /^(status|state|stage|phase)$/i;
const ACTIVE_STATUS_RE = /^(open|active|in[- ]?progress|doing|current|ongoing|started)$/i;
/** A task still to do is open work, where a project still to do is backlog. */
const OPEN_TASK_STATUS_RE = /^(to[- ]?do|next|pending)$/i;
const STATUS_GROUP_PATTERNS: Record<keyof StatusGroups, RegExp> = {
  done: /^(done|completed?|finished|closed|shipped|resolved)$/i,
  blocked: /^(blocked|waiting|on[- ]?hold|stalled|paused)$/i,
  backlog: /^(backlog|someday|later|planned|ideas?|not[- ]?started|to[- ]?do)$/i,
  ignored: /^(dropped|cancell?ed|abandoned|archived|obsolete|won'?t[- ]?do)$/i,
};

/**
 * A kind follows an explicit rename of its type first (`meeting` renamed to `call` still
 * holds meetings), so a name another kind's type was renamed to never takes it over.
 * Otherwise the kind is found by its type's name; with no such type it is none.
 */
export function detectRole(role: Role, typeNames: readonly string[], edits: Record<string, string | null>): string | null {
  const renameOf = (target: Role) => Object.entries(edits).find(([from]) => ROLE_PATTERNS[target].test(from));
  const own = renameOf(role);
  if (own && own[1] !== null && typeNames.includes(own[1])) return own[1];
  const takenByRename = new Set(ROLES.filter(other => other !== role)
    .map(other => renameOf(other)?.[1])
    .filter((name): name is string => typeof name === 'string'));
  return typeNames.find(name => ROLE_PATTERNS[role].test(name) && !takenByRename.has(name)) ?? null;
}

/** Fields that can hold a status: text values, as one string or one of a set. */
function textFields(analysis: AnalyzeReport | null) {
  return (analysis?.proposal.global_fields ?? []).filter(field => field.field_type === 'string' || field.field_type === 'enum');
}

/**
 * The fields offered as `type`'s status field, best first: text fields named like a status
 * that the type claims, then those any type claims, then the type's other text fields.
 */
export function statusFieldCandidates(analysis: AnalyzeReport | null, type: string | null): string[] {
  const claimed = new Set(analysis?.proposal.schemas.find(schema => schema.name === type)?.field_claims.map(claim => claim.field) ?? []);
  const text = textFields(analysis).map(field => field.name);
  return [
    ...text.filter(name => claimed.has(name) && STATUS_FIELD_RE.test(name)),
    ...text.filter(name => !claimed.has(name) && STATUS_FIELD_RE.test(name)),
    ...text.filter(name => claimed.has(name) && !STATUS_FIELD_RE.test(name)),
  ];
}

/**
 * The status field detected for a kind of type `type`: a text field named like a status,
 * or none. A new type the user asked for has no notes yet, so it comes with a new
 * `status` field unless the notes use that name in another shape.
 */
export function detectStatusField(analysis: AnalyzeReport | null, type: string | null, newType: boolean): StatusFieldChoice {
  if (type === null) return null;
  const named = statusFieldCandidates(analysis, type).find(name => STATUS_FIELD_RE.test(name));
  if (named !== undefined) return { field: named, starter: false };
  if (!newType || fieldNameTaken(analysis, 'status')) return null;
  return { field: 'status', starter: true };
}

/** Whether the notes use `name` as a field the plan cannot add a status field over. */
export function fieldNameTaken(analysis: AnalyzeReport | null, name: string): boolean {
  return (analysis?.proposal.global_fields ?? []).some(field => field.name === name)
    || (analysis?.needs_review.ambiguous_fields ?? []).some(field => field.name === name);
}

/** A status field's values; `restricted` when no other value can be stored (an enum). */
export interface StatusValues {
  values: string[];
  restricted: boolean;
  /** The Analyzer sampled only some of the values. */
  incomplete: boolean;
}

export function statusValues(analysis: AnalyzeReport | null, choice: NonNullable<StatusFieldChoice>): StatusValues {
  if (choice.starter) return { values: STARTER_STATUS_VALUES, restricted: true, incomplete: false };
  const field = analysis?.proposal.global_fields.find(candidate => candidate.name === choice.field);
  if (!field) return { values: [], restricted: false, incomplete: false };
  const values = field.enum_values ?? field.evidence.sample_values.filter((value): value is string => typeof value === 'string');
  return {
    values,
    restricted: field.field_type === 'enum',
    // Without an enum, the Analyzer lists only the first values it saw.
    incomplete: field.enum_values === undefined && field.evidence.samples_truncated,
  };
}

/** The values that mean active (for tasks: open), detected by name. */
export function detectActiveStatuses(values: readonly string[], kind: StatusKind): string[] {
  return values.filter(value => ACTIVE_STATUS_RE.test(value) || (kind === 'task' && OPEN_TASK_STATUS_RE.test(value)));
}

/** The other values grouped by name; no active value is in a group. */
export function detectStatusGroups(values: readonly string[], active: readonly string[]): StatusGroups {
  const others = values.filter(value => !active.includes(value));
  return Object.fromEntries(STATUS_GROUPS.map(group =>
    [group, others.filter(value => STATUS_GROUP_PATTERNS[group].test(value))])) as unknown as StatusGroups;
}

/** The kind a type named `note` (in any case) holds for Curator's journal, else a new `note`. */
export function detectJournalType(typeNames: readonly string[]): string {
  return typeNames.find(name => portableTypeKey(name) === portableTypeKey(DEFAULT_JOURNAL_TYPE)) ?? DEFAULT_JOURNAL_TYPE;
}

/** Type names a daily note goes by besides Engine's `daily-note`, ignoring case, spaces, `_` and `-`. */
const DAILY_NOTE_RE = /^(daily[\s_-]*(notes?|journal|log)?|dailies)$/i;

/** The kind of the notes' daily notes: `daily-note`, else a type named like one, else none (#572). */
export function detectDailyNoteType(typeNames: readonly string[]): string | null {
  return typeNames.find(name => name === 'daily-note') ?? typeNames.find(name => DAILY_NOTE_RE.test(name.trim())) ?? null;
}

/** The map's other field names, each a line the notes have or none. */
export const MAP_FIELDS = ['due', 'date', 'people', 'company', 'priority', 'scheduled'] as const;
export type MapField = typeof MAP_FIELDS[number];

/** Each field's key in the `vault` settings domain. */
export const MAP_FIELD_KEYS: Record<MapField, string> = {
  due: 'dueField',
  date: 'dateField',
  people: 'peopleField',
  company: 'companyField',
  priority: 'priorityField',
  scheduled: 'scheduledField',
};

/**
 * Names a field goes by, best first (Engine's default name first), matched ignoring case,
 * spaces, `_` and `-`.
 */
const FIELD_NAMES: Record<MapField, string[]> = {
  due: ['due', 'due date', 'deadline'],
  date: ['date', 'meeting date'],
  people: ['people involved', 'people', 'attendees', 'participants'],
  company: ['company', 'organization', 'organisation', 'org'],
  priority: ['priority', 'prio'],
  scheduled: ['scheduled', 'scheduled date', 'do date'],
};

function fieldNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** The lines the notes have, kept or not (`extra` adds those the plan creates), each once. */
export function fieldNamesOf(analysis: AnalyzeReport | null, extra: readonly string[] = []): string[] {
  return [...new Set([
    ...(analysis?.proposal.global_fields ?? []).map(field => field.name),
    ...(analysis?.needs_review.ambiguous_fields ?? []).map(field => field.name),
    ...extra,
  ])];
}

/** The line among `names` that holds `field`, found by name, or none. */
export function detectMapField(field: MapField, names: readonly string[]): string | null {
  for (const wanted of FIELD_NAMES[field]) {
    const match = names.find(name => name === wanted) ?? names.find(name => fieldNameKey(name) === wanted);
    if (match !== undefined) return match;
  }
  return null;
}

/** `names` that `field` goes by first (best first), then the rest: the order to offer them in. */
export function mapFieldCandidates(field: MapField, names: readonly string[]): string[] {
  const rank = (name: string) => {
    const index = FIELD_NAMES[field].indexOf(fieldNameKey(name));
    return index < 0 ? FIELD_NAMES[field].length : index;
  };
  return [...names].sort((left, right) => rank(left) - rank(right));
}

export function detectMapFields(names: readonly string[]): Record<MapField, string | null> {
  return Object.fromEntries(MAP_FIELDS.map(field => [field, detectMapField(field, names)])) as Record<MapField, string | null>;
}

/** What the notes say before any question: each designation's detected default. */
export interface ProposedVaultMap {
  kinds: Record<Role, string | null>;
  status: Record<StatusKind, StatusPlan>;
  fields: Record<MapField, string | null>;
  journalType: string;
}

/**
 * The map detected from the user's own notes: kinds found by type name (following
 * renames), each status kind's field named like a status with its values sorted by
 * meaning, the other field names found by name, and the journal kind. Nothing is a new
 * type or field, and a kind or field with no match is none.
 */
export function proposeVaultMap(input: { analysis: AnalyzeReport | null; renames: Record<string, string | null> }): ProposedVaultMap {
  const typeNames = input.analysis?.proposal.schemas.map(schema => schema.name) ?? [];
  const kinds = Object.fromEntries(ROLES.map(role => [role, detectRole(role, typeNames, input.renames)])) as Record<Role, string | null>;
  const status = Object.fromEntries(STATUS_KINDS.map(kind => {
    const choice = detectStatusField(input.analysis, kinds[kind], false);
    if (choice === null) return [kind, NO_STATUS];
    const { values } = statusValues(input.analysis, choice);
    const active = detectActiveStatuses(values, kind);
    return [kind, { field: choice.field, starter: false, active, groups: detectStatusGroups(values, active) }];
  })) as Record<StatusKind, StatusPlan>;
  return { kinds, status, fields: detectMapFields(fieldNamesOf(input.analysis)), journalType: detectJournalType(typeNames) };
}

// ---------------------------------------------------------------------------------------
// The planned map, as the plan JSON and the review state it.

/** Where a designated type comes from: the notes, a new starter type, or Curator on first use. */
export type KindSource = 'vault' | 'starter' | 'curator';
export const MAP_KINDS = [...ROLES, 'journal', 'dailyNote'] as const;
export type MapKind = typeof MAP_KINDS[number];

export interface VaultMapSummary {
  /** Each kind's type, or null for none. */
  kinds: Record<MapKind, { type: string | null; from: KindSource | null }>;
  /** Each status kind's field (null for none) and what its values mean. */
  status: Record<StatusKind, { field: string | null; from: 'vault' | 'starter' | null; active: string[] } & StatusGroups>;
  /** The map's other field names (due date, date, people, …), each null for none. */
  fields: Record<MapField, string | null>;
  /** Where wiki pages go, and Curator's topic notes (null without Curator: not set). */
  folders: { wiki_dir: string; topic_dir: string | null };
  /** What each none turns off. */
  off: string[];
}

const KIND_LABELS: Record<MapKind, string> = {
  project: 'projects',
  task: 'tasks',
  meeting: 'meetings',
  person: 'people',
  company: 'companies',
  journal: 'Curator\'s journal',
  dailyNote: 'daily notes',
};

const KIND_OFF: Record<Role, string> = {
  project: 'No project kind: Curator keeps no project wikis, and no note or memory is filed under a project.',
  task: 'No task kind: project wikis list no tasks.',
  meeting: 'No meeting kind: project wikis draw on no meeting notes.',
  person: 'No person kind: project wikis list no people.',
  company: 'No company kind: project wikis list no companies.',
};
const DAILY_NOTE_OFF = 'No daily-note kind: search ranks no note as a daily note.';
const STATUS_OFF: Record<StatusKind, string> = {
  project: 'Projects have no status field: Curator counts every project as active, and wikis show no project status.',
  task: 'Tasks have no status field: wikis cannot tell open tasks from finished ones.',
};
/** What each other field holds, in a few plain words. */
export const MAP_FIELD_LABELS: Record<MapField, string> = {
  due: 'due date',
  date: 'date',
  people: 'people',
  company: 'company',
  priority: 'priority',
  scheduled: 'scheduled date',
};
const FIELD_OFF: Record<MapField, string> = {
  due: 'No due-date field: wikis show no due dates.',
  date: 'No date field: nothing reads a meeting\'s or note\'s date from a field.',
  people: 'No people field: project wikis list no people linked from notes.',
  company: 'No company field: project wikis list no companies linked from notes.',
  priority: 'No priority field: nothing reads a task\'s priority.',
  scheduled: 'No scheduled-date field: nothing reads when a task is scheduled.',
};

/** The tick value a List view lacks, so it shows no checkbox (`taskCheckboxOff`). */
export type TickValueMissing = 'done' | 'open' | 'done or open';
const TICK_VALUES_MISSING: readonly TickValueMissing[] = ['done', 'open', 'done or open'];

const TASK_CHECKBOX_OFF = (field: string, missing: TickValueMissing) =>
  `The task status field ${field} has no ${missing} value: a List view shows each task's status, with no checkbox to tick it off.`;

/**
 * The tick value the map's `off` says the task status field lacks, read from that line rather
 * than worked out again (the review in short says it too), or null when `off` says nothing
 * about the checkbox.
 */
export function taskCheckboxOffIn(map: VaultMapSummary): TickValueMissing | null {
  const field = map.status.task.field;
  if (field === null) return null;
  return TICK_VALUES_MISSING.find(missing => map.off.includes(TASK_CHECKBOX_OFF(field, missing))) ?? null;
}

/** Engine's tick values, in force where the map writes none. */
const TICK_DEFAULTS = defaultsFor('vault') as { taskTickStatus: string; taskUntickStatus: string };

/**
 * The values ticking and unticking a task writes: the task status field's own done and open
 * values, `done` and `open` first. Each is undefined when the field has no such value; the map
 * then writes none and Engine's default stays in force (tick values are never none).
 */
export function taskTickValues(task: { active: readonly string[]; done: readonly string[] }): { tick?: string; untick?: string } {
  return {
    tick: task.done.includes('done') ? 'done' : task.done[0],
    untick: task.active.includes('open') ? 'open' : task.active[0],
  };
}

/**
 * Which tick value a List view could not use with this map, so it shows no checkbox (#488): the
 * view's own test (viz-ui `taskCheckboxOn`) on the tick values in force. The tick value must be
 * a done value, the untick value must not be, and a field that takes only its own values (an
 * enum) must take both, matched as Engine does (trimmed, ignoring case). Null when both work.
 */
export function taskCheckboxOff(task: { active: readonly string[]; done: readonly string[] }, field: StatusValues): TickValueMissing | null {
  const { tick = TICK_DEFAULTS.taskTickStatus, untick = TICK_DEFAULTS.taskUntickStatus } = taskTickValues(task);
  const takes = (value: string) => !field.restricted || field.values.some(own => own.toLowerCase() === value.trim().toLowerCase());
  const tickWorks = task.done.includes(tick) && takes(tick);
  const untickWorks = untick.trim() !== '' && !task.done.includes(untick) && takes(untick);
  return tickWorks && untickWorks ? null : tickWorks ? 'open' : untickWorks ? 'done' : 'done or open';
}

/**
 * The map an install writes: the structure stage's designations, the journal kind only
 * when Curator is installed (none otherwise), and the folders.
 */
export function buildVaultMap(vault: VaultPlan, structure: StructurePlan, curator: CuratorPlan | null): VaultMapSummary {
  const typeNames = new Set(structure.analysis?.proposal.schemas.map(schema => schema.name) ?? []);
  const kinds = Object.fromEntries(ROLES.map(role => {
    const type = structure.roles[role];
    return [role, { type, from: type === null ? null : typeNames.has(type) ? 'vault' : 'starter' }];
  })) as VaultMapSummary['kinds'];
  const journal = curator ? structure.journalType : null;
  const starterNames = new Set(structure.starterTypes.map(type => type.name));
  kinds.journal = {
    type: journal,
    from: journal === null ? null : typeNames.has(journal) ? 'vault' : starterNames.has(journal) ? 'starter' : 'curator',
  };
  // Daily notes are only ever a kind the notes have: nothing creates one.
  const dailyNote = detectDailyNoteType([...typeNames]);
  kinds.dailyNote = { type: dailyNote, from: dailyNote === null ? null : 'vault' };
  const status = Object.fromEntries(STATUS_KINDS.map(kind => {
    const plan = structure.roles[kind] === null ? NO_STATUS : structure.status[kind];
    return [kind, {
      field: plan.field,
      from: plan.field === null ? null : plan.starter ? 'starter' : 'vault',
      active: plan.active,
      ...plan.groups,
    }];
  })) as VaultMapSummary['status'];
  const fields = Object.fromEntries(MAP_FIELDS.map(field => [field, structure.fields[field]])) as Record<MapField, string | null>;
  // A task status field the List view cannot tick with: no checkbox, so say so.
  const task = status.task;
  const missing = task.field === null ? null
    : taskCheckboxOff(task, statusValues(structure.analysis, { field: task.field, starter: task.from === 'starter' }));
  const off = [
    ...ROLES.filter(role => kinds[role].type === null).map(role => KIND_OFF[role]),
    ...(dailyNote === null ? [DAILY_NOTE_OFF] : []),
    ...STATUS_KINDS.filter(kind => kinds[kind].type !== null && status[kind].field === null).map(kind => STATUS_OFF[kind]),
    ...(task.field !== null && missing !== null ? [TASK_CHECKBOX_OFF(task.field, missing)] : []),
    ...MAP_FIELDS.filter(field => fields[field] === null).map(field => FIELD_OFF[field]),
  ];
  return { kinds, status, fields, folders: { wiki_dir: vault.wikiDir, topic_dir: curator ? vault.topicDir : null }, off };
}

type SettingValue = string | string[] | null;

const STATUS_KEYS: Record<keyof StatusGroups | 'active', string> = {
  active: 'ActiveStatuses',
  done: 'DoneStatuses',
  blocked: 'BlockedStatuses',
  backlog: 'BacklogStatuses',
  ignored: 'IgnoredStatuses',
};

/**
 * The `vault` settings that write the map. A none is written as null, which the vault
 * domain stores as none, so Engine's default name does not stay in force; a kind or
 * status field that is none has empty status lists.
 */
export function vaultMapSettings(map: VaultMapSummary): Array<{ setting: string; value: SettingValue }> {
  const settings: Array<{ setting: string; value: SettingValue }> = MAP_KINDS.map(kind => ({
    setting: `vault.${kind}Type`,
    value: map.kinds[kind].type,
  }));
  for (const kind of STATUS_KINDS) {
    const status = map.status[kind];
    settings.push({ setting: `vault.${kind}StatusField`, value: status.field });
    for (const group of ['active', ...STATUS_GROUPS] as const) {
      settings.push({ setting: `vault.${kind}${STATUS_KEYS[group]}`, value: status.field === null ? [] : status[group] });
    }
  }
  // Ticking a task off writes these, so they must be values the task status field takes. With
  // no done or no open value nothing is invented: the List view then shows no checkbox, and the
  // map's `off` says so (taskCheckboxOff).
  const task = map.status.task;
  if (task.field !== null) {
    const { tick, untick } = taskTickValues(task);
    if (tick !== undefined) settings.push({ setting: 'vault.taskTickStatus', value: tick });
    if (untick !== undefined) settings.push({ setting: 'vault.taskUntickStatus', value: untick });
  }
  // Each written, none included: Engine's default name would otherwise stay in force and
  // be reported as missing from the vault.
  for (const field of MAP_FIELDS) settings.push({ setting: `vault.${MAP_FIELD_KEYS[field]}`, value: map.fields[field] });
  settings.push({ setting: 'vault.wikiDir', value: map.folders.wiki_dir });
  if (map.folders.topic_dir !== null) settings.push({ setting: 'vault.topicDir', value: map.folders.topic_dir });
  return settings;
}

const SOURCE_WORDS: Record<KindSource, string> = {
  vault: '',
  starter: ' (a new type)',
  curator: ' (a new kind; Curator creates it when it first writes)',
};

/** The map in plain lines, for the review. */
export function renderVaultMap(map: VaultMapSummary): string {
  const lines = ['What Vault reads in your notes (Settings/Vault.md):'];
  for (const kind of MAP_KINDS) {
    const { type, from } = map.kinds[kind];
    if (type === null) {
      lines.push(`  ${KIND_LABELS[kind]}: none${kind === 'journal' ? ' (Curator is not installed)' : ''}`);
      continue;
    }
    lines.push(`  ${KIND_LABELS[kind]}: ${type}${from ? SOURCE_WORDS[from] : ''}`);
    if (kind === 'project' || kind === 'task') {
      const status = map.status[kind];
      if (status.field === null) {
        lines.push('    status field: none');
      } else {
        const meanings = (['active', ...STATUS_GROUPS] as const)
          .map(group => `${group === 'ignored' ? 'dropped' : group}: ${status[group].join(', ') || 'none'}`);
        lines.push(`    status field: ${status.field}${status.from === 'starter' ? ' (a new field)' : ''}; ${meanings.join('; ')}`);
      }
    }
  }
  lines.push(`  fields: ${MAP_FIELDS.map(field => `${MAP_FIELD_LABELS[field]}: ${map.fields[field] ?? 'none'}`).join('; ')}`);
  if (map.off.length > 0) {
    lines.push('Off, because of a none:');
    for (const line of map.off) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}
