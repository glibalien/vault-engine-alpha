import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { restoreOperation } from '../../src/undo/restore.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { resolveNodeIdentity } from '../../src/mcp/tools/resolve-identity.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: Database.Database;
let vault: string;
let lock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  vault = mkdtempSync(join(tmpdir(), 'canonical-links-'));
  lock = new WriteLockManager();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

function write(mutation: Partial<ProposedMutation> & { file_path: string }, operation_id?: string) {
  return executeMutation(db, lock, vault, {
    source: 'tool', node_id: null, title: 'ignored', types: [], fields: {}, body: '', ...mutation,
  }, undefined, operation_id ? { operation_id } : undefined);
}
const node = (id: string) => db.prepare('SELECT title, body, file_path FROM nodes WHERE id = ?').get(id) as
  { title: string; body: string; file_path: string };
const file = (path: string) => readFileSync(join(vault, path), 'utf8');
const edges = (sourceId: string) => db.prepare(
  'SELECT target, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY target',
).all(sourceId) as Array<{ target: string; resolved_target_id: string | null }>;

describe('stored titles', () => {
  it('stores the filename as the title of a tool-created node, not the requested one', () => {
    const created = write({ file_path: 'Notes/Pricing- Q4 plan.md', title: 'Pricing: Q4 plan' });
    expect(node(created.node_id).title).toBe('Pricing- Q4 plan');
  });

  it('finds a node by the title it was requested under', () => {
    const created = write({ file_path: 'Notes/Pricing- Q4 plan.md', title: 'Pricing: Q4 plan' });
    const resolved = resolveNodeIdentity(db, { title: 'Pricing: Q4 plan' });
    expect(resolved.ok && resolved.node.node_id).toBe(created.node_id);
  });

  it('does not find a node by one of its aliases', () => {
    write({ file_path: 'Persons/Ada Lovelace.md', fields: { aliases: ['Ada L.'] } });
    expect(resolveNodeIdentity(db, { title: 'Ada L.' }).ok).toBe(false);
  });
});

