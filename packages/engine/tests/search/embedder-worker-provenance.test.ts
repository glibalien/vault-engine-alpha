import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const provenanceScript = resolve(
  import.meta.dirname,
  '..', '..', '..', '..',
  'scripts',
  'embedder-worker-provenance.mjs',
);
const temporaryRoots: string[] = [];
const sourceTypeScript = resolve(
  import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'typescript',
);

function workerPath(root: string): string {
  return join(root, 'packages', 'engine', 'dist', 'search', 'embedder-worker.js');
}

function manifestPath(root: string): string {
  return join(root, 'packages', 'engine', 'dist', 'search', 'embedder-worker.build.json');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'embedder-worker-provenance-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'packages', 'engine', 'dist', 'search'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(sourceTypeScript, join(root, 'node_modules', 'typescript'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'packages', 'engine', 'package.json'), '{"name":"vault-engine"}\n');
  writeFileSync(workerPath(root), "import './document-embedder.js';\nexport const compiledWorker = true;\n");
  writeFileSync(
    join(root, 'packages', 'engine', 'dist', 'search', 'document-embedder.js'),
    "export { chunk } from './chunker.js';\n",
  );
  writeFileSync(
    join(root, 'packages', 'engine', 'dist', 'search', 'chunker.js'),
    'export const chunk = true;\n',
  );
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Provenance Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'provenance@example.test']);
  execFileSync('git', ['-C', root, 'add', 'package.json', 'package-lock.json', 'packages/engine/package.json']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'Add dependency declarations']);
  return root;
}

