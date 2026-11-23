import type { EngineCall } from './engine-client.js';
import { SORTING_LEADS_FROM, SORTING_REQUEST } from './sorting.js';

/**
 * What the notes with no kind have in common (#650, option 1): `vault-installer status`
 * prints it after its checks, as the second half of "what Vault found": the structure the
 * notes declare was shown at install, and this is the structure hiding in the rest. It reads
 * Engine's `survey-nodes`, which groups notes by their stored embeddings, so it needs the
 * search index and no model.
 *
 * The survey always forms its number of groups, so one kind often comes back as several (one
 * per app it was exported from). Groups whose notes share the same "Label:" lines are one row
 * here, as the organizing steps tell a model to treat them; so are groups with the same title
 * shape in the same folder. A row lists only what sets its notes apart: a feature most of
 * the other notes share as well (the vault's one folder, a date field every note has) says
 * nothing about the row.
 */

interface Shared {
  name: string;
  share: number;
}

interface SurveyGroup {
  group: number;
  notes: number;
  samples: Array<{ title: string }>;
  shared: {
    folders: Shared[];
    title_patterns: Shared[];
    label_lines: Shared[];
    headings: Shared[];
    fields: Shared[];
  };
}

/** The parts of a `survey-nodes` result this reads. */
export interface Survey {
  scope: { notes: number; surveyed: number; not_indexed: number; truncated: boolean };
  groups: SurveyGroup[];
  ungrouped: { notes: number };
}

/** A feature describes a group when at least this share of its notes have it... */
const HELD = 0.8;
/** ...and sets a row apart when fewer than this share of the other notes have it. */
const ELSEWHERE_BELOW = 0.5;
/** Rows listed; the others are counted on one line. */
const ROWS_SHOWN = 6;
/** The survey can take a while on a large vault; the MCP SDK's default wait is one minute. */
const SURVEY_TIMEOUT_MS = 5 * 60_000;

type MarkKind = 'line' | 'title' | 'folder' | 'heading' | 'field';
const KIND_ORDER: readonly MarkKind[] = ['line', 'title', 'folder', 'heading', 'field'];

interface Mark {
  kind: MarkKind;
  name: string;
}

interface Row {
  notes: number;
  groups: SurveyGroup[];
  marks: Mark[];
  example: string | null;
}

/**
 * The summary's lines, or none when fewer than ten notes have no kind (a handful of loose
 * notes is not a vault to sort, as the finish step decides). Never throws: a failed survey
 * is one line, since `status` reports and does not stop.
 */
