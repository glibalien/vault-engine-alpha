import { afterEach, expect, it } from 'vitest';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { upgradeToProvenance } from '../../src/provenance/migrate.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRefreshFixture } from './home-refresh-fixture.js';
import { setWikiHomeStatus } from '../../src/wiki/status.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
async function setup(options?: Parameters<typeof homeRefreshFixture>[0]) { const f = await homeRefreshFixture(options); cleanups.push(f.cleanup); return f; }
function target(f: Awaited<ReturnType<typeof setup>>, id = f.receipt.output_revision_id): any {
  return inspectProvenance(f.db, { select: 'refresh_target', output_revision_id: id } as any);
}

it('reads canonical target facts without reserving capture or mutating the home', async () => {
  const f = await setup();
  const before = f.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.home.node_id);
  expect(target(f)).toMatchObject({ select: 'refresh_target', eligible: true, project_id: f.project.node_id,
    home_node_id: f.home.node_id, home_version: 2, latest_output_revision_id: f.receipt.output_revision_id, reasons: [] });
  expect(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(f.home.node_id)).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_derivations').get()).toEqual({ n: 1 });
});

it('rejects a historical receipt even if its generated section still matches', async () => {
  const f = await setup();
  const second = await f.call(f.stage());
  expect(second.ok).toBe(true);
  expect(target(f).eligible).toBe(false);
  expect(target(f).reasons).toContain('HISTORICAL_OUTPUT');
  expect(target(f, second.data.provenance_receipt.output_revision_id).eligible).toBe(true);
});

it('uses committed node version when tied timestamps contain identical contributions', async () => {
  const f = await setup({ replaceOnly: true });
  const second = await f.call(f.stage());
  expect(second.ok).toBe(true);
  const firstId = f.receipt.output_revision_id;
  const secondId = second.data.provenance_receipt.output_revision_id;
  const tiedAt = '2026-09-21T12:00:00.000Z';
  f.db.prepare('UPDATE provenance_outputs SET id=?,committed_at=? WHERE id=?').run('z-older', tiedAt, firstId);
  f.db.prepare('UPDATE provenance_outputs SET id=?,committed_at=? WHERE id=?').run('a-newer', tiedAt, secondId);
  const rows = f.db.prepare(`SELECT o.id,o.node_version,p.text AS contribution FROM provenance_outputs o
    JOIN provenance_payloads p ON p.derivation_id=o.derivation_id AND p.kind='contribution'
    ORDER BY o.node_version`).all() as Array<{ id: string; node_version: number; contribution: string }>;
  expect(rows.map(({ id, node_version }) => ({ id, node_version }))).toEqual([
    { id: 'z-older', node_version: 2 },
    { id: 'a-newer', node_version: 3 },
  ]);
  expect(new Set(rows.map(row => row.contribution)).size).toBe(1);
  expect(target(f, 'a-newer')).toMatchObject({ eligible: true, latest_output_revision_id: 'a-newer', reasons: [] });
  expect(target(f, 'z-older')).toMatchObject({ eligible: false, latest_output_revision_id: 'a-newer' });
  expect(target(f, 'z-older').reasons).toContain('HISTORICAL_OUTPUT');
});

it.each(['edited', 'purged', 'missing', 'duplicate-home'])('blocks %s target', async mode => {
  const f = await setup();
  if (mode === 'edited') f.db.prepare("UPDATE nodes SET body=REPLACE(body,'Generated summary.','Owner edit') WHERE id=?").run(f.home.node_id);
  if (mode === 'purged') f.db.prepare("UPDATE provenance_derivations SET availability='purged'").run();
  if (mode === 'missing') f.db.prepare('DELETE FROM nodes WHERE id=?').run(f.home.node_id);
  if (mode === 'duplicate-home') f.mutate({ source: 'tool', node_id: null, file_path: 'Wikis/Other.md', title: 'Other', types: ['wiki'], fields: { wiki_for: 'Project' }, body: 'Another home' });
  expect(target(f).eligible).toBe(false);
});

it('keeps lineage receipts and namespace stable across repeated migration checks', async () => {
  const f = await setup();
  const namespace = f.service.store.namespace();
  upgradeToProvenance(f.db);
  upgradeToProvenance(f.db);
  expect(f.service.store.namespace()).toBe(namespace);
  expect(f.db.prepare("SELECT value FROM meta WHERE key='provenance_schema_version'").get()).toEqual({ value: '4' });
  expect(f.db.prepare('SELECT replaces_output_revision_id FROM provenance_outputs').get()).toEqual({ replaces_output_revision_id: null });
});

