import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { parseMarkdown } from '../../src/parser/parse.js';

let f: ReturnType<typeof referenceEditFixture>;
let server: McpServer;
let client: Client;
beforeEach(async () => {
  f = referenceEditFixture();
  server = new McpServer({ name: 'reference-test', version: '1' });
  registerUpdateNode(server, f.db, f.writeLock, f.vaultPath);
  registerBatchMutate(server, f.db, f.writeLock, f.vaultPath);
  client = new Client({ name: 'reference-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
});
afterEach(async () => { await client.close(); await server.close(); f.cleanup(); });

async function call(args: Record<string, unknown>, name = 'update-node') {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) return { ok: false, error: { code: 'INVALID_PARAMS' } };
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}
function request(extra: Record<string, unknown> = {}) {
  return { node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1] } }, ...extra };
}

describe('update-node reference_edit wire contract', () => {
  it.each(['Project (old)', 'Project (left', 'Project right)'])('round-trips parentheses in reference titles: %s', async title => {
    const target = executeMutation(f.db, f.writeLock, f.vaultPath, {
      source: 'tool', node_id: null, file_path: `Projects/${title}.md`, title,
      types: ['Project'], fields: {}, body: '',
    });
    const reference_edit = { field: 'project', action: 'add', target: { node_id: target.node_id } };
    const before = f.snapshot();
    expect(await call(request({ reference_edit }))).toMatchObject({
      ok: true, data: { reference_edit: { changed: false, would_change: true } },
    });
    expect(f.snapshot()).toEqual(before);
    expect(await call(request({ reference_edit, dry_run: false }))).toMatchObject({
      ok: true, data: { reference_edit: { outcome: 'added', added_count: 1 } },
    });

    const markdown = readFileSync(join(f.vaultPath, 'Task.md'), 'utf8');
    expect(markdown).toContain(`[[${title}]]`);
    const parsed = parseMarkdown(markdown, 'Task.md');
    expect(parsed.parseError).toBeNull();
    expect(parsed.fields.get('project')).toEqual(['P1', title]);
    expect(parsed.wikiLinks).toContainEqual({ target: title, alias: null, context: 'project' });
    expect(f.db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = 'project' AND target = ?").get(f.taskId, title))
      .toEqual({ resolved_target_id: target.node_id });

    expect(await call(request({ reference_edit: { ...reference_edit, action: 'remove' }, dry_run: false }))).toMatchObject({
      ok: true, data: { reference_edit: { outcome: 'removed', removed_count: 1 } },
    });
    expect(f.members()).toEqual(['P1']);
    expect(parseMarkdown(readFileSync(join(f.vaultPath, 'Task.md'), 'utf8'), 'Task.md').fields.get('project')).toEqual(['P1']);
    expect(f.db.prepare("SELECT 1 FROM relationships WHERE source_id = ? AND rel_type = 'project' AND target = ?").get(f.taskId, title)).toBeUndefined();
  });
  it('defaults to a side-effect-free preview then explicitly commits with the additive summary', async () => {
    const before = f.snapshot();
    const preview = await call(request());
    expect(preview.ok).toBe(true);
    expect(preview.data).toMatchObject({ dry_run: true, preview: { node_id: f.taskId }, reference_edit: { outcome: 'added', changed: false, would_change: true, operation_id: null, version: 1 } });
    expect(f.snapshot()).toEqual(before);
    const committed = await call(request({ dry_run: false }));
    expect(committed.ok).toBe(true);
    expect(committed.data).toMatchObject({ node_id: f.taskId, version: 2, reference_edit: { changed: true, added_count: 1, operation_id: expect.any(String) } });
    expect(f.members()).toEqual(['P1', 'P2']);
    expect(f.db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = 'project' ORDER BY target").all(f.taskId)).toEqual([{ resolved_target_id: f.projectIds[0] }, { resolved_target_id: f.projectIds[1] }]);
  });
  it.each([
    { title: 'Task' }, { file_path: 'Task.md' }, { query: {} }, { set_fields: {} }, { set_body: '' },
    { append_body: '' }, { set_types: [] }, { add_types: [] }, { remove_types: [] }, { set_title: '' },
    { set_directory: '' }, { edit_session_id: '' }, { confirm_large_batch: false }, { arbitrary_key: true },
  ])('rejects competing or unknown parameters before mutation: %j', async extra => {
    const before = f.snapshot();
    expect(await call(request({ ...extra, dry_run: false }))).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(f.snapshot()).toEqual(before);
  });
  it('requires both guards for exact stored-value removal and rejects raw-value addition', async () => {
    const remove = { field: 'project', action: 'remove', target: { stored_value: 'P1' } };
    expect(await call(request({ reference_edit: remove, dry_run: false }))).toMatchObject({ ok: false });
    const current = f.source();
    const guarded = { reference_edit: remove, dry_run: false, expected_version: current.version, expected_content_hash: current.content_hash };
    expect(await call(request({ ...guarded, reference_edit: { ...remove, action: 'add' } }))).toMatchObject({ ok: false });
    expect(await call(request(guarded))).toMatchObject({ ok: true, data: { reference_edit: { removed_count: 1 } } });
    expect(f.members()).toEqual([]);
  });
  it('removes a deleted target by exact stored value with matching guards', async () => {
    f.db.prepare('DELETE FROM nodes WHERE id = ?').run(f.projectIds[0]);
    const current = f.source();
    const remove = { field: 'project', action: 'remove', target: { node_id: f.projectIds[0] } };
    expect(await call(request({ reference_edit: remove, dry_run: false }))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const raw = { ...remove, target: { stored_value: 'P1' } };
    const guards = { expected_version: current.version, expected_content_hash: current.content_hash };
    expect(await call(request({ reference_edit: raw, dry_run: false, ...guards }))).toMatchObject({ ok: true, data: { reference_edit: { removed_count: 1 } } });
    expect(f.members()).toEqual([]);
  });
  it.each([true, false])('honors matching and stale content-hash guards on no-op (preview=%s)', async dry_run => {
    const current = f.source();
    const before = f.snapshot();
    const extra = { dry_run, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[0] } } };
    expect(await call(request({ ...extra, expected_version: current.version, expected_content_hash: current.content_hash }))).toMatchObject({ ok: true });
    expect(await call(request({ ...extra, expected_version: current.version, expected_content_hash: 'stale' }))).toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH' } });
    expect(f.snapshot()).toEqual(before);
  });
  it('rejects unknown nested keys, selector conflicts and UTF-8 parameter excess', async () => {
    for (const reference_edit of [
      { field: 'project', action: 'add', target: { node_id: f.projectIds[1], stored_value: 'P2' } },
      { field: 'project', action: 'add', target: { node_id: f.projectIds[1] }, extra: true },
      { field: '界'.repeat(86), action: 'add', target: { node_id: f.projectIds[1] } },
      { field: 'project', action: 'remove', target: { stored_value: 'x'.repeat(4097) } },
    ]) expect(await call(request({ reference_edit }))).toMatchObject({ ok: false });
  });
  it('rejects the member mode in batch and preserves legacy single-node commit defaults', async () => {
    expect(await call({ operations: [{ op: 'update', params: request() }] }, 'batch-mutate')).toMatchObject({ ok: false });
    expect(await call({ node_id: f.taskId, set_fields: { project: ['P3'] } })).toMatchObject({ ok: true, data: { version: 2 } });
    expect(f.members()).toEqual(['P3']);
  });
  it('rejects the complete oversized result before writing', async () => {
    f.db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, 'large', ?)").run(f.taskId, '界'.repeat(400_000));
    const before = f.snapshot();
    expect(await call(request({ dry_run: false }))).toMatchObject({ ok: false, error: { code: 'NOT_ELIGIBLE', details: { reason: 'result_limit' } } });
    expect(f.snapshot()).toEqual(before);
  });
});
