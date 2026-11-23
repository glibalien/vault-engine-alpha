import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubprocessEmbedder } from '../../src/search/embedder-host.js';

const configuredModelsDir = process.env.VAULT_ENGINE_MODELS_DIR?.trim();
if (!configuredModelsDir) {
  throw new Error(
    'VAULT_ENGINE_MODELS_DIR is required for real-model tests; point it at the dedicated test cache',
  );
}

const modelsDir = resolve(configuredModelsDir);
const nomicDir = resolve(modelsDir, 'nomic-ai');
if (!existsSync(nomicDir)) {
  throw new Error(`Nomic model cache not found: ${nomicDir}`);
}

const workerPath = resolve(import.meta.dirname, '..', '..', 'dist', 'search', 'embedder-worker.js');
if (!existsSync(workerPath)) {
  throw new Error(
    `Compiled embedder worker not found: ${workerPath}; run npm run build -w vault-engine first`,
  );
}

describe('SubprocessEmbedder (real model)', () => {
  let embedder: ReturnType<typeof createSubprocessEmbedder> | null = null;
  const temporaryRoots: string[] = [];
  const priorPidLog = process.env.VAULT_ENGINE_MODEL_TEST_PID_LOG;

  afterEach(async () => {
    try {
      if (embedder) {
        await embedder.shutdown();
      }
    } finally {
      embedder = null;
      for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
      if (priorPidLog === undefined) {
        delete process.env.VAULT_ENGINE_MODEL_TEST_PID_LOG;
      } else {
        process.env.VAULT_ENGINE_MODEL_TEST_PID_LOG = priorPidLog;
      }
    }
  });

  it('embeds a document via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const vectors = await embedder.embedDocument('Hello world');
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBe(1);
    const [vec] = vectors;
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeGreaterThan(0);
  }, 30_000);

  it('embeds a query via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const vec = await embedder.embedQuery('find meetings');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
    const magnitude = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeGreaterThan(0);
  }, 30_000);

  it('handles concurrent requests', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const [a, b, c] = await Promise.all([
      embedder.embedDocument('first'),
      embedder.embedDocument('second'),
      embedder.embedQuery('third'),
    ]);
    expect(a[0].length).toBe(256);
    expect(b[0].length).toBe(256);
    expect(c.length).toBe(256);
  }, 30_000);

  it('respawns after shutdown', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const v1 = await embedder.embedDocument('before shutdown');
    expect(v1[0].length).toBe(256);

    await embedder.shutdown();

    const v2 = await embedder.embedDocument('after shutdown');
    expect(v2[0].length).toBe(256);
  }, 60_000);

  it('idle timeout kills child process', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'embedder-idle-model-'));
    temporaryRoots.push(root);
    const pidLog = resolve(root, 'worker-pids');
    process.env.VAULT_ENGINE_MODEL_TEST_PID_LOG = pidLog;
    const wrapperPath = resolve(import.meta.dirname, '..', 'fixtures', 'real-embedder-worker-wrapper.mjs');

    embedder = createSubprocessEmbedder({ modelsDir, workerPath: wrapperPath, idleTimeoutMs: 1_000 });
    await embedder.embedDocument('trigger spawn');

    await new Promise(resolveWait => setTimeout(resolveWait, 2_000));

    const vectors = await embedder.embedDocument('after idle');
    expect(vectors[0].length).toBe(256);

    const pids = readFileSync(pidLog, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    expect(pids.every(pid => Number.isInteger(pid) && pid > 0)).toBe(true);
    expect(pids[1]).not.toBe(pids[0]);
  }, 60_000);

  it('chunks long documents into multiple vectors', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const longText = Array.from({ length: 300 }, (_, i) =>
      `## Section ${i}\nThis is paragraph ${i}. ` + 'word '.repeat(30)
    ).join('\n\n');
    const vectors = await embedder.embedDocument(longText);
    expect(vectors.length).toBeGreaterThan(1);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(256);
      const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
      expect(magnitude).toBeGreaterThan(0);
    }
  }, 60_000);
});
