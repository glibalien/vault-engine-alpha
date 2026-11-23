import type Database from 'better-sqlite3';
import type { VaultSettings } from '@vault/settings-registry';
import { UNRENDERED_FIELDS } from '../fields/unrendered.js';
import { evidenceNoteDate } from '../memories/service.js';
import { noteForName, rankMissing, scanMissingNames } from '../missing-notes/service.js';
import { SUITE_NOTE_FIELD } from '../notes/suite-notes.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { getVaultSettings } from '../settings/vault.js';
import { exactDuplicateIds } from '../duplicates/service.js';
import { untypedNotesWhere } from '../survey/service.js';
import { organizingGuide } from './guide.js';

/**
 * The clean-up report (#643): what is still unorganized in a vault, as rows a caller can work
 * through one at a time. Read-only and stateless. The vault itself holds the progress, so a row
 * that was fixed is smaller or gone the next time the report is read.
 *
 * Every row counts notes affected, and rows are ordered by that count. Only the user's notes are
 * counted (`userNotesWhere`): what the suite writes itself is not the user's to fix. Each check reads the
 * vault map (`Settings/Vault.md`) for the user's own kinds and fields; a check whose kind or
 * field is set to none is listed as not checked, with the setting that would turn it on.
 *
 * A check finds the notes themselves, not only how many. The report shows the count and a few
 * examples, and `cleanupRowNotes` pages the same list, so the notes a caller acts on are exactly
 * the ones a row counted. A query that only approximates a row is never offered as its listing.
 */

export const CLEANUP_LIMITS = { defaultExamples: 3, maxExamples: 10, defaultPage: 200, maxPage: 500 } as const;

export class CleanupError extends Error {
  override readonly name = 'CleanupError';
  constructor(readonly code: 'INVALID_PARAMS', message: string) {
    super(message);
  }
}

export interface CleanupNote { id: string; title: string; path: string }
/** A value the row is about (a field name, a status, a missing note's name) and how many notes carry it. */
export interface CleanupValueExample { value: string; notes: number; mostly_on?: string }

export interface CleanupCall {
  tool: string;
  arguments: Record<string, unknown>;
  purpose: string;
}

export interface CleanupRow {
  id: string;
  title: string;
  /** Notes affected. */
  notes: number;
  /** Notes the check looked at. */
  out_of: number;
  why: string;
  examples: Array<CleanupNote | CleanupValueExample>;
  /** Calls that start on the row, written with this vault's own kinds and fields. */
  next: CleanupCall[];
}

export interface CleanupReport {
  /** The user's notes: the vault without the suite's own notes, the settings folder and wiki pages. */
  notes: number;
  /** How to work through the rows with the user, one step per line, in order (`guide.ts`). */
  guide: string[];
  /** What is left to do, most notes affected first. */
  rows: CleanupRow[];
  /** Checks that found nothing. */
  clear: Array<{ id: string; title: string }>;
  /** Checks that could not run because the vault map names no such kind or field. */
  not_checked: Array<{ id: string; title: string; reason: string }>;
}

export interface CleanupRowNotes {
  row: string;
  title: string;
  /** Notes the row counts. */
  total: number;
  offset: number;
  /** Newest first. */
  notes: CleanupNote[];
}

/** What one check found: every note it counts, newest first. */
interface Finding {
  id: string;
  title: string;
  outOf: number;
  why: string;
  noteIds: string[];
  /** For a row about values (field names, statuses, missing names): the values, most notes first. */
  values?: CleanupValueExample[];
  next: CleanupCall[];
}

type CheckResult =
  | { state: 'checked'; finding: Finding }
  | { state: 'not_checked'; id: string; title: string; reason: string };

interface CheckContext {
  db: Database.Database;
  vault: VaultSettings;
  settingsDir: string | undefined;
}

interface Check {
  id: string;
  run(context: CheckContext, total: number): CheckResult;
}

const NEWEST_FIRST = 'ORDER BY n.file_mtime DESC, n.id';
const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ');
const ids = (rows: unknown[]): string[] => (rows as Array<{ id: string }>).map(row => row.id);

