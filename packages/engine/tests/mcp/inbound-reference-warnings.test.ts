import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { recheckInboundDiagnostics, type ReferenceDiagnostic } from '../../src/pipeline/diagnostics.js';
import * as relationshipPolicy from '../../src/resolver/relationship-policy.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

// Under reference policy v2, a write that makes another node's typed reference ambiguous
// reports it on that write, naming the other node (#112).

let db: ReturnType<typeof createTestDb>;
let vault: ReturnType<typeof createTempVault>;
let lock: WriteLockManager;
let handlers: Record<string, (args: Record<string, unknown>) => Promise<any>>;

beforeEach(() => {
  db = createTestDb(); vault = createTempVault(); lock = new WriteLockManager(); handlers = {};
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reference_resolution_policy_version','2')").run();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'Project' });
  createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'Project' });
  createSchemaDefinition(db, { name: 'Project', field_claims: [{ field: 'project' }] });
  createSchemaDefinition(db, { name: 'Task', field_claims: [{ field: 'project' }, { field: 'projects' }] });
  const server = {
    tool: (name: string, _d: string, _s: unknown, fn: (args: unknown) => Promise<{ content: Array<{ text: string }> }>) => {
      handlers[name] = async args => JSON.parse((await fn(args)).content[0].text);
    },
  } as unknown as McpServer;
  registerCreateNode(server, db, lock, vault.vaultPath);
  registerUpdateNode(server, db, lock, vault.vaultPath);
  registerBatchMutate(server, db, lock, vault.vaultPath);
  registerGetNode(server, db);
});
afterEach(() => { vi.restoreAllMocks(); lock.clearRecentWrites(); db.close(); vault.cleanup(); });

const ambiguities = (envelope: { warnings: Array<{ code: string }> }) =>
  envelope.warnings.filter(warning => warning.code === 'REFERENCE_AMBIGUOUS') as Array<any>;

async function create(params: Record<string, unknown>): Promise<string> {
  const result = await handlers['create-node'](params);
  expect(result.ok).toBe(true);
  return result.data.node_id;
}

function binding(sourceId: string): string | null {
  return (db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = 'project'")
    .get(sourceId) as { resolved_target_id: string | null }).resolved_target_id;
}

/** P/Same (a project) and a task that references it by title. */
async function projectAndTask(): Promise<{ project: string; task: string }> {
  const project = await create({ title: 'Same', directory: 'P', types: ['Project'] });
  const task = await create({ title: 'Source', directory: 'T', types: ['Task'], fields: { project: 'Same' } });
  expect(binding(task)).toBe(project);
  return { project, task };
}

