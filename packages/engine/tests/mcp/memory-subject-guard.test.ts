import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { MemoryService } from '../../src/memories/service.js';
import { ConsolidationReplay } from '../../src/memories/consolidation-replay.js';
import { SubjectGuard } from '../../src/memories/subject-guard.js';
import { setStoredSettings } from '../../src/settings/store.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { ConsolidationInput, ConsolidationVerdict, MemoryConsolidator } from '../../src/mcp/tools/memory-consolidation.js';

// Fictional people and companies only (repository rule). Acme is the vault owner's employer.

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = await tool.handler(parsed, {});
  return JSON.parse(result.content[0].text);
}

const EV = { kind: 'conversation', ref: 'test#0' } as const;

function vec(theta: number): Float32Array {
  const v = new Float32Array(256);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
const at = (distance: number) => Math.acos(1 - distance);

function fakeEmbedder(map: Record<string, Float32Array>): Embedder {
  return {
    isReady: () => true,
    async embedQuery(text: string) { return map[text] ?? vec(Math.PI / 2); },
    async embedDocument(text: string) { return [map[text] ?? vec(Math.PI / 2)]; },
  };
}

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function note(d: Database.Database, id: string, filePath: string, types: string[]): void {
  const title = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
  d.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)').run(id, filePath, title, '', `h-${id}`);
  for (const type of types) d.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

function vault(d: Database.Database, owner = true): void {
  note(d, 'dana', 'People/Dana Whitfield.md', ['person']);
  note(d, 'lee', 'People/Lee Okafor.md', ['person']);
  note(d, 'avery', 'People/Avery Stone.md', ['person']);
  note(d, 'northwind', 'Companies/Northwind.md', ['company']);
  note(d, 'contoso', 'Companies/Contoso.md', ['company']);
  note(d, 'acme', 'Companies/Acme.md', ['company']);
  note(d, 'alpha', 'Projects/Alpha.md', ['project']);
  d.prepare("INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('avery', 'Acme', 'company', 'acme')").run();
  if (owner) setStoredSettings(d, 'vault', { ownerNote: 'Avery Stone' });
}

type Script = (input: ConsolidationInput) => ConsolidationVerdict | Error;

function setup(embeddings: Record<string, Float32Array>, script: Script, owner = true) {
  db = createTestDb();
  vault(db, owner);
  const state = { script, calls: [] as ConsolidationInput[] };
  const consolidator: MemoryConsolidator = {
    async consolidate(input) {
      state.calls.push(input);
      const answer = state.script(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const service = new MemoryService(db, { embedder: fakeEmbedder(embeddings), consolidator });
  const server = new McpServer({ name: 'test', version: '0' });
  registerMemoriesTools(server, service);
  const create = (content: string, subjects: string[], extra: Record<string, unknown> = {}) =>
    callTool(server, 'create-memory', { evidence: EV, source: 'curator', content, subjects, ...extra });
  const live = () => (db!.prepare('SELECT id FROM memories WHERE expired_at IS NULL ORDER BY id').all() as Array<{ id: number }>).map(r => r.id);
  return { server, service, create, live, state };
}

describe('the subject rule that keeps memories apart (#718)', () => {
  it('keeps apart different things of one kind, leaving out the owner\'s own companies', () => {
    db = createTestDb();
    vault(db);
    const guard = SubjectGuard.build(db);
    expect([...guard.ownCompanies]).toEqual(['acme']);
    expect(guard.apart(['northwind'], ['contoso'])).toBe(true);
    expect(guard.apart(['northwind', 'acme'], ['contoso', 'acme'])).toBe(true); // the employer is shared by most memories
    expect(guard.apart(['dana', 'northwind'], ['lee'])).toBe(true); // two people
    expect(guard.apart(['dana'], ['northwind'])).toBe(false); // a person and a company: subjects are often partial
    expect(guard.apart(['dana'], ['dana', 'northwind'])).toBe(false); // a shared subject
    expect(guard.apart(['acme'], ['northwind'])).toBe(false); // nothing left on one side
    expect(guard.apart([], ['northwind'])).toBe(false);
    expect(guard.apart(['alpha'], ['northwind'])).toBe(false);
  });

  it('counts the employer like any company when the vault map names no owner', () => {
    db = createTestDb();
    vault(db, false);
    const guard = SubjectGuard.build(db);
    expect(guard.ownCompanies.size).toBe(0);
    expect(guard.apart(['northwind', 'acme'], ['contoso', 'acme'])).toBe(false);
  });
});

describe('create-memory keeps look-alikes about different things apart (#718)', () => {
  it('adds a near-duplicate about another company, which it would otherwise refuse', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.01)) }, () => ({ operation: 'add', reason: 'unused' }));
    const first = await t.create('a', ['Northwind', 'Acme']);
    const second = await t.create('b', ['Contoso', 'Acme']);
    expect(second.ok).toBe(true);
    expect(second.data).toMatchObject({ operation: 'add', kept_apart: [first.data.id] });
    expect(t.live()).toEqual([first.data.id, second.data.id]);
    // The same text about the same company is still a duplicate.
    const third = await t.create('b', ['Northwind']);
    expect(third.ok).toBe(false);
    expect(third.error.code).toBe('DUPLICATE_MEMORY');
  });

  it('never offers such a look-alike for a merge verdict, so no update can replace it', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.2)) }, input => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' }));
    const first = await t.create('a', ['Northwind']);
    const second = await t.create('b', ['Contoso']);
    expect(t.state.calls).toHaveLength(0);
    expect(second.data).toMatchObject({ operation: 'add', kept_apart: [first.data.id] });
    expect(t.live()).toEqual([first.data.id, second.data.id]);
  });

  it('merges as before when the subjects are of different kinds, or one side has none', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.2)), c: vec(Math.PI / 4), d: vec(Math.PI / 4 + at(0.2)) },
      input => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' }));
    await t.create('a', ['Dana Whitfield']);
    const person = await t.create('b', ['Northwind']);
    expect(person.data.operation).toBe('update');
    expect(person.data).not.toHaveProperty('kept_apart');
    await t.create('c', ['Northwind']);
    const none = await t.create('d', []);
    expect(none.data.operation).toBe('update');
    expect(t.state.calls).toHaveLength(2);
  });
});