/** The call that lists a row's notes: the exact notes it counted. */
function listCall(id: string): CleanupCall {
  return {
    tool: 'cleanup-report',
    arguments: { row: id },
    purpose: 'List every note this row counts ({id, title, path}), newest first; page with limit and offset. Pass the ids as node_ids to query-nodes or update-node.',
  };
}

function noneReason(key: string, what: string): string {
  return `No ${what} is set in the vault map (${key}); set it with update-settings on the vault domain to check this.`;
}

/** Notes with no kind: the same notes `survey-nodes` covers with no arguments. */
const untyped: Check = {
  id: 'untyped',
  run({ db, settingsDir }, total) {
    const { where, params } = untypedNotesWhere(settingsDir);
    return {
      state: 'checked',
      finding: {
        id: this.id,
        title: 'Notes with no kind',
        outOf: total,
        why: 'A note with no kind has no fields of its own, is checked against nothing, and appears in no view of a kind.',
        noteIds: ids(db.prepare(`SELECT n.id FROM nodes n WHERE ${where.join(' AND ')} ${NEWEST_FIRST}`).all(...params)),
        next: [
          { tool: 'survey-nodes', arguments: {}, purpose: 'Group them by similarity to see the kinds they hold; its members_of then gives the note ids of one group to type.' },
          { tool: 'list-inline-tags', arguments: { untyped_only: true }, purpose: 'Some apps mark what a note is with a #tag in its text. List the tags these notes carry: a tag such as #meeting names a kind outright, and tag then lists its notes to type.' },
          listCall(this.id),
        ],
      },
    };
  },
};

/** Notes of a designated kind that have no value in a designated field. */
function fieldMissing(spec: {
  id: string; kindKey: keyof VaultSettings; kindWord: string; fieldKey: keyof VaultSettings; fieldWord: string; why: string;
}): Check {
  return {
    id: spec.id,
    run({ db, vault }) {
      const kind = vault[spec.kindKey] as string | null;
      const field = vault[spec.fieldKey] as string | null;
      const fallbackTitle = `Notes of the ${spec.kindWord} with no ${spec.fieldWord}`;
      if (kind === null) return { state: 'not_checked', id: spec.id, title: fallbackTitle, reason: noneReason(String(spec.kindKey), spec.kindWord) };
      if (field === null) return { state: 'not_checked', id: spec.id, title: fallbackTitle, reason: noneReason(String(spec.fieldKey), spec.fieldWord) };

      const from = 'FROM nodes n JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?';
      const outOf = (db.prepare(`SELECT COUNT(*) AS count ${from}`).get(kind) as { count: number }).count;
      const noteIds = ids(db.prepare(
        `SELECT n.id ${from} WHERE NOT EXISTS (SELECT 1 FROM node_fields f WHERE f.node_id = n.id AND f.field_name = ?) ${NEWEST_FIRST}`,
      ).all(kind, field));
      // "No value" is "no stored field", which is exactly what exists: false tests.
      const query = { types: [kind], fields: { [field]: { exists: false } } };
      return {
        state: 'checked',
        finding: {
          id: spec.id,
          title: `${kind} notes with no ${field}`,
          outOf,
          why: spec.why,
          noteIds,
          next: [
            listCall(spec.id),
            { tool: 'query-nodes', arguments: query, purpose: 'The same notes as a query.' },
            { tool: 'update-node', arguments: { query, set_fields: { [field]: '<value>' } }, purpose: 'Set the same value on all of them, or on a narrower query; it previews before it writes.' },
          ],
        },
      };
    },
  };
}

