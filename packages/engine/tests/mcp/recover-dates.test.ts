import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { DATE_LIMITS, scanDates, writeDates } from '../../src/dates/service.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerCleanupReport } from '../../src/mcp/tools/cleanup-report.js';
import { registerRecoverDates } from '../../src/mcp/tools/recover-dates.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { evidenceNoteDate } from '../../src/memories/service.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createOperation } from '../../src/undo/operation.js';
import { restoreOperation } from '../../src/undo/restore.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'dates-test', version: '0' });
  registerRecoverDates(server, db, writeLock, vaultPath, undefined, undefined, 'Settings');
  registerCleanupReport(server, db, 'Settings');
  registerUndoOperations(server, db, writeLock, vaultPath);
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

interface Envelope {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string };
  warnings: Array<{ code: string }>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text) as Envelope;
}
const recover = (args: Record<string, unknown> = {}): Promise<Envelope> => call('recover-dates', args);

interface Seed { types?: string[]; fields?: Record<string, unknown>; body?: string }

/** Create a note through the pipeline, so its file is written. Returns its id. */
function note(path: string, seed: Seed = {}): string {
  const title = path.split('/').pop()!.replace(/\.md$/, '');
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: path, title, types: seed.types ?? [], fields: seed.fields ?? {}, body: seed.body ?? '',
  }).node_id;
}
const file = (path: string): string | null => (existsSync(join(vaultPath, path)) ? readFileSync(join(vaultPath, path), 'utf8') : null);
type Proposal = { id: string; title: string; date: string | null; from: string; field?: string; where: string; sure: boolean; writable: boolean; doubts: string[]; readings?: string[]; replaces?: string; also?: Array<{ date: string; from: string; field?: string; where: string }> };
const byTitle = (envelope: Envelope): Map<string, Proposal> => new Map((envelope.data.proposals as Proposal[]).map(proposal => [proposal.title, proposal]));

