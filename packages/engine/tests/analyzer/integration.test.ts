import { access, chmod, cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, discoverTypeFields } from '../../src/analyzer/index.js';
import { snapshotTree } from './helpers.js';

const fixtureRoot = fileURLToPath(new URL('../fixtures/analyzer/basic', import.meta.url));
const goldenPath = fileURLToPath(new URL('../fixtures/analyzer/basic-report.json', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await chmod(join(root, 'Projects/Alpha.md'), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe('Analyzer integration', () => {
  it('publishes Analyzer version 2.1.0 from discovery and full analysis', async () => {
    const discovery = await discoverTypeFields({ root: fixtureRoot });
    const analysis = await analyze({ root: fixtureRoot, typeField: 'kind' });

    expect(discovery).toMatchObject({
      ok: true,
      data: { analyzer_version: '2.1.0' },
    });
    expect(analysis).toMatchObject({
      ok: true,
      data: { analyzer_version: '2.1.0' },
    });
  });

  it('types the fixture by folder alone without touching the source tree', async () => {
    const before = await snapshotTree(fixtureRoot);
    const result = await analyze({
      root: fixtureRoot,
      folderRules: [
        { directory: 'Meetings', type: 'meeting' },
        { directory: 'People', type: 'person' },
        { directory: 'Projects', type: 'project' },
      ],
    });
    const after = await snapshotTree(fixtureRoot);

    expect(after).toEqual(before);
    await expectGeneratedArtifactsAbsent(fixtureRoot, after.paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => ({
      name: schema.name,
      default_directory: schema.default_directory,
      typed: schema.evidence.typed_documents,
    }))).toEqual([
      { name: 'meeting', default_directory: 'Meetings', typed: 1 },
      { name: 'person', default_directory: 'People', typed: 1 },
      { name: 'project', default_directory: 'Projects', typed: 5 },
    ]);
    expect(result.data.coverage).toMatchObject({ typed_files: 7, typed_by_folder_rule: 7 });
  });

  it('matches the normalized golden report and leaves the source tree byte-identical', async () => {
    const beforeDiscovery = await snapshotTree(fixtureRoot);
    const discovery = await discoverTypeFields({ root: fixtureRoot });
    const afterDiscovery = await snapshotTree(fixtureRoot);
    expect(discovery.ok).toBe(true);
    expect(afterDiscovery).toEqual(beforeDiscovery);
    await expectGeneratedArtifactsAbsent(fixtureRoot, afterDiscovery.paths);

    const beforeAnalysis = await snapshotTree(fixtureRoot);
    const result = await analyze({ root: fixtureRoot, typeField: 'kind' });
    const afterAnalysis = await snapshotTree(fixtureRoot);
    expect(afterAnalysis).toEqual(beforeAnalysis);
    await expectGeneratedArtifactsAbsent(fixtureRoot, afterAnalysis.paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.proposal.schemas.map(schema => ({
      name: schema.name,
      default_directory: schema.default_directory,
    }))).toEqual([
      { name: 'meeting', default_directory: 'Meetings' },
      { name: 'person', default_directory: 'People' },
      { name: 'project', default_directory: 'Projects' },
    ]);

    const normalized = {
      ...result.data,
      source: { ...result.data.source, canonical_root: '<ROOT>' },
    };
    await expect(`${JSON.stringify(normalized, null, 2)}\n`).toMatchFileSnapshot(goldenPath);
  });

  it('excludes runtime symlinks and reports unreadable Markdown without writing artifacts', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vault-analyzer-integration-'));
    await rm(tempRoot, { recursive: true, force: true });
    await cp(fixtureRoot, tempRoot, { recursive: true });
    temporaryRoots.push(tempRoot);
    await symlink(join(tempRoot, 'Projects/Beta.md'), join(tempRoot, 'Alias.md'));

    const before = await snapshotTree(tempRoot);
    const original = await analyze({ root: fixtureRoot, typeField: 'kind' });
    const withSymlink = await analyze({ root: tempRoot, typeField: 'kind' });
    expect(original.ok).toBe(true);
    expect(withSymlink.ok).toBe(true);
    if (!original.ok || !withSymlink.ok) throw new Error('fixture analysis unexpectedly refused');
    expect(withSymlink.data.source.source_fingerprint)
      .toBe(original.data.source.source_fingerprint);
    expect(withSymlink.data.inventory.excluded_entries.symlinks).toBe(1);
    expect(await snapshotTree(tempRoot)).toEqual(before);

    const unreadablePath = join(tempRoot, 'Projects/Alpha.md');
    await chmod(unreadablePath, 0o000);
    let permissionBitsEffective = false;
    try {
      await readFile(unreadablePath);
    } catch {
      permissionBitsEffective = true;
    }

    try {
      const result = await analyze({ root: tempRoot, typeField: 'kind' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('temporary fixture analysis unexpectedly refused');
      if (permissionBitsEffective) {
        expect(result.data.source.source_fingerprint)
          .not.toBe(original.data.source.source_fingerprint);
        expect(result.data.issues).toContainEqual(expect.objectContaining({
          code: 'FILE_UNREADABLE',
        }));
      }
      expect(await pathExists(join(tempRoot, '.vault-engine'))).toBe(false);
      expect(await pathExists(join(tempRoot, '.schemas'))).toBe(false);
    } finally {
      await chmod(unreadablePath, 0o600);
    }

    expect(await snapshotTree(tempRoot)).toEqual(before);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectGeneratedArtifactsAbsent(root: string, paths: string[]): Promise<void> {
  expect(paths.some(path =>
    path === '.vault-engine'
    || path.startsWith('.vault-engine/')
    || path === '.schemas'
    || path.startsWith('.schemas/')
    || path.endsWith('.db'))).toBe(false);
  await expect(pathExists(join(root, '.vault-engine'))).resolves.toBe(false);
  await expect(pathExists(join(root, '.schemas'))).resolves.toBe(false);
}