/** Notes of a status kind whose status value the vault map gives no meaning. */
function statusUnknown(spec: {
  id: string; kindKey: 'taskType' | 'projectType'; kindWord: string; fieldKey: 'taskStatusField' | 'projectStatusField';
  listKeys: ReadonlyArray<keyof VaultSettings>; activeKey: keyof VaultSettings; why: string;
}): Check {
  return {
    id: spec.id,
    run({ db, vault }) {
      const kind = vault[spec.kindKey];
      const field = vault[spec.fieldKey];
      const fallbackTitle = `Statuses of the ${spec.kindWord} that the vault map does not know`;
      if (kind === null) return { state: 'not_checked', id: spec.id, title: fallbackTitle, reason: noneReason(spec.kindKey, spec.kindWord) };
      if (field === null) return { state: 'not_checked', id: spec.id, title: fallbackTitle, reason: noneReason(spec.fieldKey, `${spec.kindWord} status field`) };

      const known = spec.listKeys.flatMap(key => vault[key] as string[]);
      const notKnown = known.length === 0 ? '' : ` AND f.value_text NOT IN (${placeholders(known)})`;
      const from = `FROM node_fields f
        JOIN node_types nt ON nt.node_id = f.node_id AND nt.schema_type = ?
        JOIN nodes n ON n.id = f.node_id
        WHERE f.field_name = ? AND f.value_text IS NOT NULL AND f.value_text != ''${notKnown}`;
      const values = db.prepare(
        `SELECT f.value_text AS value, COUNT(DISTINCT f.node_id) AS notes ${from} GROUP BY f.value_text ORDER BY notes DESC, value`,
      ).all(kind, field, ...known) as Array<{ value: string; notes: number }>;
      const noteIds = ids(db.prepare(`SELECT n.id ${from} GROUP BY n.id ${NEWEST_FIRST}`).all(kind, field, ...known));
      const outOf = (db.prepare('SELECT COUNT(*) AS count FROM node_types WHERE schema_type = ?').get(kind) as { count: number }).count;
      const first = values[0]?.value ?? '<status>';
      return {
        state: 'checked',
        finding: {
          id: spec.id,
          title: `${kind} ${field} values the vault map does not know`,
          outOf,
          why: spec.why,
          noteIds,
          values,
          next: [
            listCall(spec.id),
            { tool: 'query-nodes', arguments: { types: [kind], fields: { [field]: { one_of: values.map(row => row.value) } } }, purpose: 'The same notes as a query.' },
            {
              tool: 'update-settings',
              arguments: { domain: 'vault', patch: { [spec.activeKey]: [...(vault[spec.activeKey] as string[]), first] } },
              purpose: `Say what a value means by adding it to one of the lists (${spec.listKeys.join(', ')}); this example adds "${first}" to the active ones.`,
            },
            { tool: 'update-node', arguments: { query: { types: [kind], fields: { [field]: { eq: first } } }, set_fields: { [field]: '<a known status>' } }, purpose: 'Or rewrite the value to one the map knows; it previews before it writes.' },
          ],
        },
      };
    },
  };
}

/**
 * Meetings and daily notes with no date the system can read. `evidenceNoteDate` decides, as it
 * does for memories: the date field's value, else a YYYY-MM-DD date in the title. A note whose
 * date field holds something unreadable ("TBD") is undated too, which no field filter can
 * express, so this row's notes are listed only through the report.
 */
const noDate: Check = {
  id: 'no-date',
  run({ db, vault }) {
    const kinds = [...new Set([vault.meetingType, vault.dailyNoteType].filter((kind): kind is string => kind !== null))];
    if (kinds.length === 0) {
      return { state: 'not_checked', id: this.id, title: 'Meetings and daily notes with no readable date', reason: noneReason('meetingType, dailyNoteType', 'meeting or daily-note kind') };
    }
    const candidates = ids(db.prepare(
      `SELECT n.id FROM nodes n WHERE EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type IN (${placeholders(kinds)})) ${NEWEST_FIRST}`,
    ).all(...kinds));
    const noteIds = candidates.filter(id => evidenceNoteDate(db, id) === null);
    const dateField = vault.dateField;
    return {
      state: 'checked',
      finding: {
        id: this.id,
        title: `${kinds.join(' and ')} notes with no date Vault can read`,
        outOf: candidates.length,
        why: 'Vault cannot tell when these were written, so memories drawn from them cannot be ordered against newer ones.',
        noteIds,
        next: [
          listCall(this.id),
          ...(dateField === null ? [] : [{
            tool: 'recover-dates', arguments: { types: kinds },
            purpose: `Propose a date for each of these notes from what the note itself holds: another frontmatter line, a date written another way in the title, a line at the top of its text. It previews; with dry_run: false it writes the sure ones to ${dateField}, as one undo.`,
          }]),
          dateField === null
            ? { tool: 'update-settings', arguments: { domain: 'vault', patch: { dateField: '<field>' } }, purpose: 'Name the field that holds a note\'s date. Until then only a YYYY-MM-DD date in the title is read.' }
            : { tool: 'update-node', arguments: { node_id: noteIds[0] ?? '<id>', set_fields: { [dateField]: '<YYYY-MM-DD>' } }, purpose: `Set the date on a note. A ${dateField} that is there but not a date (such as "TBD") counts as no date.` },
        ],
      },
    };
  },
};

