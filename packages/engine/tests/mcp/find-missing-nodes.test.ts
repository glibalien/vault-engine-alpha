import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerCleanupReport } from '../../src/mcp/tools/cleanup-report.js';
import { registerFindMissingNodes } from '../../src/mcp/tools/find-missing-nodes.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { MISSING_LIMITS } from '../../src/missing-notes/service.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { SUITE_NOTE_FIELD } from '../../src/notes/suite-notes.js';
import { setStoredSettings } from '../../src/settings/store.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
let mtime = 1;

beforeEach(async () => {
  db = createTestDb();
  mtime = 1;
  server = new McpServer({ name: 'missing-test', version: '1' });
  registerFindMissingNodes(server, db, 'Settings');
  registerCleanupReport(server, db, 'Settings');
  registerQueryNodes(server, db);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

async function call(args: Record<string, unknown> = {}, name = 'find-missing-nodes') {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

interface Seed {
  id: string;
  path: string;
  types?: string[];
  /** A string is stored as text, a list as JSON, as the Engine stores them. */
  fields?: Record<string, string | string[]>;
  links?: Array<{ target: string; field?: string; resolved?: string }>;
}

/** Later notes are newer. */
function seed(note: Seed): void {
  const title = note.path.split('/').pop()!.replace(/\.md$/, '');
  db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime) VALUES (?, ?, ?, ?, ?)').run(note.id, note.path, title, '', mtime++);
  for (const type of note.types ?? []) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(note.id, type);
  for (const [name, value] of Object.entries(note.fields ?? {})) {
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_json) VALUES (?, ?, ?, ?)')
      .run(note.id, name, typeof value === 'string' ? value : null, typeof value === 'string' ? null : JSON.stringify(value));
  }
  for (const link of note.links ?? []) {
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
      .run(note.id, link.target, link.field ?? 'wiki-link', link.field ?? null, link.resolved ?? null);
  }
}

/** Kinds with a schema: create-node refuses a kind that has none. */
function kinds(...names: string[]): void {
  for (const name of names) createSchemaDefinition(db, { name, field_claims: [] });
}

type Name = {
  name: string; other_spellings: string[]; notes: number; body_links: number;
  fields: Array<{ field: string; links: number; plain_text: number }>; likely_type: string | null;
  examples: Array<{ id: string; title: string; path: string }>; create?: Record<string, unknown>;
};
const brief = (names: Name[]): Array<[string, number]> => names.map(entry => [entry.name, entry.notes]);

describe('find-missing-nodes', () => {
  it('is a read-only tool that takes no unknown arguments', async () => {
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'find-missing-nodes')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['fields', 'limit', 'min_notes', 'offset']);
    expect(await call({ nmae: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(await call({ limit: MISSING_LIMITS.maxNames + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it('lists the names links give that no note answers to, most-named first', async () => {
    kinds('person', 'company');
    seed({ id: 'acme', path: 'Companies/Acme.md', types: ['company'] });
    seed({ id: 'm1', path: 'Meetings/Kickoff.md', links: [{ target: 'Dana Whitfield' }, { target: 'Acme', resolved: 'acme' }, { target: 'diagram.png' }, { target: '#Notes' }] });
    seed({ id: 'm2', path: 'Meetings/Review.md', links: [{ target: 'dana whitfield.md' }, { target: 'Northwind' }] });
    seed({ id: 'm3', path: 'Meetings/Retro.md', links: [{ target: 'Dana Whitfield#Role', field: 'people involved' }, { target: 'Dana Whitfield' }] });
    // Written as a link although the note exists: left unresolved (a stale binding), but nothing is missing.
    seed({ id: 'm4', path: 'Meetings/Plan.md', links: [{ target: 'Acme' }] });

    const found = await call();
    expect(found.ok).toBe(true);
    expect(found.data).toMatchObject({ total_names: 2, total_notes: 3, offset: 0, scope: { notes: 5 } });
    const [dana, northwind] = found.data.names as Name[];
    expect(dana).toEqual({
      name: 'Dana Whitfield',
      other_spellings: ['dana whitfield.md'],
      notes: 3,
      body_links: 3,
      fields: [{ field: 'people involved', links: 1, plain_text: 0 }],
      likely_type: 'person',
      examples: [
        { id: 'm3', title: 'Retro', path: 'Meetings/Retro.md' },
        { id: 'm2', title: 'Review', path: 'Meetings/Review.md' },
        { id: 'm1', title: 'Kickoff', path: 'Meetings/Kickoff.md' },
      ],
      create: { title: 'Dana Whitfield', types: ['person'] },
    });
    expect(northwind).toMatchObject({ name: 'Northwind', notes: 1, body_links: 1, fields: [], likely_type: null, create: { title: 'Northwind' } });
  });

  it('reads plain names in the people and company fields', async () => {
    kinds('person', 'company');
    seed({ id: 'lee', path: 'People/Lee Okafor.md', types: ['person'] });
    // One string in the people field is several names; a list's items are names as written.
    seed({ id: 'm1', path: 'Meetings/Kickoff.md', fields: { 'people involved': 'Dana Whitfield, Lee Okafor; Priya Raman', company: 'Acme, Inc.' } });
    seed({ id: 'm2', path: 'Meetings/Review.md', fields: { 'people involved': ['Dana Whitfield', 'priya raman', ''], company: 'Acme, Inc.' } });
    // A value that is this note's own link is read once, as a link; other fields' text is not read for names.
    seed({ id: 'm3', path: 'Meetings/Retro.md', fields: { 'people involved': ['Dana Whitfield'], topic: 'Renewal pricing' }, links: [{ target: 'Dana Whitfield', field: 'people involved' }] });
    // Linked from the text and named in the field: one note, and the field still says what kind of name it is.
    seed({ id: 'm5', path: 'Meetings/Offsite.md', fields: { 'people involved': 'Sam Ortiz' }, links: [{ target: 'Sam Ortiz' }] });
    // Prose and a pasted link are not names.
    seed({ id: 'm4', path: 'Meetings/Plan.md', fields: { 'people involved': 'x'.repeat(MISSING_LIMITS.maxNameChars + 1), company: '[[Northwind]] and others' } });

    const found = await call();
    expect(brief(found.data.names)).toEqual([['Dana Whitfield', 3], ['Acme, Inc.', 2], ['Priya Raman', 2], ['Sam Ortiz', 1]]);
    const [dana, acme, priya, sam] = found.data.names as Name[];
    expect(sam).toMatchObject({ notes: 1, body_links: 1, fields: [{ field: 'people involved', links: 0, plain_text: 1 }], likely_type: 'person' });
    expect(dana).toMatchObject({ body_links: 0, fields: [{ field: 'people involved', links: 1, plain_text: 2 }], likely_type: 'person' });
    expect(acme).toMatchObject({ fields: [{ field: 'company', links: 0, plain_text: 2 }], likely_type: 'company', create: { title: 'Acme, Inc.', types: ['company'] } });
    expect(priya).toMatchObject({ other_spellings: ['priya raman'], fields: [{ field: 'people involved', links: 0, plain_text: 2 }] });
    // Lee has a note: not missing, but the value is not a link.
    expect(found.data.scope.plain_text_fields).toEqual([
      { field: 'people involved', role: 'people', missing: 3, with_a_note: 1 },
      { field: 'company', role: 'company', missing: 1, with_a_note: 0 },
    ]);
    expect(found.data.total_notes).toBe(4);
  });

  it('reads a link with a comma in it as one name', async () => {
    // A link's target is stored with its brackets stripped, so the people field holds "Whitfield, Dana".
    seed({ id: 'dana', path: 'People/Whitfield, Dana.md', types: ['person'] });
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': 'Whitfield, Dana' }, links: [{ target: 'Whitfield, Dana', field: 'people involved', resolved: 'dana' }] });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { 'people involved': 'Okafor, Lee' }, links: [{ target: 'Okafor, Lee', field: 'people involved' }] });
    // Plain text a note answers to as it stands is one name too.
    seed({ id: 'm3', path: 'Meetings/C.md', fields: { 'people involved': 'Whitfield, Dana' } });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Okafor, Lee', 1]]);
    expect(found.data.names[0]).toMatchObject({ fields: [{ field: 'people involved', links: 1, plain_text: 0 }] });
    expect(found.data.scope.plain_text_fields[0]).toEqual({ field: 'people involved', role: 'people', missing: 0, with_a_note: 1 });
  });

  it('takes a company name that ends like a file name', async () => {
    kinds('company');
    seed({ id: 'acme', path: 'Companies/Acme.com.md', types: ['company'] });
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { company: 'Northwind.ai' } });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { company: 'northwind.ai' } });
    // Linked, and its note exists: not plain text, and not missing.
    seed({ id: 'm3', path: 'Meetings/C.md', fields: { company: 'Acme.com' }, links: [{ target: 'Acme.com', field: 'company', resolved: 'acme' }] });
    seed({ id: 'm4', path: 'Meetings/D.md', fields: { company: 'Acme.com' } });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Northwind.ai', 2]]);
    expect(found.data.names[0]).toMatchObject({ other_spellings: ['northwind.ai'], likely_type: 'company', create: { title: 'Northwind.ai', types: ['company'] } });
    expect(found.data.scope.plain_text_fields).toContainEqual({ field: 'company', role: 'company', missing: 1, with_a_note: 1 });
  });

  it('reads a link to a heading in a field as the link it is', async () => {
    seed({ id: 'lee', path: 'People/Lee Okafor.md', types: ['person'] });
    // The stored value is the link's target with its brackets stripped, anchor included.
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': ['Dana Whitfield#Role', 'Lee Okafor#Bio'] },
      links: [{ target: 'Dana Whitfield#Role', field: 'people involved' }, { target: 'Lee Okafor#Bio', field: 'people involved', resolved: 'lee' }] });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Dana Whitfield', 1]]);
    expect(found.data.names[0]).toMatchObject({ fields: [{ field: 'people involved', links: 1, plain_text: 0 }] });
    expect(found.data.scope.plain_text_fields[0]).toEqual({ field: 'people involved', role: 'people', missing: 0, with_a_note: 0 });
  });

  it('points at the note a name already belongs to, by alias or near spelling', async () => {
    kinds('person', 'company');
    seed({ id: 'dana', path: 'People/Dana Whitfield.md', types: ['person'], fields: { aliases: ['Dana W'] } });
    seed({ id: 'west', path: 'Companies/Acme - West.md', types: ['company'] });
    // No link resolves by an alias, and none by a title its file name could not keep.
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': ['Dana W', 'Lee Okafor'] }, links: [{ target: 'Dana W' }, { target: 'Acme: West' }] });
    const names = new Map(((await call()).data.names as Array<Name & { existing_note?: unknown; create_note?: string }>).map(entry => [entry.name, entry]));
    expect(names.get('Dana W')).toMatchObject({ existing_note: { id: 'dana', title: 'Dana Whitfield', path: 'People/Dana Whitfield.md' } });
    expect(names.get('Dana W')!.create).toBeUndefined();
    expect(names.get('Dana W')!.create_note).toContain('already answers to this name');
    expect(names.get('Acme: West')).toMatchObject({ existing_note: { id: 'west' } });
    expect(names.get('Lee Okafor')).toMatchObject({ create: { title: 'Lee Okafor', types: ['person'] } });
    expect(names.get('Lee Okafor')!.existing_note).toBeUndefined();
  });

  it('keeps each link whole in a value that holds several', async () => {
    seed({ id: 'dana', path: 'People/Whitfield, Dana.md', types: ['person'] });
    seed({ id: 'lee', path: 'People/Lee Okafor.md', types: ['person'] });
    // "[[Whitfield, Dana]], [[Lee Okafor]]; Priya Raman, Lee" is stored with the brackets stripped.
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': 'Whitfield, Dana, Lee Okafor; Priya Raman, Lee' },
      links: [{ target: 'Whitfield, Dana', field: 'people involved', resolved: 'dana' }, { target: 'Lee Okafor', field: 'people involved', resolved: 'lee' }] });
    const found = await call();
    // The links are links; of the plain text, a link's target is cut out only where it is a whole name.
    expect(brief(found.data.names)).toEqual([['Lee', 1], ['Priya Raman', 1]]);
    expect(found.data.scope.plain_text_fields[0]).toEqual({ field: 'people involved', role: 'people', missing: 2, with_a_note: 0 });
  });

  it('reads an alias with a comma in it as one name', async () => {
    seed({ id: 'dana', path: 'People/Dana Whitfield.md', types: ['person'], fields: { aliases: ['Whitfield, Dana'] } });
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': 'Whitfield, Dana' } });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { 'people involved': 'Okafor, Lee' } });
    const names = new Map(((await call()).data.names as Array<Name & { existing_note?: unknown }>).map(entry => [entry.name, entry]));
    // The alias is one name, and its note exists; text that is nobody's alias is still two names.
    expect([...names.keys()].sort()).toEqual(['Lee', 'Okafor', 'Whitfield, Dana']);
    expect(names.get('Whitfield, Dana')).toMatchObject({ existing_note: { id: 'dana' } });
    expect(names.get('Whitfield, Dana')!.create).toBeUndefined();
  });

  it('finds the note a company name that ends like a file name is an alias of', async () => {
    kinds('company');
    seed({ id: 'northwind', path: 'Companies/Northwind Traders.md', types: ['company'], fields: { aliases: ['Northwind.ai'] } });
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { company: 'Northwind.ai' } });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { company: 'Initech.io' } });
    const names = new Map(((await call()).data.names as Array<Name & { existing_note?: unknown }>).map(entry => [entry.name, entry]));
    expect(names.get('Northwind.ai')).toMatchObject({ existing_note: { id: 'northwind', title: 'Northwind Traders' } });
    expect(names.get('Northwind.ai')!.create).toBeUndefined();
    expect(names.get('Initech.io')!.create).toEqual({ title: 'Initech.io', types: ['company'] });
  });

  it('takes a plain name with a slash as a title, and a link with one as a path', async () => {
    kinds('company');
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { company: 'AC/DC' }, links: [{ target: 'Clients/Northwind' }] });
    const names = new Map(((await call()).data.names as Name[]).map(entry => [entry.name, entry]));
    expect(names.get('AC/DC')!.create).toEqual({ title: 'AC/DC', types: ['company'] });
    expect(names.get('Clients/Northwind')!.create).toEqual({ title: 'Northwind', directory: 'Clients', override_default_directory: true });
  });

  it('leaves the kind out of create while the vault has no such kind', async () => {
    // A fresh export: people are named in a field long before a person kind exists.
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': ['Dana Whitfield'] } });
    const [dana] = (await call()).data.names as Array<Name & { create_note?: string }>;
    expect(dana).toMatchObject({ likely_type: 'person', create: { title: 'Dana Whitfield' } });
    expect(dana!.create).toEqual({ title: 'Dana Whitfield' });
    expect(dana!.create_note).toContain('create-schema');
  });

  it('leaves the kind out of create when its filename template would not answer to the name', async () => {
    createSchemaDefinition(db, { name: 'person', field_claims: [], filename_template: 'Contact - {title}.md' });
    createSchemaDefinition(db, { name: 'company', field_claims: [], filename_template: '{title}.md' });
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': ['Dana Whitfield'], company: 'Acme' } });
    const names = new Map(((await call()).data.names as Array<Name & { create_note?: string }>).map(entry => [entry.name, entry]));
    const dana = names.get('Dana Whitfield')!;
    expect(dana.likely_type).toBe('person');
    expect(dana.create).toEqual({ title: 'Dana Whitfield' });
    expect(dana.create_note).toContain('update-node add_types');
    const acme = names.get('Acme')!;
    expect(acme.create).toEqual({ title: 'Acme', types: ['company'] });
    expect(acme.create_note).toBeUndefined();
  });

  it('tells a field named like a link in the text from the text', async () => {
    // A field's link carries the field's name as its context; a link in the text carries its paragraph.
    db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime) VALUES (?, ?, ?, ?, ?)').run('m1', 'Meetings/A.md', 'A', '', 1);
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)').run('m1', 'Dana Whitfield', 'wiki-link', 'wiki-link');
    db.prepare('INSERT INTO nodes (id, file_path, title, body, file_mtime) VALUES (?, ?, ?, ?, ?)').run('m2', 'Meetings/B.md', 'B', '', 2);
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)').run('m2', 'Dana Whitfield', 'wiki-link', 'With [[Dana Whitfield]].');
    const [dana] = (await call()).data.names as Name[];
    expect(dana).toMatchObject({ notes: 2, body_links: 1, fields: [{ field: 'wiki-link', links: 1, plain_text: 0 }] });
  });

  it('reads the fields the vault map names, and none it sets to none', async () => {
    kinds('contact');
    setStoredSettings(db, 'vault', { peopleField: 'attendees', companyField: null, personType: 'contact' });
    seed({ id: 'm1', path: 'Meetings/Kickoff.md', fields: { attendees: ['Dana Whitfield'], 'people involved': 'Lee Okafor', company: 'Acme' } });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Dana Whitfield', 1]]);
    expect(found.data.names[0]).toMatchObject({ likely_type: 'contact', create: { title: 'Dana Whitfield', types: ['contact'] } });
    expect(found.data.scope.plain_text_fields).toEqual([{ field: 'attendees', role: 'people', missing: 1, with_a_note: 0 }]);
  });

  it('takes the kind from a reference field\'s target, and gives none when fields disagree', async () => {
    kinds('person', 'company');
    createGlobalField(db, { name: 'owner', field_type: 'reference', reference_target: 'person' });
    createGlobalField(db, { name: 'vendor', field_type: 'reference', reference_target: 'company' });
    seed({ id: 't1', path: 'Tasks/A.md', links: [{ target: 'Dana Whitfield', field: 'owner' }, { target: 'Northwind', field: 'vendor' }, { target: 'Initech', field: 'owner' }] });
    seed({ id: 't2', path: 'Tasks/B.md', links: [{ target: 'Initech', field: 'vendor' }, { target: 'People/Lee Okafor', field: 'owner' }] });
    const names = (await call()).data.names as Name[];
    const byName = new Map(names.map(entry => [entry.name, entry]));
    expect(byName.get('Dana Whitfield')).toMatchObject({ likely_type: 'person', create: { title: 'Dana Whitfield', types: ['person'] } });
    expect(byName.get('Northwind')).toMatchObject({ likely_type: 'company' });
    expect(byName.get('Initech')).toMatchObject({ notes: 2, likely_type: null, create: { title: 'Initech' } });
    // A name written as a path keeps its folder.
    expect(byName.get('People/Lee Okafor')!.create).toEqual({ title: 'Lee Okafor', directory: 'People', override_default_directory: true, types: ['person'] });
  });

  it('does not list a link left unresolved although a note by that name exists', async () => {
    // Two notes share the name, so a typed field's link binds to neither; creating a third would not help.
    seed({ id: 'a1', path: 'People/Dana Whitfield.md', types: ['person'] });
    seed({ id: 'a2', path: 'Archive/Dana Whitfield.md', types: ['person'] });
    seed({ id: 'm1', path: 'Meetings/Sync.md', fields: { 'people involved': ['Dana Whitfield', 'Lee Okafor'] }, links: [{ target: 'Dana Whitfield', field: 'people involved' }] });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Lee Okafor', 1]]);
  });

  it('narrows to names in given fields and to names enough notes name, and pages', async () => {
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': ['Dana Whitfield', 'Lee Okafor'], company: 'Acme' }, links: [{ target: 'Roadmap' }] });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { 'people involved': ['Dana Whitfield'], company: 'Acme' }, links: [{ target: 'Roadmap' }] });
    seed({ id: 'm3', path: 'Meetings/C.md', fields: { 'people involved': ['Dana Whitfield'] } });

    expect(brief((await call()).data.names)).toEqual([['Dana Whitfield', 3], ['Acme', 2], ['Roadmap', 2], ['Lee Okafor', 1]]);
    const people = await call({ fields: ['people involved'] });
    expect(brief(people.data.names)).toEqual([['Dana Whitfield', 3], ['Lee Okafor', 1]]);
    expect(people.data).toMatchObject({ total_names: 2, total_notes: 3 });
    expect(brief((await call({ fields: ['people involved', 'company'], min_notes: 2 })).data.names)).toEqual([['Dana Whitfield', 3], ['Acme', 2]]);

    const second = await call({ limit: 2, offset: 2 });
    expect(second.data).toMatchObject({ total_names: 4, total_notes: 3, offset: 2 });
    expect(brief(second.data.names)).toEqual([['Roadmap', 2], ['Lee Okafor', 1]]);

    expect(await call({ fields: ['atendees'] })).toMatchObject({
      ok: false, error: { code: 'INVALID_PARAMS', details: { unknown_fields: ['atendees'] } },
    });
  });

  it('reads only the user\'s notes', async () => {
    seed({ id: 'setting', path: 'Settings/Engine.md', links: [{ target: 'Model Note Title' }] });
    seed({ id: 'suite', path: 'Wikis/Journal.md', fields: { [SUITE_NOTE_FIELD]: 'journal', 'people involved': 'Nobody Real' }, links: [{ target: 'Nobody' }] });
    seed({ id: 'wiki', path: 'Wikis/Alpha Wiki.md', types: ['wiki'], fields: { company: 'Invented Co' }, links: [{ target: 'Invented Person' }] });
    seed({ id: 'm1', path: 'Meetings/Sync.md', links: [{ target: 'Dana Whitfield' }] });
    const found = await call();
    expect(brief(found.data.names)).toEqual([['Dana Whitfield', 1]]);
    expect(found.data.scope.notes).toBe(1);
  });

  it('agrees with the clean-up report\'s row on the names links give', async () => {
    seed({ id: 'm1', path: 'Meetings/A.md', fields: { 'people involved': 'Priya Raman' }, links: [{ target: 'Dana Whitfield' }, { target: 'Northwind' }] });
    seed({ id: 'm2', path: 'Meetings/B.md', links: [{ target: 'dana whitfield' }] });
    const report = await call({ examples: 10 }, 'cleanup-report');
    const row = report.data.rows.find((entry: { id: string }) => entry.id === 'missing-notes');
    expect(row.next.map((step: { tool: string }) => step.tool)).toEqual(['cleanup-report', 'find-missing-nodes', 'create-node']);

    const found = await call(row.next[1].arguments);
    const linked = (found.data.names as Name[]).filter(entry => entry.body_links > 0 || entry.fields.some(field => field.links > 0));
    expect(linked.map(entry => ({ value: entry.name, notes: entry.notes }))).toEqual(row.examples);
    // The tool adds the name written as plain text, which the row does not count.
    expect(brief(found.data.names)).toEqual([['Dana Whitfield', 2], ['Northwind', 1], ['Priya Raman', 1]]);
  });

  it('names the notes a caller can then find with query-nodes', async () => {
    seed({ id: 'm1', path: 'Meetings/A.md', links: [{ target: 'Dana Whitfield' }] });
    seed({ id: 'm2', path: 'Meetings/B.md', fields: { 'people involved': 'Dana Whitfield, Lee Okafor' } });
    const [dana] = (await call()).data.names as Name[];
    const byLink = await call({ references: { target: dana!.name }, select: ['id'] }, 'query-nodes');
    const byText = await call({ fields: { 'people involved': { contains: dana!.name } }, select: ['id'] }, 'query-nodes');
    const ids = (result: { data: { nodes: Array<{ id: string }> } }): string[] => result.data.nodes.map(node => node.id);
    expect([...ids(byLink), ...ids(byText)].sort()).toEqual(dana!.examples.map(note => note.id).sort());
  });
});
