import { sortingAfterInstall } from './sorting.js';
import { ROLES, STARTER_STATUS_VALUES, type Role } from './starter-types.js';
import type { StructurePlan } from './structure.js';
import { count } from './text.js';
import { MAP_FIELDS, STATUS_GROUPS, STATUS_KINDS, detectDailyNoteType, type MapField, type StatusKind } from './vault-map.js';
import type { VaultPlan } from './vault.js';

/**
 * The notes step's one screen: the vocabulary map in plain words, built from the user's
 * own notes. It says, for each designation, what Vault does with it, and what turns off
 * when it is none. Lines stay within 72 characters, so the framed note fits an 80-column
 * terminal, and long lists end with "and N more".
 */

const WIDTH = 72;
const MAX_KINDS = 12;
const MAX_LIST = 8;
const MAX_WARNINGS = 3;

/** What Vault does with each kind of note. */
export const KIND_USES: Record<Role, string> = {
  project: 'Curator can keep a wiki for each active project',
  task: 'project wikis list open and finished tasks',
  meeting: 'project wikis draw on meeting notes',
  person: 'project wikis list the people involved',
  company: 'project wikis list the companies involved',
};
/** What turns off when a kind is none. */
export const KIND_OFF_WORDS: Record<Role, string> = {
  project: 'Curator keeps no project wikis, and nothing is filed under a project',
  task: 'project wikis list no tasks',
  meeting: 'project wikis draw on no meeting notes',
  person: 'project wikis list no people',
  company: 'project wikis list no companies',
};
/** What turns off when a kind has no status line. */
export const STATUS_OFF_WORDS: Record<StatusKind, string> = {
  project: 'Curator treats every project as active, and wikis show no project status',
  task: 'wikis cannot tell open tasks from finished ones',
};
/** What each of the map's other lines holds. */
const FIELD_USES: Record<MapField, string> = {
  due: 'due date of a task',
  date: 'date of a meeting or note',
  people: 'people a note involves',
  company: 'company a note is about',
  priority: 'priority of a task',
  scheduled: 'when a task is scheduled',
};
/** What turns off when one of the map's other lines is none. */
export const FIELD_OFF_WORDS: Record<MapField, string> = {
  due: 'wikis show no due dates',
  date: 'Vault reads no date from a line',
  people: 'project wikis list no people linked from notes',
  company: 'project wikis list no companies linked from notes',
  priority: 'Vault reads no priority',
  scheduled: 'Vault reads no scheduled date',
};

const PLURALS: Record<Role, string> = {
  project: 'projects',
  task: 'tasks',
  meeting: 'meetings',
  person: 'people',
  company: 'companies',
};
const MEANINGS: Record<StatusKind, Record<'active' | typeof STATUS_GROUPS[number], string>> = {
  project: { active: 'still active', done: 'done', blocked: 'blocked', backlog: 'not started', ignored: 'dropped' },
  task: { active: 'still open', done: 'done', blocked: 'blocked', backlog: 'not started', ignored: 'dropped' },
};

/**
 * `quick`: quick setup shows the screen without a question, after taking the folder step's
 * defaults, so the folders are not "chosen" and the folders left out are listed.
 */
export function renderMapScreen(vault: VaultPlan, plan: StructurePlan, options: { quick?: boolean } = {}): string {
  // The notes the Analyzer read, which leaves out the settings folder as well.
  const notes = plan.analysis?.inventory.markdown_files ?? vault.discovery.inventory.markdown_files;
  return [
    ...wrap(`Vault read your ${count(notes, 'note')} without changing them. This is how it would sort them.`),
    '',
    ...typingLines(plan),
    '',
    ...kindsFoundLines(plan, notes),
    '',
    ...designatedKindLines(plan),
    ...statusLines(plan),
    '',
    ...fieldLines(plan),
    '',
    ...wrap(`Daily notes: ${dailyNoteWords(plan)}`),
    ...wrap(`Curator's journal, if you install Curator: ${journalWords(plan)}`),
    '',
    options.quick ? 'Folders' : 'Folders (chosen in the last step)',
    `  settings notes: ${vault.settingsDir}/   wiki pages: ${vault.wikiDir}/`,
    `  topic notes, if you install Curator: ${vault.topicDir}/`,
    ...(options.quick && vault.exclusions.length > 0
      ? wrap(`left out (Vault does not read them): ${listed(vault.exclusions.map(folder => `${folder}/`))}`, '  ', '    ')
      : []),
    ...warningLines(plan.warnings),
    '',
    'Nothing in your notes changes until you approve the plan at the end.',
  ].join('\n');
}