const HIDDEN_FIELDS: readonly string[] = [...UNRENDERED_FIELDS, SUITE_NOTE_FIELD];

/**
 * Obsidian's own properties: a note's other names, its tags and its styles. Obsidian gives each
 * a meaning of its own, and the Engine reads aliases as names and tags as tags, so no kind has
 * to claim them. Listed as unclaimed they were noise: an export carries tags on most notes, and
 * `merge-nodes` adds aliases (end-to-end run on the messy sample, 2026-11-19).
 */
const OBSIDIAN_PROPERTIES: readonly string[] = ['aliases', 'alias', 'tags', 'tag', 'cssclasses', 'cssclass'];
const NOT_A_KIND_FIELD: readonly string[] = [...HIDDEN_FIELDS, ...OBSIDIAN_PROPERTIES];

/** Field values on typed notes that none of the note's kinds claims. */
const unclaimedFields: Check = {
  id: 'unclaimed-fields',
  run(context, total) {
    const { db } = context;
    const user = userNotesWhere(context);
    const from = 'FROM node_fields nf JOIN nodes n ON n.id = nf.node_id';
    const unclaimed = `${user.sql}
      AND EXISTS (SELECT 1 FROM node_types t WHERE t.node_id = nf.node_id)
      AND NOT EXISTS (
        SELECT 1 FROM node_types nt JOIN schema_field_claims c ON c.schema_name = nt.schema_type AND c.field = nf.field_name
        WHERE nt.node_id = nf.node_id)
      AND nf.field_name NOT IN (${placeholders(NOT_A_KIND_FIELD)})`;
    const params = [...user.params, ...NOT_A_KIND_FIELD];
    const noteIds = ids(db.prepare(`SELECT n.id ${from} WHERE ${unclaimed} GROUP BY n.id ${NEWEST_FIRST}`).all(...params));
    const fields = db.prepare(
      `SELECT nf.field_name AS value, COUNT(DISTINCT nf.node_id) AS notes ${from} WHERE ${unclaimed}
       GROUP BY nf.field_name ORDER BY notes DESC, value LIMIT ${CLEANUP_LIMITS.maxExamples}`,
    ).all(...params) as Array<{ value: string; notes: number }>;
    const mostlyOn = db.prepare(
      `SELECT kind.schema_type AS type ${from} JOIN node_types kind ON kind.node_id = nf.node_id
       WHERE ${unclaimed} AND nf.field_name = ? GROUP BY kind.schema_type ORDER BY COUNT(*) DESC, type LIMIT 1`,
    );
    const values: CleanupValueExample[] = fields.map(field => {
      const kind = (mostlyOn.get(...params, field.value) as { type: string } | undefined)?.type;
      return kind === undefined ? field : { ...field, mostly_on: kind };
    });
    const first = values[0];
    return {
      state: 'checked',
      finding: {
        id: this.id,
        title: 'Fields that no kind of their note claims',
        outOf: total,
        why: 'These values are kept as written but not checked, typed or defaulted, and their kind does not offer them as a field.',
        noteIds,
        values,
        next: first === undefined ? [] : [
          listCall(this.id),
          { tool: 'list-field-values', arguments: { field_name: first.value }, purpose: 'See what the field holds.' },
          { tool: 'infer-field-type', arguments: { field_name: first.value }, purpose: 'See what type its values fit.' },
          { tool: 'describe-schema', arguments: { name: first.mostly_on ?? '<kind>', include: ['orphans'] }, purpose: 'See every unclaimed field on one kind.' },
          {
            tool: 'update-schema',
            arguments: { name: first.mostly_on ?? '<kind>', add_field_claims: [{ field: first.value }], dry_run: true },
            purpose: 'Have the kind claim the field (create it first with create-global-field if no such field exists).',
          },
        ],
      },
    };
  },
};

