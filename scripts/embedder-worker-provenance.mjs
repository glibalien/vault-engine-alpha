#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const SCHEMA_VERSION = 3;
const ENGINE_DIST_RELATIVE = 'packages/engine/dist';
const WORKER_RELATIVE = 'packages/engine/dist/search/embedder-worker.js';
const MANIFEST_RELATIVE = 'packages/engine/dist/search/embedder-worker.build.json';
const DECLARATION_RELATIVES = ['package-lock.json', 'packages/engine/package.json'];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitHead(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isTrackedCheckoutClean(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'diff', '--quiet', 'HEAD', '--'], {
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git diff failed with status ${String(result.status)}`);
}

function manifestPath(repoRoot) {
  return resolve(repoRoot, MANIFEST_RELATIVE);
}

function collectCompiledClosure(repoRoot) {
  const distRoot = resolve(repoRoot, ENGINE_DIST_RELATIVE);
  const queue = [resolve(repoRoot, WORKER_RELATIVE)];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.pop();
    const relativeToDist = relative(distRoot, current);
    if (relativeToDist === '..' || relativeToDist.startsWith(`..${sep}`) || isAbsolute(relativeToDist)) {
      throw new Error(`compiled dependency escapes packages/engine/dist: ${current}`);
    }
    if (visited.has(current)) continue;
    if (!existsSync(current)) throw new Error(`compiled dependency missing: ${current}`);
    visited.add(current);

    const source = readFileSync(current, 'utf8');
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      queue.push(resolve(dirname(current), imported.fileName));
    }
  }

  return [...visited]
    .map((path) => relative(repoRoot, path).split(sep).join('/'))
    .sort();
}

function collectCoveredFiles(repoRoot) {
  return [...DECLARATION_RELATIVES, ...collectCompiledClosure(repoRoot)].sort();
}

function hashCoveredFiles(repoRoot) {
  return Object.fromEntries(
    collectCoveredFiles(repoRoot).map((file) => [file, sha256(resolve(repoRoot, file))]),
  );
}

function writeManifest(repoRoot) {
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    commit: gitHead(repoRoot),
    trackedClean: isTrackedCheckoutClean(repoRoot),
    files: hashCoveredFiles(repoRoot),
  };
  writeFileSync(manifestPath(repoRoot), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!manifest.trackedClean) {
    console.warn('[worker-provenance] WARNING: tracked checkout is dirty; scheduled model validation will reject this build');
  }
  console.log(manifestPath(repoRoot));
}

function verifyManifest(repoRoot) {
  let manifestText;
  try {
    manifestText = readFileSync(manifestPath(repoRoot), 'utf8');
  } catch {
    fail('compiled worker provenance missing; deploy/build before running');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail('compiled worker provenance is malformed; deploy/build before running');
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== SCHEMA_VERSION) {
    fail('compiled worker provenance schema mismatch; deploy/build before running');
  }
  if (typeof manifest.trackedClean !== 'boolean' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    fail('compiled worker provenance schema mismatch; deploy/build before running');
  }
  const manifestPaths = Object.keys(manifest.files);
  if (manifestPaths.some((path) => typeof manifest.files[path] !== 'string')) {
    fail('compiled worker provenance schema mismatch; deploy/build before running');
  }
  if (!manifest.trackedClean) {
    fail('compiled worker was built from a dirty tracked checkout; deploy/build from a clean checkout before running');
  }
  if (!isTrackedCheckoutClean(repoRoot)) {
    fail('tracked checkout is dirty; deploy/build from a clean checkout before running');
  }

  const commit = gitHead(repoRoot);
  if (manifest.commit !== commit) {
    fail('compiled worker commit mismatch; deploy/build before running');
  }

  const files = hashCoveredFiles(repoRoot);
  const expectedPaths = Object.keys(files);
  if (
    manifestPaths.length !== expectedPaths.length
    || manifestPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    fail('compiled worker provenance file set mismatch; deploy/build before running');
  }
  for (const path of expectedPaths) {
    if (manifest.files[path] !== files[path]) {
      fail(`compiled provenance hash mismatch: ${path}; deploy/build before running`);
    }
  }

  return {
    attestationFingerprint: createHash('sha256').update(manifestText).digest('hex'),
    commit,
  };
}

function fail(message) {
  console.error(`[worker-provenance] ERROR: ${message}`);
  process.exit(1);
}

function usage() {
  console.error('Usage: node scripts/embedder-worker-provenance.mjs <write|verify|verify-attestation> <repo-root>');
  process.exit(2);
}

const [command, repoRoot] = process.argv.slice(2);
if (!repoRoot || (command !== 'write' && command !== 'verify' && command !== 'verify-attestation')) usage();

try {
  if (command === 'write') writeManifest(repoRoot);
  else {
    const verified = verifyManifest(repoRoot);
    if (command === 'verify') console.log(verified.commit);
    else console.log(`${verified.commit} ${verified.attestationFingerprint}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
