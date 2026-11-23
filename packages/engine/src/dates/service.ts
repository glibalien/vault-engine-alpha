import type Database from 'better-sqlite3';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { fileHeldValues, heldValueText } from '../field-guess/file-held.js';
import { createFieldMap } from '../fields/field-map.js';
import { readableNoteDate } from '../memories/service.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { ContentHashMismatchError, StaleNodeError, executeMutation } from '../pipeline/execute.js';
import { PipelineError } from '../pipeline/types.js';
import { getVaultSettings } from '../settings/vault.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { calendarDate, wikiTimeZone } from '../wiki/today.js';
import { orderEvidence, orderOf, readDates, type DateOrder, type ReadDate } from './read.js';

/**
 * Date recovery (#647): for a note with no date the system can read, propose one from what the
 * note itself holds. Read-only here; the tool writes the proposals it is asked to.
 *
 * A note's date is read from its date field, else from a YYYY-MM-DD day in its title, and never
 * from the file time (`readableNoteDate`). An exported note often has neither, though the date
 * is there in another form. In order, a proposal comes from:
 *
 * 1. the date field's own text, written some other way (`March 4, 2021`);
 * 2. another frontmatter field named for the note's date (`meeting date`, `when`, `start`),
 *    then one named for when it was made (`created`). A name with any other word in it
 *    (`due date`, `release date`) is a date about something else, and is not read;
 * 3. the title, in a form other than YYYY-MM-DD (`2021_03_04`, `4 Mar 2021`);
 * 4. the first lines of the text: a labelled line (`Date: …`), or a line that is only a date;
 * 5. a field named for the last edit (`updated`, `modified`);
 * 6. the file's time, only when asked for.
 *
 * The owner's decision (2026-11-18): a date is **sure** when it is in a clear form in the
 * frontmatter or the title. It is **unsure**, listed with where it came from and written only
 * when the caller asks, when day and month could be either way round, the year has two digits,
 * it comes from a line of the text, a last-edit field or the file time, or writing it would
 * replace text the date field holds. A span of days (`March 4-6, 2021`) is read as its first
 * day and is unsure too. The first sure candidate wins; else the first unsure one.
 */

export const DATE_LIMITS = {
  defaultPage: 50,
  maxPage: 200,
  /** Notes written per call; a run over more is repeated until none remain. */
  maxWrites: 500,
  /** Notes tried per call, written or not: a bound on one call's time when many cannot be written. */
  maxAttempts: 5_000,
  /** Lines at the top of a note's text that are read for a date. */
  bodyLines: 10,
  /** Longest source text shown. */
  shownChars: 80,
} as const;