/**
 * Links and reference-field values that name a note which does not exist: the names
 * `scanMissingNames` reads from links. `find-missing-nodes` lists the same names in full, and
 * adds names written as plain text in the people and company fields.
 */
const missingNotes: Check = {
  id: 'missing-notes',
  run(context, total) {
    const scan = scanMissingNames(context.db, context, { plainText: false });
    const values = rankMissing(scan.entries.values()).map(entry => ({ value: entry.name, notes: entry.sources.size }));
    const count = values.length === 1 ? '1 missing note' : `${values.length.toLocaleString('en-US')} missing notes`;
    const first = values[0]?.value;
    return {
      state: 'checked',
      finding: {
        id: this.id,
        title: `Links to notes that do not exist (${count})`,
        outOf: total,
        why: 'Each is a person, company, project or other note that exists only as a name in other notes.',
        noteIds: [...scan.sources],
        values,
        next: [
          listCall(this.id),
          {
            tool: 'find-missing-nodes',
            arguments: {},
            purpose: 'List every missing name, most-named first, with the fields that name it, the kind its note would likely be and create-node arguments. It also lists names written as plain text in the people and company fields, which this row does not count.',
          },
          {
            tool: 'create-node',
            arguments: { ...(first === undefined ? { title: '<name>' } : noteForName(first)), types: ['<kind>'] },
            purpose: 'Create the note a name stands for; links to it then resolve. A name written as a path keeps its folder as directory. batch-mutate creates several at once.',
          },
        ],
      },
    };
  },
};

/**
 * Notes that have an exact copy (#646): the notes `find-duplicate-nodes` puts in its exact
 * groups with no arguments, so transcripts and daily notes are left out as they are there.
 */
const duplicates: Check = {
  id: 'duplicates',
  run({ db, settingsDir }, total) {
    return {
      state: 'checked',
      finding: {
        id: this.id,
        title: 'Notes with the same text as another note',
        outOf: total,
        why: 'Copies split a subject\'s links between two notes and turn up twice in search.',
        noteIds: exactDuplicateIds(db, settingsDir),
        next: [
          { tool: 'find-duplicate-nodes', arguments: {}, purpose: 'List the copies in groups, with what tells them apart (which one other notes link to, length, dates), and the near copies as well: notes whose text is nearly the same. Deciding which copy to keep is the user\'s.' },
          listCall(this.id),
          { tool: 'merge-nodes', arguments: { keep: '<id of the copy to keep>', merge: ['<id of another copy>'] }, purpose: 'Fold the other copies of a group into the one to keep: its links are repointed and the copies removed, as one undo. It previews until dry_run is false.' },
        ],
      },
    };
  },
};

/** Every check, in the order that settles a tie between rows. */
const CHECKS: readonly Check[] = [
  untyped,
  fieldMissing({
    id: 'task-status-missing', kindKey: 'taskType', kindWord: 'task kind', fieldKey: 'taskStatusField', fieldWord: 'task status field',
    why: 'A task with no status counts as neither open nor done.',
  }),
  fieldMissing({
    id: 'project-status-missing', kindKey: 'projectType', kindWord: 'project kind', fieldKey: 'projectStatusField', fieldWord: 'project status field',
    why: 'A project with no status counts as neither active nor done.',
  }),
  fieldMissing({
    id: 'meeting-people-missing', kindKey: 'meetingType', kindWord: 'meeting kind', fieldKey: 'peopleField', fieldWord: 'people field',
    why: 'Nothing ties these meetings to the people in them.',
  }),
  statusUnknown({
    id: 'task-status-unknown', kindKey: 'taskType', kindWord: 'task kind', fieldKey: 'taskStatusField',
    listKeys: ['taskActiveStatuses', 'taskDoneStatuses', 'taskBlockedStatuses', 'taskBacklogStatuses', 'taskIgnoredStatuses'],
    activeKey: 'taskActiveStatuses',
    why: 'A task whose status is in none of the vault map\'s lists counts as neither open nor done.',
  }),
  statusUnknown({
    id: 'project-status-unknown', kindKey: 'projectType', kindWord: 'project kind', fieldKey: 'projectStatusField',
    listKeys: ['projectActiveStatuses', 'projectDoneStatuses', 'projectBlockedStatuses', 'projectBacklogStatuses', 'projectIgnoredStatuses'],
    activeKey: 'projectActiveStatuses',
    why: 'A project whose status is in none of the vault map\'s lists counts as neither active nor done.',
  }),
  noDate,
  unclaimedFields,
  missingNotes,
  duplicates,
];