describe('inbound typed-reference warnings', () => {
  it('reports the other node on the create that makes its reference ambiguous', async () => {
    const { task } = await projectAndTask();

    const second = await handlers['create-node']({ title: 'Same', directory: 'Q', types: ['Project'] });

    expect(second.ok).toBe(true);
    expect(binding(task)).toBeNull();
    expect(ambiguities(second)).toEqual([expect.objectContaining({
      field: 'project',
      details: expect.objectContaining({ source_id: task, raw_target: 'Same', candidate_count: 2 }),
    })]);
    // The source's own inspection agrees.
    const inspected = await handlers['get-node']({ node_id: task });
    expect(ambiguities(inspected)).toHaveLength(1);
  });

  it('stays silent for a reference that was already unresolved', async () => {
    await projectAndTask();
    await create({ title: 'Same', directory: 'Q', types: ['Project'] });

    const third = await handlers['create-node']({ title: 'Same', directory: 'R', types: ['Project'] });

    expect(third.ok).toBe(true);
    expect(ambiguities(third)).toEqual([]);
  });

  it('keeps the existing warning bounds when one create unbinds many references', async () => {
    await create({ title: 'Same', directory: 'P', types: ['Project'] });
    for (let i = 0; i < 60; i++) await create({ title: `Source ${i}`, directory: 'T', types: ['Task'], fields: { project: 'Same' } });

    const second = await handlers['create-node']({ title: 'Same', directory: 'Q', types: ['Project'] });

    expect(second.ok).toBe(true);
    const references = second.warnings.filter((warning: { code: string }) => warning.code.startsWith('REFERENCE_') || warning.code === 'RESULT_TRUNCATED');
    expect(references.length).toBeLessThanOrEqual(50);
    expect(references.at(-1)).toMatchObject({ code: 'RESULT_TRUNCATED', details: { observed_count: 60 } });
  });

  it('reports it on a rename into the referenced title, and clears it on the rename back', async () => {
    const { task } = await projectAndTask();
    const other = await create({ title: 'Other', directory: 'Q', types: ['Project'] });

    const renamed = await handlers['update-node']({ node_id: other, set_title: 'Same' });

    expect(renamed.ok).toBe(true);
    expect(ambiguities(renamed).map(warning => warning.details.source_id)).toEqual([task]);

    const back = await handlers['update-node']({ node_id: other, set_title: 'Other' });
    expect(back.ok).toBe(true);
    expect(binding(task)).not.toBeNull();
    expect(ambiguities(back)).toEqual([]);
  });

  it('reports a binding a rename loses in a source whose other references it rewrites', async () => {
    await create({ title: 'Same', directory: 'P', types: ['Project'] });
    const old = await create({ title: 'Old', directory: 'Q', types: ['Project'] });
    // The rename rewrites `Old`; the list's `Same` entry stays and becomes ambiguous.
    const both = await create({ title: 'Both', directory: 'T', types: ['Task'], fields: { projects: ['Old', 'Same'] } });

    const renamed = await handlers['update-node']({ node_id: old, set_title: 'Same' });

    expect(renamed.ok).toBe(true);
    expect(ambiguities(renamed)).toEqual([expect.objectContaining({
      field: 'projects', details: expect.objectContaining({ source_id: both, raw_target: 'Same' }),
    })]);
  });

  it('reports it on a type change that makes another note eligible', async () => {
    const { task } = await projectAndTask();
    const plain = await create({ title: 'Same', directory: 'N', types: [] });
    expect(binding(task)).not.toBeNull();

    const typed = await handlers['update-node']({ node_id: plain, add_types: ['Project'] });

    expect(typed.ok).toBe(true);
    expect(ambiguities(typed).map(warning => warning.details.source_id)).toEqual([task]);
  });

  it('judges a batch by its final state, attributing what remains to the operation that caused it', async () => {
    const { task } = await projectAndTask();

    // Introduced by op 0, resolved again by op 1: nothing to report.
    const settled = await handlers['batch-mutate']({ operations: [
      { op: 'create', params: { title: 'Same', directory: 'Q', types: ['Project'] } },
      { op: 'update', params: { file_path: 'Q/Same.md', remove_types: ['Project'] } },
    ] });
    expect(settled.ok).toBe(true);
    expect(ambiguities(settled)).toEqual([]);
    expect(binding(task)).not.toBeNull();

    const left = await handlers['batch-mutate']({ operations: [
      { op: 'create', params: { title: 'Unrelated', directory: 'U', types: [] } },
      { op: 'create', params: { title: 'Same', directory: 'R', types: ['Project'] } },
    ] });
    expect(left.ok).toBe(true);
    expect(ambiguities(left)).toEqual([expect.objectContaining({
      op_index: 1, details: expect.objectContaining({ source_id: task }),
    })]);
  });

  it('judges a query-mode update by its final state', async () => {
    await create({ title: 'Same', directory: 'P', types: ['Project'] });
    // Query mode visits matches in id order. Either way the task ends on P/Same.md: if the
    // other note gains Project first, the task's `Same` is ambiguous until its own update.
    const plain = await create({ title: 'Same', directory: 'N', types: [] });
    const task = await create({ title: 'Source', directory: 'T', types: ['Task'], fields: { project: 'Same' } });

    const updated = await handlers['update-node']({
      query: { node_ids: [plain, task] }, add_types: ['Project'], set_fields: { project: 'P/Same.md' }, dry_run: false,
    });

    expect(updated.ok).toBe(true);
    expect(binding(task)).not.toBeNull();
    expect(ambiguities(updated)).toEqual([]);
  });

  it('reports a query-mode source once, whichever of the two updates comes first', async () => {
    // Query mode visits matches in id order, which is random; eight pairs cover both orders
    // almost always. The task is either diagnosed by its own later update, or re-checked
    // after the other note's update unbound it.
    for (let i = 0; i < 8; i++) {
      await create({ title: `Same ${i}`, directory: 'P', types: ['Project'] });
      const task = await create({ title: `Source ${i}`, directory: 'A', types: ['Task'], fields: { project: `Same ${i}` } });
      const plain = await create({ title: `Same ${i}`, directory: 'B', types: [] });

      const updated = await handlers['update-node']({ query: { node_ids: [task, plain] }, add_types: ['Project'], dry_run: false });

      expect(updated.ok).toBe(true);
      expect(ambiguities(updated).map(warning => warning.details.source_id)).toEqual([task]);
    }
  });

  it('re-checks many sources against one catalog', async () => {
    await create({ title: 'Same', directory: 'P', types: ['Project'] });
    await create({ title: 'Same', directory: 'Q', types: ['Project'] });
    const sources: string[] = [];
    for (let i = 0; i < 5; i++) sources.push(await create({ title: `Source ${i}`, directory: 'T', types: ['Task'], fields: { project: 'Same' } }));
    const inbound: ReferenceDiagnostic[] = sources.map(sourceId => ({
      sourceId,
      request: { rawTarget: 'Same', context: { origin: 'field', field: 'project', requiredType: 'Project' } },
      resolution: { status: 'unresolved', reason: 'ambiguous', candidates: [], candidateCount: 2, candidatesTruncated: false, tier: null },
    } as unknown as ReferenceDiagnostic));
    const build = vi.spyOn(relationshipPolicy, 'buildReferenceCatalog');

    const rechecked = [...recheckInboundDiagnostics(db, inbound)];

    expect(rechecked.map(diagnostic => diagnostic.sourceId)).toEqual(sources);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('logs it when the watcher ingests the note that causes it', async () => {
    const { task } = await projectAndTask();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mkdirSync(join(vault.vaultPath, 'Q'), { recursive: true });
    const path = join(vault.vaultPath, 'Q', 'Same.md');
    writeFileSync(path, '---\ntypes:\n  - Project\n---\n');

    processFileChange(path, 'Q/Same.md', db, lock, vault.vaultPath);

    const logged = warn.mock.calls.find(call => call[0] === '[watcher] Reference diagnostics:');
    expect(logged).toBeDefined();
    expect(JSON.parse(logged![1] as string)).toEqual([expect.objectContaining({
      code: 'REFERENCE_AMBIGUOUS', details: expect.objectContaining({ source_id: task }),
    })]);
  });
});