export class DateRecoveryError extends Error {
  override readonly name = 'DateRecoveryError';
  constructor(readonly code: 'INVALID_PARAMS', message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export type DateSource = 'date_field' | 'field' | 'title' | 'body' | 'file_time';
export type DateDoubt = 'day_or_month' | 'two_digit_year' | 'date_range' | 'body_line' | 'last_edited' | 'file_time' | 'replaces_text' | 'file_only_text' | 'sources_disagree';

/** Another day a note states, beside the one proposed. */
export interface OtherDate {
  date: string;
  from: DateSource;
  field?: string;
  where: string;
}

export interface DateProposal {
  id: string;
  title: string;
  path: string;
  /** YYYY-MM-DD, or null when day and month could be either way and nothing says which. */
  date: string | null;
  from: DateSource;
  /** The field, or the label of the line, it was read from. */
  field?: string;
  /** The text it was read from. */
  where: string;
  sure: boolean;
  /**
   * Whether a run can write it at all: not when it has no reading. A date over text only the
   * note's file has (`file_only_text`) is writable since undo puts that text back (#656), and
   * unsure, so it is written only when asked.
   */
  writable: boolean;
  /** Why it is unsure. */
  doubts: DateDoubt[];
  /** For an either-way date: day first, then month first. */
  readings?: [string, string];
  /** The text the date field holds now, which is not a date and which writing would replace. */
  replaces?: string;
  /**
   * The other days the note states, when they are not this one (`sources_disagree`). An export's
   * `created` is often the day it was exported, while the note's own "Date:" line says when it
   * happened: which is the note's date is for the user to say.
   */
  also?: OtherDate[];
}

export interface DateScanRequest {
  types?: string[];
  path_prefix?: string;
  node_ids?: string[];
  /** Also propose the file's time for a note with nothing else. Always unsure: an export resets file times. */
  use_file_time?: boolean;
}

export interface DateScan {
  dateField: string;
  /** Notes in scope, and those with no readable date. */
  notes: number;
  undated: number;
  /** One per undated note that holds a date in some form, newest note first. */
  proposals: DateProposal[];
  /** Undated notes that hold no date in any form read. */
  none: number;
  /** The day/month order this scan learned, by source, to be remembered when a run writes. */
  learned: Map<string, DateOrder>;
}

/** What a field's name says its date is: the note's own, when it was made, or when it was last edited. */
type Rank = 'dated' | 'created' | 'edited';

// A name says a date is the note's own only when every word of it is one of these: `date`,
// `meeting date`, `created at`, `lastModified`. One other word makes it a date about something
// else (`due date`, `release date`, `date of birth`), which is not read.
const DATE_WORDS = new Set(['date', 'day', 'when', 'datetime', 'timestamp', 'time', 'on', 'held', 'start', 'started']);
const NOTE_WORDS = new Set(['meeting', 'note', 'entry', 'journal', 'event', 'call', 'session', 'log', 'page', 'of', 'the', 'at']);
const CREATED_WORDS = new Set(['created', 'creation', 'create', 'added']);
const EDITED_WORDS = new Set(['updated', 'update', 'modified', 'modification', 'edited', 'changed', 'last']);

function rankOf(name: string): Rank | null {
  // `createdAt` and `date_created` are the words "created at" and "date created".
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}]+/u).filter(word => word !== '');
  if (words.length === 0) return null;
  const only = (...sets: Array<Set<string>>): boolean => words.every(word => sets.some(set => set.has(word)));
  const some = (set: Set<string>): boolean => words.some(word => set.has(word));
  if (some(EDITED_WORDS)) return only(EDITED_WORDS, DATE_WORDS, NOTE_WORDS) ? 'edited' : null;
  if (some(CREATED_WORDS)) return only(CREATED_WORDS, DATE_WORDS, NOTE_WORDS) ? 'created' : null;
  return some(DATE_WORDS) && only(DATE_WORDS, NOTE_WORDS) ? 'dated' : null;
}

interface Candidate {
  from: DateSource;
  field?: string;
  /** For a frontmatter field: what its name says the date is (`rankOf`). */
  rank?: Rank;
  read: ReadDate;
  /** What learns and gives the day/month order: values of one field, titles, or lines under one label. */
  orderKey: string;
  doubts: DateDoubt[];
}

const shown = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DATE_LIMITS.shownChars ? `${flat.slice(0, DATE_LIMITS.shownChars - 1)}…` : flat;
};

/** A stored field value, in whichever column it is kept. An unquoted `20210304` is kept as a number. */
interface Stored { value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }

/** A stored field value as text a date can be read from. */
function textOf(row: Stored): string | null {
  if (row.value_date !== null) return row.value_date;
  if (row.value_text !== null) return row.value_text;
  if (row.value_number !== null) return String(row.value_number);
  if (row.value_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    // A one-item list is its item; a longer list or a map is not one date.
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') return parsed[0];
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const LABELLED = /^\s*(?:[-*+]\s+)?(?:[*_]{1,2})?([\p{L}][\p{L} _-]{0,30}?)(?:[*_]{1,2})?\s*[:：]\s*(?:[*_]{1,2})?\s*(.+?)\s*$/u;

/** Whether a line is a date and nothing else: markup, a weekday and a time of day may stand beside it. */
function isOnlyADate(line: string, dateText: string): boolean {
  const rest = line.replace(dateText, ' ')
    // A weekday's name or its usual short form, and no other word that starts like one ("monthly", "sunny").
    .replace(/\b(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b\.?/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?/gi, ' ')
    .replace(/\b(at|on)\b/gi, ' ');
  return !/[\p{L}\p{N}]/u.test(rest);
}

/** A line near the top of a note's text that may hold its date: under a date-like label, or on its own. */
interface TopLine { text: string; label?: string; rank?: Rank; orderKey: string }

/** The first lines of a note's text, outside code, that are read for a date. */
function topLines(body: string): TopLine[] {
  const lines: TopLine[] = [];
  let read = 0;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || line.trim() === '') continue;
    if (++read > DATE_LIMITS.bodyLines) break;
    const labelled = LABELLED.exec(line);
    const rank = labelled ? rankOf(labelled[1]!) : null;
    if (labelled && rank !== null) {
      const label = labelled[1]!.trim();
      lines.push({ text: labelled[2]!, label, rank, orderKey: `body:${label.toLowerCase()}` });
    } else if (!labelled || rankOf(labelled[1]!) === null) {
      lines.push({ text: line, orderKey: 'body' });
    }
  }
  return lines;
}

/** The dates the first lines of a note's text hold: under a date-like label, or on a line of their own. */
function bodyCandidates(body: string, now: Date): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of topLines(body)) {
    const found = readDates(line.text, { now });
    if (line.label !== undefined) {
      if (found[0]) {
        candidates.push({ from: 'body', field: line.label, read: found[0], orderKey: line.orderKey, doubts: ['body_line', ...(line.rank === 'edited' ? ['last_edited' as const] : [])] });
      }
    } else if (found.length === 1 && isOnlyADate(line.text.replace(/^[\s#>*_-]+/, ''), found[0]!.text)) {
      candidates.push({ from: 'body', read: found[0]!, orderKey: line.orderKey, doubts: ['body_line'] });
    }
  }
  return candidates;
}

interface Undated {
  id: string;
  title: string;
  path: string;
  /** What the date field holds, as text, when it holds anything: text, a list, a link. */
  held: string | null;
  /** That text is in the note's file alone: the field refused it, and no snapshot has it. */
  fileOnly: boolean;
  candidates: Candidate[];
  mtime: number | null;
}

const ORDERS_KEY = 'date_recovery.orders';

/**
 * The day/month orders earlier runs learned. A run that writes a date over `25/03/2021` in the
 * date field removes the very evidence that told how `03/04/2021` beside it reads, so what a
 * writing run learned is kept, and used for a source the vault no longer shows any evidence for.
 */
function storedOrders(db: Database.Database): Map<string, DateOrder> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ORDERS_KEY) as { value: string } | undefined;
  const orders = new Map<string, DateOrder>();
  if (!row) return orders;
  try {
    for (const [key, order] of Object.entries(JSON.parse(row.value) as Record<string, unknown>)) {
      if (order === 'day_first' || order === 'month_first') orders.set(key, order);
    }
  } catch {
    // Unreadable: learn again.
  }
  return orders;
}

/** Remember what a scan learned, before its run writes. What the vault shows now replaces what was kept for the same source. */
export function rememberOrders(db: Database.Database, learned: ReadonlyMap<string, DateOrder>): void {
  if (learned.size === 0) return;
  const orders = storedOrders(db);
  for (const [key, order] of learned) orders.set(key, order);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ORDERS_KEY, JSON.stringify(Object.fromEntries(orders)));
}