describe('link canonicalization on tool writes', () => {
  it('rewrites a body link that only the engine could resolve, leaving code alone', () => {
    // Legacy state: a title that drifted from its filename.
    const target = write({ source: 'watcher', file_path: 'Tasks/Site audit- link checker.md', title: 'Site audit: link checker' });
    const summary = write({
      file_path: 'Notes/Summary.md',
      body: 'Did [[Site audit: link checker]] today. `[[Site audit: link checker]]`',
    });
    const expected = 'Did [[Site audit- link checker|Site audit: link checker]] today. `[[Site audit: link checker]]`';
    expect(node(summary.node_id).body).toBe(expected);
    expect(file('Notes/Summary.md')).toContain(expected);
    expect(edges(summary.node_id)).toEqual([{ target: 'Site audit- link checker', resolved_target_id: target.node_id }]);
  });

  it('rewrites near-miss links, keeping an alias and treating embeds as embeds', () => {
    const target = write({ file_path: 'Notes/Pricing- Q4 plan.md' });
    const source = write({
      file_path: 'Notes/Source.md',
      body: 'See [[Pricing: Q4 plan]], [[Pricing/Q4 plan|the plan]] and ![[Pricing: Q4 plan]].',
    });
    expect(node(source.node_id).body).toBe(
      'See [[Pricing- Q4 plan|Pricing: Q4 plan]], [[Pricing- Q4 plan|the plan]] and ![[Pricing- Q4 plan]].',
    );
    expect(edges(source.node_id).every(edge => edge.resolved_target_id === target.node_id)).toBe(true);
  });

  it('leaves healthy, unknown and ambiguous links alone', () => {
    write({ file_path: 'Notes/Alpha.md' });
    write({ file_path: 'Notes/A - B.md' });
    write({ file_path: 'Archive/A-B.md' });
    const body = 'Links: [[Alpha]], [[alpha]], [[Never Written]], [[A: B]].';
    const source = write({ file_path: 'Notes/Source.md', body });
    expect(node(source.node_id).body).toBe(body);
  });

  it('canonicalizes reference field values to the file name', () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
    const project = write({ file_path: 'Projects/Acme- Rollout.md' });
    const task = write({ file_path: 'Tasks/Do it.md', types: ['task'], fields: { project: 'Acme: Rollout' } });
    expect(file('Tasks/Do it.md')).toContain('project: "[[Acme- Rollout]]"');
    expect(edges(task.node_id)).toEqual([{ target: 'Acme- Rollout', resolved_target_id: project.node_id }]);
  });

  it('rewrites the right span after an entity or escape earlier in the line', () => {
    write({ file_path: 'Notes/Q4- Pricing.md' });
    const source = write({ file_path: 'Notes/Source.md', body: 'R&amp;D \\* plan: [[Q4: Pricing]] done.' });
    expect(node(source.node_id).body).toBe('R&amp;D \\* plan: [[Q4- Pricing|Q4: Pricing]] done.');
  });

  it('links by path when another note answers to the basename', () => {
    const report = write({ source: 'watcher', file_path: 'Tasks/Report.md', title: 'Quarter: Report' });
    write({ file_path: 'Report.md' });
    const source = write({ file_path: 'Notes/Source.md', body: 'See [[Quarter: Report]].' });
    expect(node(source.node_id).body).toBe('See [[Tasks/Report.md|Quarter: Report]].');
    expect(edges(source.node_id)).toEqual([{ target: 'Tasks/Report.md', resolved_target_id: report.node_id }]);
  });

  it('rewrites explicit links in unclaimed frontmatter fields', () => {
    const target = write({ file_path: 'Notes/Q4- Pricing.md' });
    const source = write({ file_path: 'Notes/Source.md', fields: { related: '[[Q4: Pricing]]', more: ['[[Q4/Pricing|the plan]]', 'plain'] } });
    expect(file('Notes/Source.md')).toContain('related: "[[Q4- Pricing]]"');
    expect(file('Notes/Source.md')).toContain('[[Q4- Pricing|the plan]]');
    expect(edges(source.node_id).every(edge => edge.resolved_target_id === target.node_id)).toBe(true);
  });

  it('escapes the alias separator it adds inside a table cell', () => {
    const target = write({ file_path: 'Notes/Q4- Pricing.md' });
    const source = write({
      file_path: 'Notes/Source.md',
      body: '| Task | Status |\n| --- | --- |\n| [[Q4: Pricing]] | open |\n',
    });
    expect(node(source.node_id).body).toBe('| Task | Status |\n| --- | --- |\n| [[Q4- Pricing\\|Q4: Pricing]] | open |\n');
    expect(edges(source.node_id)).toEqual([{ target: 'Q4- Pricing', resolved_target_id: target.node_id }]);
  });

  it('matches decoded link text, keeping the text as written', () => {
    write({ file_path: 'Notes/Q4- Pricing.md' });
    const source = write({ file_path: 'Notes/Source.md', body: 'See [[Q4&#58; Pricing]].' });
    expect(node(source.node_id).body).toBe('See [[Q4- Pricing|Q4&#58; Pricing]].');
  });

  it('keeps the .md on an embed of a dotted note name', () => {
    write({ source: 'watcher', file_path: 'Notes/Report.v2.md', title: 'Report' });
    const source = write({ file_path: 'Notes/Source.md', body: '![[Report]]' });
    expect(node(source.node_id).body).toBe('![[Report.v2.md]]');
  });

  it('rewrites explicit links in claimed text fields', () => {
    createGlobalField(db, { name: 'summary', field_type: 'string' });
    createSchemaDefinition(db, { name: 'note', field_claims: [{ field: 'summary' }] });
    write({ file_path: 'Notes/Q4- Pricing.md' });
    write({ file_path: 'Notes/Source.md', types: ['note'], fields: { summary: 'Blocked on [[Q4: Pricing]] review' } });
    expect(file('Notes/Source.md')).toContain('summary: Blocked on [[Q4- Pricing]] review');
  });

  it('does not rewrite links on watcher writes', () => {
    write({ file_path: 'Notes/Pricing- Q4 plan.md' });
    const source = write({ source: 'watcher', file_path: 'Notes/Source.md', body: 'See [[Pricing: Q4 plan]].' });
    expect(node(source.node_id).body).toBe('See [[Pricing: Q4 plan]].');
  });
});