export async function untypedSummary(call: EngineCall): Promise<string[]> {
  try {
    const index = (await call<{ search_index?: { status: SearchStatus } }>('vault-stats')).search_index?.status ?? 'disabled';
    const survey = await call<Survey>('survey-nodes', {}, { timeoutMs: SURVEY_TIMEOUT_MS });
    return summarizeSurvey(survey, index);
  } catch (error) {
    return [`Notes with no kind could not be surveyed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

type SearchStatus = 'ready' | 'indexing' | 'disabled';

/** `index`: the search index's state; the survey reads its stored embeddings. */
export function summarizeSurvey(survey: Survey, index: SearchStatus): string[] {
  const untyped = survey.scope?.notes ?? 0;
  if (untyped < SORTING_LEADS_FROM) return [];
  const header = `${count(untyped, 'note')} ${untyped === 1 ? 'has' : 'have'} no kind.`;
  const ask = `To sort them, ask Claude Code: "${SORTING_REQUEST}"`;
  const { surveyed, not_indexed: notIndexed } = survey.scope;
  if (surveyed === 0 && index === 'disabled') {
    return [`${header} Listing what they have in common needs semantic search, which is off.`, ask];
  }
  if (surveyed === 0 || (index === 'indexing' && notIndexed > 0)) {
    return [`${header} What they have in common is listed here once search has embedded them.`, ask];
  }

  const rows = joinedRows(survey.groups);
  const told = rows
    .map(row => ({ ...row, marks: row.marks.filter(mark => elsewhereShare(mark, row, rows, surveyed) < ELSEWHERE_BELOW) }));
  const merged = mergeSameMarks(told.filter(row => row.marks.length > 0)).sort((a, b) => b.notes - a.notes);
  const plain = told.filter(row => row.marks.length === 0).reduce((sum, row) => sum + row.notes, 0) + survey.ungrouped.notes;
  const shown = merged.slice(0, ROWS_SHOWN);
  const more = merged.slice(ROWS_SHOWN);

  const lines = [shown.length > 0
    ? `${header} Grouped by how alike they are (no AI model), they share:`
    : `${header} Grouped by how alike they are (no AI model), no group shares anything that sets it apart.`];
  for (const row of shown) {
    lines.push(`  ${count(row.notes, 'note')}: ${describe(row.marks)}${row.example ? `, e.g. "${row.example}"` : ''}`);
  }
  if (more.length > 0) {
    const notes = more.reduce((sum, row) => sum + row.notes, 0);
    lines.push(`  ${count(notes, 'note')} in ${count(more.length, 'smaller group')}`);
  }
  if (plain > 0 && shown.length > 0) lines.push(`  ${count(plain, 'note')} with nothing that sets them apart`);
  if (notIndexed > 0) lines.push(`  ${count(notIndexed, 'note')} not in the search index ${notIndexed === 1 ? 'is' : 'are'} left out.`);
  if (survey.scope.truncated) lines.push(`  Only the first ${surveyed.toLocaleString('en-US')} were surveyed.`);
  lines.push(ask);
  return lines;
}

/** Features most of a group's notes have. A title of plain words (`…`) is no shape. */
function marksOf(group: SurveyGroup): Mark[] {
  const held = (kind: MarkKind, list: Shared[]) => list.filter(entry => entry.share >= HELD).map(entry => ({ kind, name: entry.name }));
  const { shared } = group;
  return [
    ...held('line', shared.label_lines),
    ...held('title', shared.title_patterns).filter(mark => mark.name !== '…' && mark.name !== ''),
    ...held('folder', shared.folders),
    ...held('heading', shared.headings),
    ...held('field', shared.fields),
  ];
}

/**
 * Groups as rows: those with the same set of "Label:" lines are one row, and so are those
 * without any whose titles have the same shape in the same folder. A row's marks are the ones
 * every group in it has, named as its first group names them.
 */
function joinedRows(groups: readonly SurveyGroup[]): Row[] {
  const rows = new Map<string, Row>();
  for (const group of groups) {
    const marks = marksOf(group);
    const lines = marks.filter(mark => mark.kind === 'line').map(key).sort();
    const shape = marks.filter(mark => mark.kind === 'title' || mark.kind === 'folder').map(key).sort();
    // A title shape alone is common to unlike notes (dated meetings and dated journals): it
    // joins groups only in the same folder (Codex, #685).
    const sameShape = marks.some(mark => mark.kind === 'title') && marks.some(mark => mark.kind === 'folder');
    const joinKey = lines.length > 0
      ? `lines\u0000${lines.join('\u0000')}`
      : sameShape ? `shape\u0000${shape.join('\u0000')}` : `group\u0000${group.group}`;
    const row = rows.get(joinKey);
    if (!row) {
      rows.set(joinKey, { notes: group.notes, groups: [group], marks, example: group.samples[0]?.title ?? null });
      continue;
    }
    const these = new Set(marks.map(key));
    row.notes += group.notes;
    row.groups.push(group);
    row.marks = row.marks.filter(mark => these.has(key(mark)));
  }
  return [...rows.values()];
}

/**
 * The share of the notes outside a row that have this feature, from each other group's share
 * of it. A feature outside a group's reported top few counts as none there, so this errs low.
 */
function elsewhereShare(mark: Mark, row: Row, rows: readonly Row[], surveyed: number): number {
  const others = surveyed - row.notes;
  if (others <= 0) return 0;
  let having = 0;
  for (const other of rows) {
    if (other === row) continue;
    for (const group of other.groups) having += group.notes * shareIn(group, mark);
  }
  return having / others;
}

function shareIn(group: SurveyGroup, mark: Mark): number {
  const list = {
    line: group.shared.label_lines,
    title: group.shared.title_patterns,
    folder: group.shared.folders,
    heading: group.shared.headings,
    field: group.shared.fields,
  }[mark.kind];
  const name = nameKey(mark.kind, mark.name);
  return list.find(entry => nameKey(mark.kind, entry.name) === name)?.share ?? 0;
}

/** Rows that read the same are one row: the larger one's example stands for both. */
function mergeSameMarks(rows: readonly Row[]): Row[] {
  const merged = new Map<string, Row>();
  for (const row of [...rows].sort((a, b) => b.notes - a.notes)) {
    const joinKey = row.marks.map(key).sort().join('\u0001');
    const existing = merged.get(joinKey);
    if (existing) {
      existing.notes += row.notes;
      existing.groups.push(...row.groups);
    } else {
      merged.set(joinKey, { ...row, groups: [...row.groups] });
    }
  }
  return [...merged.values()];
}

/** `"Attendees:" and "Date:" lines; titles like "<date> …"; in Meetings/; fields company and role` */
function describe(marks: readonly Mark[]): string {
  const of = (kind: MarkKind) => marks.filter(mark => mark.kind === kind).map(mark => mark.name);
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const names = of(kind);
    if (names.length === 0) continue;
    if (kind === 'line') parts.push(`${listed(names.map(name => `"${name}:"`))} ${names.length === 1 ? 'line' : 'lines'}`);
    if (kind === 'title') parts.push(`titles like ${listed(names.map(name => `"${name}"`), 'or')}`);
    // The survey names the vault's top level `/`.
    if (kind === 'folder') parts.push(`in ${listed(names.map(name => (name === '/' ? 'the top folder' : `${name}/`)))}`);
    if (kind === 'heading') parts.push(`${names.length === 1 ? 'heading' : 'headings'} ${listed(names.map(name => `"${name}"`))}`);
    if (kind === 'field') parts.push(`${names.length === 1 ? 'field' : 'fields'} ${listed(names)}`);
  }
  return parts.join('; ');
}

function listed(items: readonly string[], last = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

/** `1 note`, `2,928 notes`. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Engine counts labels and headings case-insensitively but names each by its first spelling in
 * the group, so `Date:` in one group is `date:` in another (Codex, #685). They are compared
 * that way here too, and shown as the first group spelled them.
 */
function nameKey(kind: MarkKind, name: string): string {
  return kind === 'line' || kind === 'heading' ? name.toLowerCase() : name;
}

function key(mark: Mark): string {
  return `${mark.kind}\u0000${nameKey(mark.kind, mark.name)}`;
}