/** What a stored field holds, as text to show, or null when it holds nothing. A list or a map is something. */
function occupiedText(row: Stored): string | null {
  if (row.value_date !== null) return row.value_date;
  if (row.value_text !== null) return row.value_text.trim() === '' ? null : row.value_text;
  if (row.value_number !== null) return String(row.value_number);
  if (row.value_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    if (parsed === null || (Array.isArray(parsed) && parsed.length === 0)) return null;
    return heldValueText(parsed);
  } catch {
    return row.value_json;
  }
}

/** Every note in scope with no readable date, and what each holds that could be one. */
export function scanDates(
  db: Database.Database, request: DateScanRequest,
  options: { settingsDir?: string; vaultPath?: string; now?: Date } = {},
): DateScan {
  const vault = getVaultSettings(db);
  const dateField = vault.dateField;
  if (dateField === null) {
    throw new DateRecoveryError('INVALID_PARAMS', 'No date field is set in the vault map (dateField), so there is nowhere to write a date. Name one with update-settings on the vault domain.');
  }
  const now = options.now ?? new Date();
  const user = userNotesWhere({ vault, settingsDir: options.settingsDir });
  // Every note of the user's is read, and the request narrows which get a proposal: how a vault
  // writes its dates is learned from all of them, so a narrow run reads `03/04/2021` the same way
  // a wide one does, and a note keeps its reading after its neighbours have been dated.
  const scope: string[] = [];
  const scopeParams: string[] = [];
  if (request.types && request.types.length > 0) {
    scope.push(`EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type IN (${request.types.map(() => '?').join(', ')}))`);
    scopeParams.push(...request.types);
  }
  if (request.path_prefix) {
    scope.push(`n.file_path LIKE ? ${LIKE_ESCAPE}`);
    scopeParams.push(literalPrefixPattern(request.path_prefix));
  }
  if (request.node_ids && request.node_ids.length > 0) {
    scope.push(`n.id IN (${request.node_ids.map(() => '?').join(', ')})`);
    scopeParams.push(...request.node_ids);
  }
  const rows = db.prepare<string[], {
    id: string; title: string | null; path: string; body: string | null; mtime: number | null; in_scope: number;
    value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; raw: string | null;
  }>(
    `SELECT n.id, n.title, n.file_path AS path, n.body, n.file_mtime AS mtime, f.value_text, f.value_number, f.value_date, f.value_json, f.value_raw_text AS raw,
       (${scope.length === 0 ? '1' : scope.join(' AND ')}) AS in_scope
     FROM nodes n LEFT JOIN node_fields f ON f.node_id = n.id AND f.field_name = ?
     WHERE ${user.sql} ORDER BY n.file_mtime DESC, n.id`,
  );
  const otherFields = db.prepare<[string, string], Stored & { name: string }>(
    'SELECT field_name AS name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ? AND field_name != ? ORDER BY field_name',
  );
  // A task's due and scheduled dates are named in the vault map, whatever they are called.
  const notTheNotesDate = new Set([vault.dueField, vault.scheduledField].filter((name): name is string => name !== null));
  // A defined field can refuse what is typed into it ("TBD" in a date field): the text then stays
  // in the note's file and is stored nowhere (#501). It is the date field's text all the same,
  // so where the database holds nothing for a defined date field, the file is read for it.
  const refuses = options.vaultPath !== undefined && db.prepare('SELECT 1 FROM global_fields WHERE name = ?').get(dateField) !== undefined;

  // The order day and month are written in, per field, for titles, and per label of a line: one
  // entry for every date in the vault that can be read one way only.
  const evidence = new Map<string, DateOrder[]>();
  const learn = (key: string, text: string): void => {
    const orders = orderEvidence(text, now);
    if (orders.length === 0) return;
    const known = evidence.get(key);
    if (known) known.push(...orders);
    else evidence.set(key, orders);
  };
  const fieldTexts = db.prepare<string[], { name: string; text: string }>(
    `SELECT f.field_name AS name, f.value_text AS text FROM node_fields f JOIN nodes n ON n.id = f.node_id
     WHERE ${user.sql} AND f.value_text IS NOT NULL`,
  );
  for (const field of fieldTexts.iterate(...user.params)) {
    if (field.name === dateField || (!notTheNotesDate.has(field.name) && rankOf(field.name) !== null)) learn(`field:${field.name}`, field.text);
  }

  let notes = 0;
  const undated: Undated[] = [];
  for (const row of rows.iterate(...scopeParams, dateField, ...user.params)) {
    learn('title', row.title ?? '');
    for (const line of topLines(row.body ?? '')) learn(line.orderKey, line.text);
    if (row.in_scope !== 1) continue;
    notes += 1;
    // The same reading as `evidenceNoteDate`: the stored date or text of the field, then the title.
    if (readableNoteDate(row.value_date ?? row.value_text, row.title) !== null) continue;
    const title = row.title ?? '';
    // What the field holds is tracked apart from whether a date can be read from it: a list of
    // two items or a map is no date, and is still something a write would replace.
    let held = occupiedText(row);
    let readable = textOf(row);
    let fileOnly = false;
    if (refuses && held === null) {
      const inFile = fileHeldValues(options.vaultPath!, row.path, [dateField], () => false).get(dateField);
      if (inFile !== undefined) {
        held = heldValueText(inFile);
        readable = typeof inFile === 'string' ? inFile : null;
        fileOnly = true;
      }
    }
    const candidates: Candidate[] = [];
    if (held !== null) {
      // The field's own text is rewritten without asking only when it is the date and nothing
      // else. A link (`[[March 4, 2021]]`, to a daily note) or words beside the date
      // (`March 4, 2021 (tentative)`) would be dropped, so that is asked for, not assumed.
      const linked = row.raw !== null && row.raw.includes('[[');
      for (const read of readDates(readable ?? '', { now }).slice(0, 1)) {
        // A span of days is more than its first day: writing that day drops the rest.
        const onlyTheDate = !linked && read.range !== true && isOnlyADate(readable!, read.text);
        candidates.push({ from: 'date_field', field: dateField, read, orderKey: `field:${dateField}`, doubts: onlyTheDate ? [] : ['replaces_text'] });
      }
      if (linked) held = row.raw!;
    }
    const ranked: Record<Rank, Candidate[]> = { dated: [], created: [], edited: [] };
    for (const field of otherFields.iterate(row.id, dateField)) {
      const rank = notTheNotesDate.has(field.name) ? null : rankOf(field.name);
      const text = rank === null ? null : textOf(field);
      if (rank === null || text === null) continue;
      for (const read of readDates(text, { now }).slice(0, 1)) {
        ranked[rank].push({ from: 'field', field: field.name, rank, read, orderKey: `field:${field.name}`, doubts: rank === 'edited' ? ['last_edited'] : [] });
      }
    }
    candidates.push(...ranked.dated, ...ranked.created);
    // The last date in a title is its date, as with the YYYY-MM-DD form.
    const inTitle = readDates(title, { now }).at(-1);
    if (inTitle) candidates.push({ from: 'title', read: inTitle, orderKey: 'title', doubts: [] });
    candidates.push(...bodyCandidates(row.body ?? '', now), ...ranked.edited);
    undated.push({ id: row.id, title, path: row.path, held, fileOnly, candidates, mtime: row.mtime });
  }

  // What the vault shows now decides; where it shows nothing for a source, what an earlier run learned.
  const learned = new Map<string, DateOrder>();
  const orders = new Map<string, DateOrder | null>(storedOrders(db));
  for (const [key, seen] of evidence) {
    const order = orderOf(seen);
    orders.set(key, order);
    if (order !== null) learned.set(key, order);
  }

  const proposals: DateProposal[] = [];
  const zone = wikiTimeZone(db);
  let none = 0;
  for (const note of undated) {
    type Option = Omit<DateProposal, 'id' | 'title' | 'path'> & { strength: 'stated' | 'created' | 'other' };
    const options_: Option[] = note.candidates.map((candidate): Option => {
      const { read } = candidate;
      const order = orders.get(candidate.orderKey) ?? null;
      const date = read.date ?? (read.readings && order !== null ? read.readings[order === 'day_first' ? 0 : 1] : null);
      // A span of days is read as its first day, which may not be the day the note is about.
      const doubts: DateDoubt[] = [...(read.doubt === null ? [] : [read.doubt]), ...(read.range ? ['date_range' as const] : []), ...candidate.doubts];
      // Text in the date field that is not this date is someone's text: replacing it is asked for, not assumed.
      const replaces = note.held !== null && (candidate.from !== 'date_field' || doubts.includes('replaces_text')) ? note.held : undefined;
      if (replaces !== undefined && !doubts.includes('replaces_text')) doubts.push('replaces_text');
      if (note.fileOnly) doubts.push('file_only_text');
      return {
        // The date field and a field named for the note's date state it; `created` says when the note was made.
        strength: candidate.from === 'date_field' || candidate.rank === 'dated' ? 'stated' : candidate.rank === 'created' ? 'created' : 'other',
        date, from: candidate.from, ...(candidate.field === undefined ? {} : { field: candidate.field }),
        where: shown(read.text), sure: doubts.length === 0 && date !== null, writable: date !== null, doubts,
        ...(read.readings && read.doubt === 'day_or_month' ? { readings: read.readings } : {}),
        ...(replaces === undefined ? {} : { replaces: shown(replaces) }),
      };
    });
    // The file's time is for a note that holds no date in any form. A date that is written but
    // cannot be read one way (`03/04/2021`) is still the note's date: it is shown with both
    // readings, never replaced by an export's timestamp.
    if (request.use_file_time && note.mtime !== null && options_.length === 0) {
      // The day in the owner's time zone, as the suite's other dates are: a file saved late in the evening is that day's.
      const date = calendarDate(note.mtime, zone);
      options_.push({
        strength: 'other', date, from: 'file_time', where: date, sure: false, writable: true,
        doubts: ['file_time', ...(note.held !== null ? ['replaces_text' as const] : []), ...(note.fileOnly ? ['file_only_text' as const] : [])],
        ...(note.held === null ? {} : { replaces: shown(note.held) }),
      });
    }
    // A note that states two different days is sure of neither (found on the messy sample: ten
    // Evernote meetings whose `created` and title held the export date were written as sure,
    // while each note's "Date:" line said when the meeting was). A last edit comes after the
    // note's date and the file's time is an export's, so neither states one. And a note made on
    // another day than its meeting is no conflict: beside a field that states the date, a
    // `created` field that differs is left out.
    const dated = options_.filter(option => option.date !== null && option.from !== 'file_time' && !option.doubts.includes('last_edited'));
    const statesItsDate = dated.some(option => option.strength === 'stated');
    const counted = statesItsDate ? dated.filter(option => option.strength !== 'created') : dated;
    const disagree = new Set(counted.map(option => option.date)).size > 1;
    // Every dated source loses its "sure", the `created` left out of the comparison too: it is
    // no answer to two days the note states, and left sure it would be picked (Codex, #675).
    if (disagree) {
      for (const option of dated) {
        option.doubts.push('sources_disagree');
        option.sure = false;
      }
    }
    const chosen = options_.find(option => option.sure) ?? options_.find(option => option.date !== null) ?? options_[0];
    if (!chosen) { none += 1; continue; }
    const also: OtherDate[] = [];
    if (disagree) {
      for (const option of dated) {
        if (option.date === chosen.date || also.some(other => other.date === option.date)) continue;
        also.push({ date: option.date!, from: option.from, ...(option.field === undefined ? {} : { field: option.field }), where: option.where });
      }
    }
    const { strength: _strength, ...proposal } = chosen;
    proposals.push({ id: note.id, title: note.title, path: note.path, ...proposal, ...(also.length > 0 ? { also } : {}) });
  }
  return { dateField, notes, undated: undated.length, proposals, none, learned };
}