describe('repairing links written before their target existed', () => {
  it('repairs a new note\'s link to itself under its requested title', () => {
    const created = write({ file_path: 'Notes/Q4- Pricing.md', title: 'Q4: Pricing', body: 'See [[Q4: Pricing]].' });
    expect(created.links_repaired).toEqual([created.node_id]);
    expect(node(created.node_id).body).toBe('See [[Q4- Pricing|Q4: Pricing]].');
    expect(edges(created.node_id)).toEqual([{ target: 'Q4- Pricing', resolved_target_id: created.node_id }]);
  });

  it('rewrites earlier links when the note is created', () => {
    const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Ping Tomas on vendor/onboarding status]].' });
    expect(edges(daily.node_id)[0].resolved_target_id).toBeNull();

    const task = write({ file_path: 'Tasks/Ping Tomas on vendor-onboarding status.md', title: 'Ping Tomas on vendor/onboarding status' });

    expect(task.links_repaired).toEqual([daily.node_id]);
    const expected = 'Follow [[Ping Tomas on vendor-onboarding status|Ping Tomas on vendor/onboarding status]].';
    expect(node(daily.node_id).body).toBe(expected);
    expect(file('Notes/Daily.md')).toContain(expected);
    expect(edges(daily.node_id)).toEqual([{ target: 'Ping Tomas on vendor-onboarding status', resolved_target_id: task.node_id }]);
  });

  it('undoing the create also restores the earlier link text', () => {
    const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Ping Tomas on vendor/onboarding status]].' });
    const operation = createOperation(db, { source_tool: 'create-node', description: 'create task' });
    write({ file_path: 'Tasks/Ping Tomas on vendor-onboarding status.md' }, operation);
    finalizeOperation(db, operation);

    restoreOperation(db, lock, vault, operation, new Set());

    expect(node(daily.node_id).body).toBe('Follow [[Ping Tomas on vendor/onboarding status]].');
    expect(file('Notes/Daily.md')).toContain('Follow [[Ping Tomas on vendor/onboarding status]].');
  });

  it('keeps a repaired note\'s declared type order', () => {
    createSchemaDefinition(db, { name: 'z-task', field_claims: [] });
    createSchemaDefinition(db, { name: 'a-note', field_claims: [] });
    const daily = write({ file_path: 'Notes/Daily.md', types: ['z-task', 'a-note'], body: 'Follow [[Q4: Pricing]].' });

    expect(write({ file_path: 'Tasks/Q4- Pricing.md' }).links_repaired).toEqual([daily.node_id]);
    expect(db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order').all(daily.node_id))
      .toEqual([{ schema_type: 'z-task' }, { schema_type: 'a-note' }]);
  });

  it('never overwrites a disk edit the watcher has not indexed yet', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Q4: Pricing]].' });
    writeFileSync(join(vault, 'Notes/Daily.md'), 'Unindexed edit: [[Q4: Pricing]].\n');

    const task = write({ file_path: 'Tasks/Q4- Pricing.md' });

    expect(task.links_repaired).toEqual([]);
    expect(file('Notes/Daily.md')).toBe('Unindexed edit: [[Q4: Pricing]].\n');
    expect(node(daily.node_id).body).toBe('Follow [[Q4: Pricing]].');
  });

  describe('batch-mutate', () => {
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    beforeEach(() => {
      registerBatchMutate({ tool: (_n: string, _d: string, _s: unknown, cb: typeof handler) => { handler = cb; } } as unknown as McpServer, db, lock, vault);
    });
    const run = async (operations: unknown[]) =>
      JSON.parse((await handler({ operations }) as { content: Array<{ text: string }> }).content[0].text) as { ok: boolean };

    it('repairs earlier links once the batch commits', async () => {
      const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Q4: Pricing]].' });
      expect((await run([{ op: 'create', params: { title: 'Q4: Pricing', directory: 'Tasks' } }])).ok).toBe(true);
      expect(node(daily.node_id).body).toBe('Follow [[Q4- Pricing|Q4: Pricing]].');
    });

    it('leaves earlier links untouched when the batch fails, even after updating that note', async () => {
      const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Q4: Pricing]].' });
      const before = file('Notes/Daily.md');

      const result = await run([
        { op: 'create', params: { title: 'Q4: Pricing', directory: 'Tasks' } },
        { op: 'update', params: { node_id: daily.node_id, append_body: 'More.' } },
        { op: 'update', params: { node_id: 'no-such-node', set_body: 'x' } },
      ]);

      expect(result.ok).toBe(false);
      expect(file('Notes/Daily.md')).toBe(before);
      expect(existsSync(join(vault, 'Tasks/Q4- Pricing.md'))).toBe(false);
      expect(node(daily.node_id).body).toBe('Follow [[Q4: Pricing]].');
    });
  });

  it('keeps a link it cannot repair and still creates the note', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Q4: Pricing]].' });
    unlinkSync(join(vault, 'Notes/Daily.md'));

    const task = write({ file_path: 'Tasks/Q4- Pricing.md' });

    expect(task.links_repaired).toEqual([]);
    expect(node(task.node_id).title).toBe('Q4- Pricing');
    expect(node(daily.node_id).body).toBe('Follow [[Q4: Pricing]].');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Notes/Daily.md'));
  });

  it('rename rewrites escaped and entity-encoded links to the renamed note', () => {
    const target = write({ file_path: 'Notes/R&D.md' });
    const source = write({
      file_path: 'Notes/Source.md',
      body: 'See [[R&amp;D]].\n\n| Link |\n| --- |\n| [[R&D\\|the lab]] |\n',
    });
    expect(edges(source.node_id).every(edge => edge.resolved_target_id === target.node_id)).toBe(true);

    db.transaction(() => executeRename(
      db, lock, vault, { node_id: target.node_id, file_path: 'Notes/R&D.md', title: 'R&D' }, 'Research', 'Notes/Research.md',
    ))();

    expect(node(source.node_id).body).toBe('See [[Research]].\n\n| Link |\n| --- |\n| [[Research\\|the lab]] |\n');
    expect(edges(source.node_id).every(edge => edge.target === 'Research' && edge.resolved_target_id === target.node_id)).toBe(true);
  });

  it('keeps a legacy title an inbound link is bound through on an ordinary edit', () => {
    const b = write({ source: 'watcher', file_path: 'Notes/2026-01-01-B.md', title: 'B' });
    const linker = write({ source: 'watcher', file_path: 'Notes/Linker.md', title: 'Linker', body: 'See [[B]].' });

    write({ node_id: b.node_id, file_path: 'Notes/2026-01-01-B.md', body: 'Edited.' });

    expect(node(b.node_id).title).toBe('B');
    expect(edges(linker.node_id)).toEqual([{ target: 'B', resolved_target_id: b.node_id }]);
  });

  it('rewrites a bare alias on a tool write, and earlier ones when its note is created', () => {
    const early = write({ source: 'watcher', file_path: 'Notes/Early.md', title: 'Early', body: 'Ask [[Ada L.]].' });
    const ada = write({ file_path: 'Persons/Ada Lovelace.md', fields: { aliases: ['Ada L.'] } });
    expect(ada.links_repaired).toEqual([early.node_id]);
    expect(node(early.node_id).body).toBe('Ask [[Ada Lovelace|Ada L.]].');

    const later = write({ file_path: 'Notes/Later.md', body: 'Thanks [[Ada L.]].' });
    expect(node(later.node_id).body).toBe('Thanks [[Ada Lovelace|Ada L.]].');
    expect(edges(later.node_id)).toEqual([{ target: 'Ada Lovelace', resolved_target_id: ada.node_id }]);
  });

  it('rewrites earlier links when a note is renamed to that name', () => {
    const daily = write({ file_path: 'Notes/Daily.md', body: 'Follow [[Q4: Pricing]].' });
    const target = write({ file_path: 'Notes/Old.md' });

    const { changedNodeIds } = db.transaction(() => executeRename(
      db, lock, vault, { node_id: target.node_id, file_path: 'Notes/Old.md', title: 'Old' }, 'Q4: Pricing', 'Notes/Q4- Pricing.md',
    ))();

    expect(node(target.node_id).title).toBe('Q4- Pricing');
    expect(changedNodeIds).toContain(daily.node_id);
    expect(node(daily.node_id).body).toBe('Follow [[Q4- Pricing|Q4: Pricing]].');
    expect(edges(daily.node_id)[0].resolved_target_id).toBe(target.node_id);
  });
});