function runProvenance(command: 'write' | 'verify' | 'verify-attestation', root: string) {
  return spawnSync(process.execPath, [provenanceScript, command, root], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('embedder worker provenance', () => {
  it('writes and verifies the compiled worker runtime closure', () => {
    const root = createFixtureRepo();
    const write = runProvenance('write', root);
    expect(write.status).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
    expect(manifest).toEqual({
      schemaVersion: 3,
      commit: gitHead(root),
      trackedClean: true,
      files: {
        'package-lock.json': sha256(readFileSync(join(root, 'package-lock.json'))),
        'packages/engine/dist/search/chunker.js': sha256(readFileSync(join(root, 'packages', 'engine', 'dist', 'search', 'chunker.js'))),
        'packages/engine/dist/search/document-embedder.js': sha256(readFileSync(join(root, 'packages', 'engine', 'dist', 'search', 'document-embedder.js'))),
        'packages/engine/dist/search/embedder-worker.js': sha256(readFileSync(workerPath(root))),
        'packages/engine/package.json': sha256(readFileSync(join(root, 'packages', 'engine', 'package.json'))),
      },
    });
    const verify = runProvenance('verify', root);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toBe(`${gitHead(root)}\n`);
  });

  it('prints a fingerprint of the exact manifest bytes it accepts', () => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);

    const verify = runProvenance('verify-attestation', root);

    expect(verify.status).toBe(0);
    expect(verify.stdout).toBe(`${gitHead(root)} ${sha256(readFileSync(manifestPath(root)))}\n`);
  });

  it('writes rejected provenance for a dirty development build', () => {
    const root = createFixtureRepo();
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');

    const write = runProvenance('write', root);

    expect(write.status).toBe(0);
    expect(write.stderr).toContain('WARNING');
    expect(JSON.parse(readFileSync(manifestPath(root), 'utf8'))).toMatchObject({ trackedClean: false });
    expect(runProvenance('verify', root).status).toBe(1);
  });

  it('rejects tracked changes made after a clean build before checking hashes', () => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');

    const verify = runProvenance('verify', root);

    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('tracked checkout is dirty');
  });

  it('rejects a forged dirty manifest before accepting matching dirty hashes', () => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');
    writeFileSync(workerPath(root), 'export const compiledWorker = false;\n');
    const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
    manifest.trackedClean = true;
    manifest.files['package-lock.json'] = sha256(readFileSync(join(root, 'package-lock.json')));
    manifest.files['packages/engine/dist/search/embedder-worker.js'] = sha256(readFileSync(workerPath(root)));
    writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);

    const verify = runProvenance('verify', root);

    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('tracked checkout is dirty');
  });

  it('rejects a compiled worker changed after the manifest was written', () => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);
    writeFileSync(workerPath(root), "import './document-embedder.js';\nexport const compiledWorker = false;\n");

    const verify = runProvenance('verify', root);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('compiled provenance hash mismatch: packages/engine/dist/search/embedder-worker.js');
  });

  it('rejects a changed transitive compiled dependency', () => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);
    writeFileSync(join(root, 'packages/engine/dist/search/chunker.js'), 'changed');

    const verify = runProvenance('verify', root);

    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('compiled provenance hash mismatch: packages/engine/dist/search/chunker.js');
  });

  it('fails closed on an unresolved relative compiled import', () => {
    const root = createFixtureRepo();
    writeFileSync(workerPath(root), "import './missing.js';\n");

    const write = runProvenance('write', root);

    expect(write.status).toBe(1);
    expect(write.stderr).toContain('compiled dependency missing');
  });

  it('rejects a relative compiled import outside engine dist', () => {
    const root = createFixtureRepo();
    writeFileSync(workerPath(root), "import '../../../../outside.js';\n");

    const write = runProvenance('write', root);

    expect(write.status).toBe(1);
    expect(write.stderr).toContain('compiled dependency escapes packages/engine/dist');
  });

  it.each([
    {
      name: 'missing manifest',
      arrange: (root: string) => rmSync(manifestPath(root)),
      expected: 'compiled worker provenance missing; deploy/build before running',
    },
    {
      name: 'malformed JSON',
      arrange: (root: string) => writeFileSync(manifestPath(root), '{ malformed json'),
      expected: 'compiled worker provenance is malformed; deploy/build before running',
    },
    {
      name: 'an unsupported schema version',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.schemaVersion = 2;
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance schema mismatch; deploy/build before running',
    },
    {
      name: 'a non-object manifest',
      arrange: (root: string) => writeFileSync(manifestPath(root), 'null\n'),
      expected: 'compiled worker provenance schema mismatch; deploy/build before running',
    },
    {
      name: 'a non-boolean tracked clean state',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.trackedClean = 'true';
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance schema mismatch; deploy/build before running',
    },
    {
      name: 'a non-object file set',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.files = [];
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance schema mismatch; deploy/build before running',
    },
    {
      name: 'an unsorted file set',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.files = Object.fromEntries(Object.entries(manifest.files).reverse());
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance file set mismatch; deploy/build before running',
    },
    {
      name: 'an extra file path',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.files['packages/engine/dist/search/extra.js'] = '0'.repeat(64);
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance file set mismatch; deploy/build before running',
    },
    {
      name: 'a missing file path',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        delete manifest.files['package-lock.json'];
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance file set mismatch; deploy/build before running',
    },
    {
      name: 'a non-string file hash',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.files['package-lock.json'] = 1;
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker provenance schema mismatch; deploy/build before running',
    },
    {
      name: 'a different commit',
      arrange: (root: string) => {
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.commit = '0000000000000000000000000000000000000000';
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled worker commit mismatch; deploy/build before running',
    },
    {
      name: 'a changed declaration when its manifest commit matches',
      arrange: (root: string) => {
        writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');
        execFileSync('git', ['-C', root, 'add', 'package-lock.json']);
        execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'Change dependency declaration']);
        const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
        manifest.commit = gitHead(root);
        writeFileSync(manifestPath(root), `${JSON.stringify(manifest)}\n`);
      },
      expected: 'compiled provenance hash mismatch: package-lock.json; deploy/build before running',
    },
  ])('rejects $name', ({ arrange, expected }) => {
    const root = createFixtureRepo();
    expect(runProvenance('write', root).status).toBe(0);
    arrange(root);

    const verify = runProvenance('verify', root);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain(expected);
  });
});
