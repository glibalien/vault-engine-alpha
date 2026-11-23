import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workerSource = resolve(import.meta.dirname, '..', '..', 'src', 'search', 'embedder-worker.ts');
const temporaryRoots: string[] = [];

function runWorker(offline: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'embedder-worker-offline-'));
  temporaryRoots.push(root);

  const cacheDir = join(root, 'cache');
  const fetchMarker = join(root, 'fetch-attempted');
  const fetchHook = join(root, 'intercept-fetch.mjs');
  mkdirSync(cacheDir);
  writeFileSync(fetchHook, `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => {
      writeFileSync(process.env.FETCH_MARKER, 'attempted');
      throw new Error('network attempted');
    };
  `);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, FETCH_MARKER: fetchMarker };
  if (offline) childEnv.VAULT_ENGINE_MODELS_OFFLINE = '1';
  else delete childEnv.VAULT_ENGINE_MODELS_OFFLINE;

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', fetchHook, workerSource, cacheDir],
    { encoding: 'utf8', env: childEnv, timeout: 20_000 },
  );

  return { result, fetchAttempted: existsSync(fetchMarker) };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('embedder worker model-loading policy', () => {
  it('does not request the network when validation requires offline models', () => {
    const { result, fetchAttempted } = runWorker(true);

    expect(result.status).toBe(1);
    expect(fetchAttempted).toBe(false);
  });

  it('preserves remote model loading for ordinary production startup', () => {
    const { result, fetchAttempted } = runWorker(false);

    expect(result.status).toBe(1);
    expect(fetchAttempted).toBe(true);
  });
});