export interface DateWriteDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  syncLogger?: SyncLogger;
}

export interface DateWriteResult {
  /** Notes whose date was written. */
  written: string[];
  /** Notes left as they were, and why. */
  skipped: Array<{ id: string; path: string; reason: string }>;
  /** Proposals the run got to, written or skipped. */
  attempted: number;
}

/**
 * Write each proposal's date to its note's date field, one note at a time under one undo
 * operation. A note that cannot be written is skipped and the run goes on, as a bulk
 * `update-node` does: a file with an edit the Engine has not read yet, or a note that fails
 * validation for a reason of its own.
 */
export function writeDates(
  deps: DateWriteDeps, dateField: string, proposals: readonly DateProposal[], operationId: string,
  limits: { maxWrites: number; maxAttempts: number } = { maxWrites: DATE_LIMITS.maxWrites, maxAttempts: DATE_LIMITS.maxAttempts },
): DateWriteResult {
  const { db } = deps;
  const note = db.prepare<[string], { file_path: string; title: string | null; body: string | null; content_hash: string | null }>(
    'SELECT file_path, title, body, content_hash FROM nodes WHERE id = ?',
  );
  const typesOf = db.prepare<[string], { schema_type: string }>('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type');
  const fieldsOf = db.prepare<[string], { field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
  );
  const result: DateWriteResult = { written: [], skipped: [], attempted: 0 };
  for (const proposal of proposals) {
    if (!proposal.writable || proposal.date === null) continue;
    // The limit is on notes written: a note that cannot be written is passed over, or the
    // notes behind 500 unwritable ones would never be reached however often the run is repeated.
    if (result.written.length >= limits.maxWrites || result.attempted >= limits.maxAttempts) break;
    result.attempted += 1;
    const row = note.get(proposal.id);
    if (!row) {
      result.skipped.push({ id: proposal.id, path: proposal.path, reason: 'The note no longer exists.' });
      continue;
    }
    const fields = createFieldMap<unknown>();
    for (const field of fieldsOf.iterate(proposal.id)) fields[field.field_name] = reconstructValue(field);
    fields[dateField] = proposal.date;
    // An unclaimed field that held a link is written from its raw text, and a write that
    // leaves the stored one in place renders the old text again (#663).
    const rawFieldTexts = createFieldMap<string>();
    rawFieldTexts[dateField] = proposal.date;
    try {
      executeMutation(db, deps.writeLock, deps.vaultPath, {
        source: 'tool',
        node_id: proposal.id,
        file_path: row.file_path,
        title: row.title ?? proposal.title,
        types: typesOf.all(proposal.id).map(type => type.schema_type),
        fields,
        touchedFields: [dateField],
        raw_field_texts: rawFieldTexts,
        body: row.body ?? '',
        // An edit the watcher has not read yet is never written over.
        ...(row.content_hash === null ? {} : { expectedDiskContentHash: row.content_hash }),
      }, deps.syncLogger, { operation_id: operationId });
      result.written.push(proposal.id);
    } catch (error) {
      result.skipped.push({ id: proposal.id, path: row.file_path, reason: skipReason(error) });
    }
  }
  return result;
}

function skipReason(error: unknown): string {
  if (error instanceof ContentHashMismatchError) return 'The note has an edit the Engine has not read yet. Run again in a few seconds.';
  if (error instanceof StaleNodeError) return 'The note changed while the run was writing.';
  if (error instanceof PipelineError) {
    const first = error.validation?.issues.find(issue => issue.severity === 'error');
    return first ? `The note does not pass validation (${first.field ?? 'a field'}: ${first.message}), so it was not rewritten.` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