describe('the replay and the near pairs keep them apart too (#718)', () => {
  it('leaves a kept-apart look-alike out of the replay\'s comparison and counts it', async () => {
    const keyLimit = () => new Error('403 Key limit exceeded');
    const t = setup({ a: vec(0), b: vec(at(0.2)) }, () => keyLimit());
    await t.create('a', ['Northwind']);
    // Created before this rule would keep them apart: no subjects yet, so it was compared and its call failed.
    const second = await t.create('b', []);
    expect(second.warnings.map((w: { code: string }) => w.code)).toEqual(['MEMORY_CONSOLIDATION_FAILED']);
    await callTool(t.server, 'update-memory', { id: second.data.id, subjects: ['Contoso'] });
    t.state.script = input => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' });
    const replay = ConsolidationReplay.for(t.service);
    await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: false });
    await replay.settled();
    const status = await callTool(t.server, 'replay-memory-consolidation', {});
    expect(status.data).toMatchObject({ state: 'finished', model_calls: 0, kept_apart: 1, outcomes: { unchanged: 1 } });
    expect(t.live()).toHaveLength(2);
  });

  it('previews what a live run does: a dry run carries subjects onto survivors too (Codex, #726)', async () => {
    const keyLimit = () => new Error('403 Key limit exceeded');
    const step = at(0.2);
    const t = setup({ a: vec(0), b: vec(step), c: vec(2 * step) }, () => keyLimit());
    const a = await t.create('a', ['Northwind']);
    const b = await t.create('b', []); // compared with a, the call failed: flagged
    const c = await t.create('c', ['Contoso']); // compared with b (no subjects yet), failed: flagged
    expect([b.warnings.length, c.warnings.length]).toEqual([1, 1]);
    // b replaces a, so b becomes about Northwind; c, about Contoso, is then kept apart from b.
    t.state.script = input => ({ operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' });
    const replay = ConsolidationReplay.for(t.service);
    const run = async (dryRun: boolean) => {
      await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: dryRun });
      await replay.settled();
      return (await callTool(t.server, 'replay-memory-consolidation', {})).data;
    };
    const dry = await run(true);
    expect(dry).toMatchObject({ model_calls: 1, kept_apart: 1, outcomes: { update: 1, unchanged: 1 } });
    t.state.calls.length = 0;
    const live = await run(false);
    expect(live).toMatchObject({ model_calls: 1, kept_apart: 1, outcomes: { update: 1, unchanged: 1 } });
    expect(t.live()).toEqual([b.data.id, c.data.id]);
    expect(a.data.id).toBeLessThan(b.data.id);
  });

  it('keeps the same words about another company apart without an embedder too (Codex, #726)', async () => {
    db = createTestDb();
    vault(db);
    const service = new MemoryService(db);
    const server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, service);
    const create = (subjects: string[]) => callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'Annual budget is 500K', subjects });
    const first = await create(['Northwind']);
    const second = await create(['Contoso']);
    expect(second.ok).toBe(true);
    expect(second.data.kept_apart).toEqual([first.data.id]);
    const third = await create(['Northwind']);
    expect(third.error.code).toBe('DUPLICATE_MEMORY');
  });

  it('finds a duplicate behind copies kept apart without an embedder (Codex, #726)', async () => {
    db = createTestDb();
    vault(db);
    const companies = ['Fabrikam', 'Litware', 'Tailspin', 'Wingtip', 'Adventure Works', 'Proseware'];
    companies.forEach((name, i) => note(db!, `co${i}`, `Companies/${name}.md`, ['company']));
    const service = new MemoryService(db);
    const server = new McpServer({ name: 'test', version: '0' });
    registerMemoriesTools(server, service);
    const create = (subjects: string[]) => callTool(server, 'create-memory', { evidence: EV, source: 'curator', content: 'Annual budget is 500K', subjects });
    const made = [];
    for (const name of companies) made.push(await create([name]));
    expect(made.every(m => m.ok)).toBe(true);
    const again = await create(['Proseware']);
    expect(again.error?.code).toBe('DUPLICATE_MEMORY');
    expect(again.error.details.existing_id).toBe(made.at(-1)!.data.id);
  });

  it('checks the subjects again before a replay merge: a change during the call keeps both (Codex, #726)', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.1)) }, () => new Error('403 Key limit exceeded'));
    const a = await t.create('a', ['Northwind']);
    const b = await t.create('b', ['Northwind']); // flagged for replay
    expect(b.warnings).toHaveLength(1);
    // While the model call runs, a is corrected to be about Contoso.
    t.state.script = (async (input: ConsolidationInput) => {
      await callTool(t.server, 'update-memory', { id: a.data.id, subjects: ['Contoso'] });
      return { operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' };
    }) as unknown as Script;
    const replay = ConsolidationReplay.for(t.service);
    await callTool(t.server, 'replay-memory-consolidation', { action: 'start', dry_run: false });
    await replay.settled();
    const status = (await callTool(t.server, 'replay-memory-consolidation', {})).data;
    expect(status).toMatchObject({ model_calls: 1, outcomes: { skipped: 1 } });
    expect(t.live()).toEqual([a.data.id, b.data.id]);
  });

  it('checks the subjects again before a create merge: a change during the call keeps both (Codex, #726)', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.1)) }, () => ({ operation: 'add', reason: 'new' }));
    const a = await t.create('a', ['Northwind']);
    // While the model call for b runs, a is corrected to be about Contoso.
    t.state.script = (async (input: ConsolidationInput) => {
      await callTool(t.server, 'update-memory', { id: a.data.id, subjects: ['Contoso'] });
      return { operation: 'update', target_id: input.candidates[0]!.id, reason: 'newer' };
    }) as unknown as Script;
    const b = await t.create('b', ['Northwind']);
    expect(b.data).toMatchObject({ operation: 'add', kept_apart: [a.data.id], superseded: [] });
    expect(t.live()).toEqual([a.data.id, b.data.id]);
  });

  it('expire-memory refuses a merge the subject rule forbids when asked to, and changes nothing (Codex, #726)', async () => {
    const t = setup({ a: vec(0), b: vec(Math.PI / 2) }, () => ({ operation: 'add', reason: 'new' }));
    const a = await t.create('a', ['Northwind']);
    const b = await t.create('b', ['Contoso']);
    const refused = await callTool(t.server, 'expire-memory', { id: a.data.id, reason: 'duplicate-of', superseded_by: b.data.id, unless_subjects_apart: true });
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { subjects_apart: true } } });
    expect(t.live()).toEqual([a.data.id, b.data.id]);
    // Without the flag (an owner's own call) it is the caller's choice, as before.
    const done = await callTool(t.server, 'expire-memory', { id: a.data.id, reason: 'duplicate-of', superseded_by: b.data.id });
    expect(done.ok).toBe(true);
    expect(t.live()).toEqual([b.data.id]);
  });

  it('flags a near pair about different things of one kind', async () => {
    const t = setup({ a: vec(0), b: vec(at(0.2)), c: vec(-at(0.25)) }, () => ({ operation: 'add', reason: 'different' }));
    // Different sources, so create never compares them; the reconcile pairs across sources.
    await t.create('a', ['Northwind', 'Acme']);
    await t.create('b', ['Contoso', 'Acme'], { source: 'chat' });
    await t.create('c', ['Dana Whitfield'], { source: 'owner-import' });
    const res = await callTool(t.server, 'list-memory-near-pairs', {});
    const flags = Object.fromEntries(res.data.pairs.map((p: { a: { content: string }; b: { content: string }; subjects_apart: boolean }) =>
      [[p.a.content, p.b.content].sort().join('/'), p.subjects_apart]));
    expect(flags).toEqual({ 'a/b': true, 'a/c': false });
  });
});