it('rejects a captured home whose owner is no longer a project', async () => {
  const f = await setup();
  f.db.prepare("DELETE FROM node_types WHERE node_id=? AND schema_type='project'").run(f.project.node_id);
  expect(target(f).eligible).toBe(false);
});

it('publishes just the home with lineage while preserving full-curation stamps, then replays', async () => {
  const f = await setup();
  const facts = target(f);
  const before = f.db.prepare("SELECT field_name,value_text,value_date FROM node_fields WHERE node_id=? AND field_name IN ('wiki_evidence_hash','wiki_topology_hash','wiki_curated_at') ORDER BY field_name").all(f.home.node_id);
  const input = { ...f.stage('New home summary.'), home_refresh: { home_node_id: f.home.node_id, expected_output_revision_id: f.receipt.output_revision_id, expected_topology_hash: facts.topology_hash } };
  input.home.evidence_hash = 'different-evidence';
  input.home.curated_at = '2026-09-21T00:00:00Z';
  const result = await f.call(input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.provenance_receipt.replaces_output_revision_id).toBe(f.receipt.output_revision_id);
  expect(f.db.prepare("SELECT field_name,value_text,value_date FROM node_fields WHERE node_id=? AND field_name IN ('wiki_evidence_hash','wiki_topology_hash','wiki_curated_at') ORDER BY field_name").all(f.home.node_id)).toEqual(before);
  const path = join(f.vault.vaultPath, 'Wikis/Project Wiki.md');
  const body = readFileSync(path, 'utf8');
  expect(body).toContain('Human introduction.');
  expect(body).toContain('New home summary.');
  const replay = await f.call(input);
  expect(replay.data.provenance_receipt).toEqual(result.data.provenance_receipt);
  expect(readFileSync(path, 'utf8')).toBe(body);
});

it('keeps a preview good across a status write and refreshes the home (#547)', async () => {
  const f = await setup();
  const preview = target(f);
  const input = { ...f.stage('Refreshed after the status moved.'), home_refresh: { home_node_id: f.home.node_id, expected_output_revision_id: f.receipt.output_revision_id, expected_topology_hash: preview.topology_hash } };
  input.home.expected_version = preview.home_version;
  const write = setWikiHomeStatus({ db: f.db, writeLock: new WriteLockManager(), vaultPath: f.vault.vaultPath }, f.home.node_id, 'paused-behind');
  expect(write).toMatchObject({ written: true, version: preview.home_version + 1 });

  expect(target(f)).toMatchObject({ eligible: true, home_version: preview.home_version });
  const result = await f.call(input);

  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(f.db.prepare("SELECT value_text FROM node_fields WHERE node_id=? AND field_name='wiki_status'").get(f.home.node_id)).toEqual({ value_text: 'paused-behind' });
});

it('moves the preview\'s home version on at any other edit (#547)', async () => {
  const f = await setup();
  expect(setWikiHomeStatus({ db: f.db, writeLock: new WriteLockManager(), vaultPath: f.vault.vaultPath }, f.home.node_id, 'paused-behind')?.written).toBe(true);
  const before = target(f).home_version;
  const home = f.db.prepare('SELECT body FROM nodes WHERE id=?').get(f.home.node_id) as { body: string };
  f.mutate({ source: 'tool', node_id: f.home.node_id, file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki', types: ['wiki'],
    fields: { wiki_for: 'Project', wiki_status: 'paused-behind' }, body: `${home.body}\nOwner line.`, canonicalizeLinks: false });

  expect(target(f).home_version).not.toBe(before);
});

it.each(['home', 'output', 'topology'])('rejects stale %s refresh identity before writes', async part => {
  const f = await setup();
  const input = { ...f.stage(), home_refresh: { home_node_id: f.home.node_id, expected_output_revision_id: f.receipt.output_revision_id, expected_topology_hash: target(f).topology_hash } };
  if (part === 'home') input.home_refresh.home_node_id = 'another';
  if (part === 'output') input.home_refresh.expected_output_revision_id = 'absent';
  if (part === 'topology') input.home_refresh.expected_topology_hash = 'stale';
  const before = f.db.prepare('SELECT version,body FROM nodes WHERE id=?').get(f.home.node_id);
  expect((await f.call(input)).ok).toBe(false);
  expect(f.db.prepare('SELECT version,body FROM nodes WHERE id=?').get(f.home.node_id)).toEqual(before);
});