/** How Vault tells what kind a note is: a line at the top, folders, both, or neither. */
function typingLines(plan: StructurePlan): string[] {
  const { type_field: field, folder_rules: rules } = plan.spec;
  const lines = ['What kind a note is'];
  if (plan.source === 'none' || plan.analysis === null) {
    return [...lines, ...wrap('Not set: your notes stay as they are, without kinds.', '  ')];
  }
  // The value most notes have, as an example.
  const sample = plan.analysis.proposal.type_assignment.type_field_values
    .filter(value => value.type !== null)
    .reduce<{ value: string; documents: number } | undefined>((best, value) => (best && best.documents >= value.documents ? best : value), undefined)?.value;
  if (field !== null) {
    lines.push(...wrap(`The "${field}" line at the top of each note${sample ? `, such as ${field}: ${sample}` : ''}.`, '  '));
  }
  // Tags come before folders: a tag the note carries wins over the folder it is in (#650).
  const tagged = (plan.spec.tag_rules ?? []).filter(rule => rule.type !== null);
  if (tagged.length > 0) {
    const shown = tagged.slice(0, MAX_LIST).map(rule => `#${rule.tag} → ${rule.type}`);
    const more = tagged.length - shown.length;
    lines.push(...wrap(
      `${field !== null ? 'Without one, a tag' : 'A tag'} the note carries: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}. The tag stays in the note.`,
      '  ',
    ));
  }
  const typed = rules.filter(rule => rule.type !== null);
  if (typed.length > 0) {
    const shown = typed.slice(0, MAX_LIST).map(rule => `${rule.directory}/ → ${rule.type}`);
    const more = typed.length - shown.length;
    lines.push(...wrap(
      `${field !== null || tagged.length > 0 ? 'Otherwise, the folder' : 'The folder'} a note is in: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
      '  ',
    ));
  }
  return lines;
}

function kindsFoundLines(plan: StructurePlan, notes: number): string[] {
  const schemas = plan.analysis?.proposal.schemas ?? [];
  if (schemas.length === 0) {
    return ['Kinds found: none, so no note gets a kind.', ...(notes > 0 ? wrap(sortingAfterInstall(notes), '  ') : [])];
  }
  const kinds = [...schemas].sort((left, right) =>
    right.evidence.typed_documents - left.evidence.typed_documents || left.name.localeCompare(right.name));
  const shown = kinds.slice(0, MAX_KINDS).map(kind => `${kind.name} (${kind.evidence.typed_documents})`);
  const more = kinds.length - shown.length;
  const untyped = notes - (plan.analysis?.coverage.typed_files ?? 0);
  return [
    `Kinds found (${kinds.length}), with their number of notes`,
    ...wrap(`${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`, '  '),
    ...(untyped > 0
      ? wrap(`${count(untyped, 'note')} with no kind ${untyped === 1 ? 'stays as it is' : 'stay as they are'}. ${sortingAfterInstall(untyped)}`, '  ')
      : []),
  ];
}

/** Each special kind, what Vault does with it, and what is off when it is none. */
function designatedKindLines(plan: StructurePlan): string[] {
  const lines = ['Kinds Vault gives extra help'];
  for (const role of ROLES) {
    const type = plan.roles[role];
    const label = `  ${`${PLURALS[role]}:`.padEnd(11)}`;
    const indent = ' '.repeat(label.length);
    if (type === null) {
      lines.push(`${label}none`, ...wrap(`Off: ${KIND_OFF_WORDS[role]}.`, indent));
      continue;
    }
    const schema = plan.analysis?.proposal.schemas.find(candidate => candidate.name === type);
    const from = schema ? `(${count(schema.evidence.typed_documents, 'note')})` : '(a new kind; Vault creates it, with no notes yet)';
    lines.push(...wrap(`${type} ${from}`, label, indent), ...wrap(`${capitalize(KIND_USES[role])}.`, indent));
  }
  return lines;
}

/** The status line of projects and of tasks, and what its values mean; skipped for a kind that is none. */
function statusLines(plan: StructurePlan): string[] {
  const lines: string[] = [];
  for (const kind of STATUS_KINDS) {
    if (plan.roles[kind] === null) continue;
    const status = plan.status[kind];
    lines.push('');
    if (status.field === null) {
      lines.push(`Status of ${PLURALS[kind]}: none`, ...wrap(`Off: ${STATUS_OFF_WORDS[kind]}.`, '  '));
      continue;
    }
    lines.push(...wrap(status.starter
      ? `Status of ${PLURALS[kind]}: a new "${status.field}" line (${STARTER_STATUS_VALUES.join(', ')})`
      : `Status of ${PLURALS[kind]}: the "${status.field}" line`));
    const meanings = (['active', ...STATUS_GROUPS] as const).map(group => {
      const values = group === 'active' ? status.active : status.groups[group];
      return `${MEANINGS[kind][group]}: ${values.length > 0 ? listed(values) : 'none'}`;
    });
    lines.push(...wrap(meanings.join('; '), '  '));
  }
  return lines;
}

function fieldLines(plan: StructurePlan): string[] {
  const width = Math.max(...MAP_FIELDS.map(field => FIELD_USES[field].length)) + 2;
  const lines = ['Other lines Vault reads'];
  for (const field of MAP_FIELDS) {
    const label = `  ${`${FIELD_USES[field]}:`.padEnd(width)}`;
    const name = plan.fields[field];
    lines.push(...wrap(name ?? `none (${FIELD_OFF_WORDS[field]})`, label, ' '.repeat(label.length)));
  }
  const leftAsIs = plan.unmanagedFields.map(field => field.name);
  if (leftAsIs.length > 0) {
    lines.push(...wrap(`Left as they are, because notes use them in more than one way: ${listed(leftAsIs)}.`, '  '));
  }
  return lines;
}

/** The daily-note kind the map writes (`detectDailyNoteType`), with its number of notes. */
function dailyNoteWords(plan: StructurePlan): string {
  const schemas = plan.analysis?.proposal.schemas ?? [];
  const type = detectDailyNoteType(schemas.map(schema => schema.name));
  if (type === null) return 'none. Change it later in Settings/Vault.md (dailyNoteType).';
  const notes = schemas.find(schema => schema.name === type)?.evidence.typed_documents ?? 0;
  return `${type} (${count(notes, 'note')}). Search ranks them a little below other notes that match as well.`;
}

function journalWords(plan: StructurePlan): string {
  const type = plan.journalType;
  const schema = plan.analysis?.proposal.schemas.find(candidate => candidate.name === type);
  if (schema) return `${type} (${count(schema.evidence.typed_documents, 'note')}). It adds one note a month.`;
  if (plan.starterTypes.some(starter => starter.name === type)) return `${type}, a new kind. It adds one note a month.`;
  return `${type}, a new kind Curator creates when it first writes, one note a month.`;
}

function warningLines(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  const shown = warnings.slice(0, MAX_WARNINGS);
  const more = warnings.length - shown.length;
  return [
    '',
    'Worth knowing',
    ...shown.flatMap(warning => wrap(warning, '  - ', '    ')),
    ...(more > 0 ? [`  and ${more} more in the review at the end.`] : []),
  ];
}

/** `a, b, c, and 4 more` past `MAX_LIST` items. */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LIST);
  const more = items.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Word-wrap `text` within `WIDTH`, starting with `first` and continuing with `rest`. A
 * parenthesis stays with the word before it, so `book (3)` is never split.
 */
export function wrap(text: string, first = '', rest = ' '.repeat(first.length)): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(/ (?!\()/)) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (empty ? '' : ' ') + word;
    }
    empty = false;
  }
  lines.push(line);
  return lines;
}