function hydrate(db: Database.Database, noteIds: readonly string[]): CleanupNote[] {
  const read = db.prepare<[string], { id: string; title: string | null; file_path: string }>('SELECT id, title, file_path FROM nodes WHERE id = ?');
  const notes: CleanupNote[] = [];
  for (const id of noteIds) {
    const row = read.get(id);
    if (row) notes.push({ id: row.id, title: row.title ?? '', path: row.file_path });
  }
  return notes;
}

function contextFor(db: Database.Database, settingsDir: string | undefined): { context: CheckContext; total: number } {
  const context: CheckContext = { db, vault: getVaultSettings(db), settingsDir };
  const user = userNotesWhere(context);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM nodes n WHERE ${user.sql}`).get(...user.params) as { count: number }).count;
  return { context, total };
}

export function cleanupReport(db: Database.Database, options: { settingsDir?: string; examples?: number } = {}): CleanupReport {
  const { context, total } = contextFor(db, options.settingsDir);
  const examples = options.examples ?? CLEANUP_LIMITS.defaultExamples;
  const rows: Array<CleanupRow & { order: number }> = [];
  const clear: CleanupReport['clear'] = [];
  const notChecked: CleanupReport['not_checked'] = [];
  CHECKS.forEach((check, order) => {
    const result = check.run(context, total);
    if (result.state === 'not_checked') {
      notChecked.push({ id: result.id, title: result.title, reason: result.reason });
      return;
    }
    const { finding } = result;
    if (finding.noteIds.length === 0) {
      clear.push({ id: finding.id, title: finding.title });
      return;
    }
    rows.push({
      id: finding.id,
      title: finding.title,
      notes: finding.noteIds.length,
      out_of: finding.outOf,
      why: finding.why,
      examples: finding.values ? finding.values.slice(0, examples) : hydrate(db, finding.noteIds.slice(0, examples)),
      next: finding.next,
      order,
    });
  });
  // Most notes affected first; the order of the checks settles a tie.
  rows.sort((a, b) => b.notes - a.notes || a.order - b.order);
  return { notes: total, guide: organizingGuide(rows.length), rows: rows.map(({ order: _order, ...row }) => row), clear, not_checked: notChecked };
}

/** One row's notes, paged: exactly the notes the report counted for it. */
export function cleanupRowNotes(
  db: Database.Database,
  row: string,
  options: { settingsDir?: string; limit?: number; offset?: number } = {},
): CleanupRowNotes {
  const check = CHECKS.find(candidate => candidate.id === row);
  if (!check) throw new CleanupError('INVALID_PARAMS', `No row "${row}". Rows: ${CHECKS.map(candidate => candidate.id).join(', ')}.`);
  const { context, total } = contextFor(db, options.settingsDir);
  const result = check.run(context, total);
  if (result.state === 'not_checked') throw new CleanupError('INVALID_PARAMS', `Row "${row}" is not checked. ${result.reason}`);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? CLEANUP_LIMITS.defaultPage;
  return {
    row,
    title: result.finding.title,
    total: result.finding.noteIds.length,
    offset,
    notes: hydrate(db, result.finding.noteIds.slice(offset, offset + limit)),
  };
}