describe('recover-dates', () => {
  it('previews by default, and reads each source in its order', async () => {
    note('Dated/2021-03-04 Sync.md');
    note('Dated/Field.md', { fields: { date: '2021-03-04' } });
    note('A/Written out.md', { fields: { date: 'March 4, 2021' } });
    note('A/Other field.md', { fields: { 'meeting date': '2021-03-05', created: '2020-01-01', due: '2022-02-02' } });
    note('A/Created only.md', { fields: { created: '2021-03-06T10:30' } });
    note('A/Sync 2021_03_07.md');
    note('A/Standup 8 Mar 2021.md', { fields: { modified: '2024-06-01' } });
    note('A/Labelled.md', { body: '# Notes\n\nDate: March 9, 2021\nAttendees: Dana, Lee\n' });
    note('A/Own line.md', { body: '# Retro\n\n**Thursday, March 10, 2021 at 10:30**\n\nWe agreed to ship by April 2, 2021.\n' });
    note('A/Edited only.md', { fields: { updated: '2021-03-11' } });
    note('A/In a sentence.md', { body: 'We agreed to ship by April 2, 2021.\n' });
    note('A/Nothing.md', { body: 'No date here.' });
    const before = db.serialize();

    const preview = await recover();
    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({
      dry_run: true, date_field: 'date',
      scope: { notes: 12, undated: 10, sure: 5, unsure: 3, unreadable: 0, none: 2 },
      would_write: 5, total: 8, offset: 0,
    });
    const found = byTitle(preview);
    expect(found.get('Written out')).toMatchObject({ date: '2021-03-04', from: 'date_field', field: 'date', where: 'March 4, 2021', sure: true, doubts: [] });
    // A field named for the note's date comes before one for when it was made; a due date is neither.
    expect(found.get('Other field')).toMatchObject({ date: '2021-03-05', from: 'field', field: 'meeting date', sure: true });
    expect(found.get('Created only')).toMatchObject({ date: '2021-03-06', from: 'field', field: 'created', sure: true });
    expect(found.get('Sync 2021_03_07')).toMatchObject({ date: '2021-03-07', from: 'title', where: '2021_03_07', sure: true });
    // The title is sure; a last-edit field is not, and comes after it.
    expect(found.get('Standup 8 Mar 2021')).toMatchObject({ date: '2021-03-08', from: 'title', sure: true });
    expect(found.get('Labelled')).toMatchObject({ date: '2021-03-09', from: 'body', field: 'Date', sure: false, doubts: ['body_line'] });
    expect(found.get('Own line')).toMatchObject({ date: '2021-03-10', from: 'body', sure: false, doubts: ['body_line'] });
    expect(found.get('Edited only')).toMatchObject({ date: '2021-03-11', from: 'field', field: 'updated', sure: false, doubts: ['last_edited'] });
    expect(found.has('In a sentence')).toBe(false);
    expect(found.has('Nothing')).toBe(false);
    expect(db.serialize()).toEqual(before);
  });

  it('writes the sure dates as one undo, and the unsure ones only when asked', async () => {
    const sure = note('A/Sync 2021_03_07.md', { body: 'Text.' });
    const unsure = note('A/Labelled.md', { body: 'Date: March 9, 2021\n' });
    const other = note('A/Own line.md', { body: 'March 10, 2021\n' });
    const files = ['A/Sync 2021_03_07.md', 'A/Labelled.md', 'A/Own line.md'].map(file);

    const run = await recover({ dry_run: false });
    expect(run.ok).toBe(true);
    expect(run.data).toMatchObject({ dry_run: false, date_field: 'date', written: 1, skipped_count: 0, remaining: 0 });
    expect(evidenceNoteDate(db, sure)).toBe('2021-03-07');
    expect(file('A/Sync 2021_03_07.md')).toContain('date: 2021-03-07');
    expect(evidenceNoteDate(db, unsure)).toBeNull();

    // One checked note, by id.
    const asked = await recover({ dry_run: false, include_unsure: true, node_ids: [unsure] });
    expect(asked.data).toMatchObject({ written: 1, scope: { notes: 1, undated: 1, unsure: 1 } });
    expect(evidenceNoteDate(db, unsure)).toBe('2021-03-09');
    expect(evidenceNoteDate(db, other)).toBeNull();

    // A second run has nothing sure left, and opens no undo operation.
    const again = await recover({ dry_run: false });
    expect(again.data).toMatchObject({ written: 0, remaining: 0, scope: { undated: 1, sure: 0, unsure: 1 } });
    expect(again.data.operation_id).toBeUndefined();

    for (const operation of [asked.data.operation_id, run.data.operation_id]) {
      expect((await call('undo-operations', { operation_ids: [operation], dry_run: false })).ok).toBe(true);
    }
    expect(evidenceNoteDate(db, sure)).toBeNull();
    expect(['A/Sync 2021_03_07.md', 'A/Labelled.md', 'A/Own line.md'].map(path => file(path)!.includes('date:'))).toEqual([false, false, false]);
    expect(files.every(content => content !== null)).toBe(true);
  });

  it('reads an either-way date by the order its neighbours show', async () => {
    // Three notes from one export: two can only be day first, so the third is read that way.
    note('A/One.md', { fields: { created: '25/03/2021' } });
    note('A/Two.md', { fields: { created: '13/01/2021' } });
    const three = note('A/Three.md', { fields: { created: '03/04/2021' } });
    // No neighbour says which way a title's dates go.
    note('B/Call 03-04-2021.md');
    note('B/Short year.md', { fields: { created: '2021-03-04' }, body: '' });
    note('C/Two digits 5 Mar 21.md');

    const found = byTitle(await recover());
    expect(found.get('One')).toMatchObject({ date: '2021-03-25', sure: true });
    expect(found.get('Three')).toMatchObject({ date: '2021-04-03', sure: false, doubts: ['day_or_month'], readings: ['2021-04-03', '2021-03-04'] });
    expect(found.get('Call 03-04-2021')).toMatchObject({ date: null, sure: false, doubts: ['day_or_month'], readings: ['2021-04-03', '2021-03-04'] });
    expect(found.get('Two digits 5 Mar 21')).toMatchObject({ date: '2021-03-05', sure: false, doubts: ['two_digit_year'] });

    // The order is learned from every note, so it holds once the neighbours are dated, and for
    // a run that names one note.
    expect((await recover({ dry_run: false })).data.written).toBe(3);
    expect(byTitle(await recover()).get('Three')).toMatchObject({ date: '2021-04-03', doubts: ['day_or_month'] });
    expect((await recover({ node_ids: [three] })).data.proposals).toMatchObject([{ id: three, date: '2021-04-03' }]);

    const run = await recover({ dry_run: false, include_unsure: true });
    // A date with no reading is never written.
    expect(run.data).toMatchObject({ written: 2, scope: { unreadable: 1 } });
    expect((await recover()).data).toMatchObject({ scope: { undated: 1, unreadable: 1 }, would_write: 0 });
  });

  it('does not replace text in the date field unless asked', async () => {
    const tbd = note('A/Kickoff.md', { fields: { date: 'TBD', created: '2021-03-04' } });
    const preview = byTitle(await recover());
    expect(preview.get('Kickoff')).toMatchObject({ date: '2021-03-04', from: 'field', field: 'created', sure: false, doubts: ['replaces_text'], replaces: 'TBD' });
    expect((await recover({ dry_run: false })).data.written).toBe(0);
    expect(file('A/Kickoff.md')).toContain('date: TBD');
    expect((await recover({ dry_run: false, include_unsure: true })).data.written).toBe(1);
    expect(evidenceNoteDate(db, tbd)).toBe('2021-03-04');
  });

  it('counts text the date field refused as the field\'s text', async () => {
    createGlobalField(db, { name: 'date', field_type: 'date' });
    createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'date' }] });
    const id = note('Meetings/Kickoff.md', { types: ['meeting'], fields: { created: '2021-03-04' } });
    // "when legal agrees" is no date: the watcher stores nothing for it, and the file keeps it.
    writeFileSync(join(vaultPath, 'Meetings/Kickoff.md'), '---\ntypes:\n  - meeting\ncreated: 2021-03-04\ndate: when legal agrees\n---\n');
    processFileChange(join(vaultPath, 'Meetings/Kickoff.md'), 'Meetings/Kickoff.md', db, writeLock, vaultPath);
    expect(db.prepare("SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = 'date'").get(id)).toBeUndefined();

    const preview = await recover();
    expect(byTitle(preview).get('Kickoff')).toMatchObject({
      date: '2021-03-04', sure: false, writable: true, doubts: ['replaces_text', 'file_only_text'], replaces: 'when legal agrees',
    });
    expect(preview.data.scope).toMatchObject({ undated: 1, sure: 0, unsure: 1 });
    // Unsure: not written unasked.
    expect((await recover({ dry_run: false })).data.written).toBe(0);
    expect(file('Meetings/Kickoff.md')).toContain('date: when legal agrees');
    // Written when asked, and undo puts the text back (#656).
    const run = await recover({ dry_run: false, include_unsure: true, node_ids: [id] });
    expect(run.data.written).toBe(1);
    expect(evidenceNoteDate(db, id)).toBe('2021-03-04');
    expect(file('Meetings/Kickoff.md')).not.toContain('when legal agrees');
    restoreOperation(db, writeLock, vaultPath, run.data.operation_id, new Set([run.data.operation_id]));
    expect(file('Meetings/Kickoff.md')).toContain('date: when legal agrees');
    expect(db.prepare("SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = 'date'").get(id)).toBeUndefined();
  });

  it('asks before replacing anything else the date field holds', async () => {
    const tentative = note('A/Tentative.md', { fields: { date: 'March 4, 2021 (tentative; awaiting approval)' } });
    // A word that only starts like a weekday is a word beside the date.
    note('A/Monthly.md', { fields: { date: 'March 4, 2021 (monthly)' } });
    note('A/Short day.md', { fields: { date: 'Thu. 4 March 2021' } });
    // A span of days is more than its first day.
    note('A/Offsite.md', { fields: { date: 'March 4-6, 2021' } });
    note('A/Trip.md', { fields: { date: '2021-03-04 to 2021-03-06' } });
    note('A/Summit.md', { fields: { when: 'March 4-6, 2021' } });
    const listed = note('A/Listed.md', { fields: { date: ['TBD', 'awaiting approval'], created: '2021-03-05' } });
    note('A/Plain.md', { fields: { date: 'Thursday, March 4, 2021 at 10:30' } });

    const found = byTitle(await recover());
    // Words beside the date would be dropped with it.
    expect(found.get('Tentative')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: false, doubts: ['replaces_text'], replaces: 'March 4, 2021 (tentative; awaiting approval)' });
    // A list is no date, and is still something a write would replace.
    expect(found.get('Listed')).toMatchObject({ date: '2021-03-05', from: 'field', field: 'created', sure: false, doubts: ['replaces_text'], replaces: '["TBD","awaiting approval"]' });
    // The date and nothing else: a weekday and a time of day are part of it.
    expect(found.get('Plain')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: true });
    expect(found.get('Short day')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: true });
    expect(found.get('Monthly')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: false, doubts: ['replaces_text'], replaces: 'March 4, 2021 (monthly)' });

    expect(found.get('Offsite')).toMatchObject({ date: '2021-03-04', sure: false, doubts: ['date_range', 'replaces_text'], replaces: 'March 4-6, 2021' });
    // A field that starts with a YYYY-MM-DD day is read as that day already: the note has a date.
    expect(found.has('Trip')).toBe(false);
    expect(found.get('Summit')).toMatchObject({ date: '2021-03-04', from: 'field', field: 'when', sure: false, doubts: ['date_range'] });

    expect((await recover({ dry_run: false })).data.written).toBe(2);
    expect(file('A/Monthly.md')).toContain('(monthly)');
    expect(file('A/Offsite.md')).toContain('March 4-6, 2021');
    expect(file('A/Tentative.md')).toContain('tentative; awaiting approval');
    expect(file('A/Listed.md')).toContain('- TBD');
    expect((await recover({ dry_run: false, include_unsure: true, node_ids: [tentative, listed] })).data.written).toBe(2);
    expect(evidenceNoteDate(db, listed)).toBe('2021-03-05');
  });

  it('counts a number in the date field as something it holds', async () => {
    // An unquoted 20210304 is stored as a number.
    const compact = note('A/Compact.md', { fields: { date: 20210304 } });
    const other = note('A/Other.md', { fields: { date: 42, created: '2022-05-06' } });
    const made = note('A/Made.md', { fields: { created: 20220507 } });
    const found = byTitle(await recover());
    // The number is the date itself, written compactly.
    expect(found.get('Compact')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: true });
    // A number that is no date is still something a write would replace.
    expect(found.get('Other')).toMatchObject({ date: '2022-05-06', from: 'field', sure: false, doubts: ['replaces_text'], replaces: '42' });
    expect(found.get('Made')).toMatchObject({ date: '2022-05-07', from: 'field', field: 'created', sure: true });

    expect((await recover({ dry_run: false })).data.written).toBe(2);
    expect(evidenceNoteDate(db, compact)).toBe('2021-03-04');
    expect(evidenceNoteDate(db, made)).toBe('2022-05-07');
    expect(evidenceNoteDate(db, other)).toBeNull();
    expect(file('A/Other.md')).toContain('date: 42');
  });

  it('keeps the order it learned when writing removes the evidence', async () => {
    // Both dates are in the date field itself. Writing the first as 2021-03-25 leaves nothing
    // in the vault that says day first.
    note('A/One.md', { fields: { date: '25/03/2021' } });
    const two = note('A/Two.md', { fields: { date: '03/04/2021' } });
    expect(byTitle(await recover()).get('Two')).toMatchObject({ date: '2021-04-03', doubts: ['day_or_month'] });
    expect((await recover({ dry_run: false })).data.written).toBe(1);
    expect(byTitle(await recover()).get('Two')).toMatchObject({ date: '2021-04-03', doubts: ['day_or_month'] });
    expect((await recover({ dry_run: false, include_unsure: true, node_ids: [two] })).data.written).toBe(1);
    expect(evidenceNoteDate(db, two)).toBe('2021-04-03');
  });

  it('goes on past notes it cannot write', async () => {
    const blockedNote = note('A/One 2021_03_07.md');
    const fine = note('A/Two 2021_03_08.md');
    const later = note('A/Three 2021_03_09.md');
    writeFileSync(join(vaultPath, 'A/One 2021_03_07.md'), 'A line typed a second ago.\n');
    const scan = scanDates(db, {}, { settingsDir: 'Settings', vaultPath });
    const order = [blockedNote, fine, later].map(id => scan.proposals.find(proposal => proposal.id === id)!);
    const operation = createOperation(db, { source_tool: 'recover-dates', description: 'test' });
    // One note per call: the note that cannot be written does not use the call up.
    const result = writeDates({ db, writeLock, vaultPath }, scan.dateField, order, operation, { maxWrites: 1, maxAttempts: 10 });
    expect(result).toMatchObject({ written: [fine], attempted: 2 });
    expect(result.skipped.map(skipped => skipped.id)).toEqual([blockedNote]);
    expect(evidenceNoteDate(db, later)).toBeNull();
  });

  it('reads a field as the note\'s date only when its name says nothing else', async () => {
    const read = async (name: string): Promise<[string, boolean] | null> => {
      const id = note(`F/${name.replace(/[^a-z]/gi, '-')}.md`, { fields: { [name]: '2021-03-04' } });
      const found = (await recover({ node_ids: [id] })).data.proposals as Proposal[];
      return found.length === 0 ? null : [found[0]!.from, found[0]!.sure];
    };
    for (const name of ['when', 'Meeting Date', 'date_of_meeting', 'start', 'held on', 'created', 'createdAt', 'date created', 'Creation date']) {
      expect(await read(name), name).toEqual(['field', true]);
    }
    for (const name of ['updated', 'lastModified', 'date modified', 'last edited time']) {
      expect(await read(name), name).toEqual(['field', false]);
    }
    // A date about something else is not the note's date.
    for (const name of ['due', 'due date', 'release date', 'date of birth', 'birthday', 'end date', 'expires', 'completed', 'order date', 'updated price date', 'meeting']) {
      expect(await read(name), name).toBeNull();
    }
  });

  it('asks before replacing a link in the date field with a plain date', async () => {
    // "date: [[March 4, 2021]]" links a daily note: the stored value is the text, the raw text the link.
    const id = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'A/Linked.md', title: 'Linked', types: [],
      fields: { date: 'March 4, 2021' }, raw_field_texts: { date: '[[March 4, 2021]]' }, body: '',
    }).node_id;
    expect(file('A/Linked.md')).toContain('date: "[[March 4, 2021]]"');
    expect(byTitle(await recover()).get('Linked')).toMatchObject({ date: '2021-03-04', from: 'date_field', sure: false, doubts: ['replaces_text'], replaces: '[[March 4, 2021]]' });
    expect((await recover({ dry_run: false })).data.written).toBe(0);
    // Asked for, the date is what the file then holds, not the old link again.
    expect((await recover({ dry_run: false, include_unsure: true })).data.written).toBe(1);
    expect(file('A/Linked.md')).toContain('date: 2021-03-04');
    expect(evidenceNoteDate(db, id)).toBe('2021-03-04');
  });

  it('offers the file time only when asked, and never as sure', async () => {
    const id = note('A/Nothing.md', { body: 'No date here.' });
    db.prepare('UPDATE nodes SET file_mtime = ? WHERE id = ?').run(Date.parse('2022-05-06T12:00:00Z'), id);
    expect((await recover()).data).toMatchObject({ scope: { undated: 1, none: 1 }, proposals: [] });
    const asked = await recover({ use_file_time: true });
    expect(asked.data.proposals).toMatchObject([{ id, date: '2022-05-06', from: 'file_time', sure: false, doubts: ['file_time'] }]);
    expect(asked.data.would_write).toBe(0);

    // A date that is written but reads two ways is still the note's date, not the file's time.
    const either = note('A/Either.md', { fields: { created: '03/04/2021' } });
    db.prepare('UPDATE nodes SET file_mtime = ? WHERE id = ?').run(Date.parse('2023-01-02T12:00:00Z'), either);
    const both = byTitle(await recover({ use_file_time: true }));
    expect(both.get('Either')).toMatchObject({ date: null, from: 'field', field: 'created', readings: ['2021-04-03', '2021-03-04'], writable: false });
  });

  it('is unsure when the note states two different days', async () => {
    // An Evernote export: `created` and the title hold the day it was exported; the note's own
    // "Date:" line says when the meeting was.
    const exported = note('Evernote/Acme sync 20220725-2.md', { fields: { created: '2022-07-25T09:00:00Z' }, body: '**Date:** 2020-12-11\n**Attendees:** Dana\n' });
    // Only `created` and the text, as many converters leave it.
    const imported = note('Evernote/Kickoff.md', { fields: { created: '2023-01-02' }, body: 'Date: March 4, 2021\n' });
    // A note written ahead of its meeting: a field naming the meeting's date beside an older `created`.
    note('Meetings/Planning.md', { fields: { 'meeting date': '2021-03-05', created: '2021-02-20' } });
    // A meeting date and a title that disagree, beside an older `created`: none of the three is sure.
    note('Meetings/Kickoff 2021_03_06.md', { fields: { 'meeting date': '2021-03-05', created: '2021-02-20' } });
    // Two sources that agree.
    note('Meetings/Review 2021_03_06.md', { fields: { created: '2021-03-06' }, body: 'Date: 6 March 2021\n' });
    // A last edit after the note's day is no conflict.
    note('Meetings/Retro 2021_03_07.md', { fields: { modified: '2021-04-01' } });

    const found = byTitle(await recover());
    expect(found.get('Acme sync 20220725-2')).toMatchObject({
      date: '2022-07-25', from: 'field', field: 'created', sure: false, doubts: ['sources_disagree'],
      also: [{ date: '2020-12-11', from: 'body', field: 'Date', where: '2020-12-11' }],
    });
    expect(found.get('Kickoff')).toMatchObject({ date: '2023-01-02', sure: false, also: [{ date: '2021-03-04', from: 'body' }] });
    expect(found.get('Planning')).toMatchObject({ date: '2021-03-05', field: 'meeting date', sure: true, doubts: [] });
    expect(found.get('Planning')).not.toHaveProperty('also');
    expect(found.get('Review 2021_03_06')).toMatchObject({ date: '2021-03-06', sure: true });
    expect(found.get('Kickoff 2021_03_06')).toMatchObject({ date: '2021-03-05', field: 'meeting date', sure: false, doubts: ['sources_disagree'] });
    expect(found.get('Kickoff 2021_03_06')!.also!.map(other => other.date).sort()).toEqual(['2021-02-20', '2021-03-06']);
    expect(found.get('Retro 2021_03_07')).toMatchObject({ date: '2021-03-07', sure: true });

    // A run writes only what is sure; the user says which day the others are.
    expect((await recover({ dry_run: false })).data.written).toBe(3);
    expect(evidenceNoteDate(db, exported)).toBeNull();
    expect(evidenceNoteDate(db, imported)).toBeNull();
  });

  it('narrows by kind, folder and note, and pages', async () => {
    createSchemaDefinition(db, { name: 'meeting', field_claims: [] });
    const meeting = note('Meetings/Sync 2021_03_07.md', { types: ['meeting'] });
    note('Notes/Idea 2021_03_08.md');
    note('Notes/Plan 2021_03_09.md', { body: 'Date: 1 Feb 2021' });

    expect((await recover({ types: ['meeting'] })).data).toMatchObject({ scope: { notes: 1, undated: 1 }, proposals: [{ id: meeting }] });
    // The plan's title and its "Date:" line state two days: that one is unsure.
    expect((await recover({ path_prefix: 'Notes/' })).data.scope).toMatchObject({ notes: 2, sure: 1, unsure: 1 });
    expect((await recover({ node_ids: [meeting] })).data.scope).toMatchObject({ notes: 1 });
    expect((await recover({ only: 'unsure' })).data).toMatchObject({ total: 1, proposals: [{ title: 'Plan 2021_03_09', doubts: ['sources_disagree'] }] });
    const page = await recover({ limit: 1, offset: 1 });
    expect(page.data).toMatchObject({ total: 3, offset: 1 });
    expect(page.data.proposals).toHaveLength(1);

    expect(await recover({ limit: DATE_LIMITS.maxPage + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await recover({ nope: true })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('reads only the user\'s notes, and needs a date field to write to', async () => {
    note('Settings/Engine.md', { fields: { created: '2021-03-04' } });
    note('Wikis/Journal.md', { fields: { [SUITE_NOTE_FIELD]: 'journal', created: '2021-03-04' } });
    note('A/Mine.md', { fields: { created: '2021-03-04' } });
    expect((await recover()).data.scope).toMatchObject({ notes: 1, undated: 1, sure: 1 });

    setStoredSettings(db, 'vault', { dateField: null });
    expect(await recover()).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('skips a note with an edit the Engine has not read, and writes the rest', async () => {
    const a = note('A/One 2021_03_07.md');
    const b = note('A/Two 2021_03_08.md');
    writeFileSync(join(vaultPath, 'A/One 2021_03_07.md'), 'A line typed a second ago.\n');
    const run = await recover({ dry_run: false });
    expect(run.data).toMatchObject({ written: 1, skipped_count: 1, skipped: [{ id: a, path: 'A/One 2021_03_07.md' }] });
    expect(run.data.skipped[0].reason).toContain('has not read yet');
    expect(file('A/One 2021_03_07.md')).toBe('A line typed a second ago.\n');
    expect(evidenceNoteDate(db, b)).toBe('2021-03-08');
  });

  it('is what the clean-up report\'s row points at', async () => {
    createSchemaDefinition(db, { name: 'meeting', field_claims: [] });
    const meeting = note('Meetings/Sync 2021_03_07.md', { types: ['meeting'] });
    const report = await call('cleanup-report');
    const row = report.data.rows.find((entry: { id: string }) => entry.id === 'no-date');
    const step = row.next.find((entry: { tool: string }) => entry.tool === 'recover-dates');
    expect((await recover(step.arguments)).data).toMatchObject({ scope: { undated: 1, sure: 1 }, proposals: [{ id: meeting }] });
    await recover({ ...step.arguments, dry_run: false });
    const after = await call('cleanup-report');
    expect(after.data.rows.some((entry: { id: string }) => entry.id === 'no-date')).toBe(false);
  });
});
