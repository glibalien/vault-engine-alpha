import { describe, it, expect, afterEach } from 'vitest';
import { createSubprocessEmbedder, resolveModelsDir } from '../../src/search/embedder-host.js';
import type { EmbeddingDocumentContext } from '../../src/search/semantic-context.js';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function baseContext(overrides: Partial<EmbeddingDocumentContext> = {}): EmbeddingDocumentContext {
  return {
    source: { kind: 'node' },
    title: 'My Note',
    path: 'Notes/My Note.md',
    types: ['note'],
    fields: {},
    links: [],
    ...overrides,
  };
}

describe('SubprocessEmbedder idle lifecycle', () => {
  let embedder: ReturnType<typeof createSubprocessEmbedder> | null = null;

  afterEach(async () => {
    if (embedder) await embedder.shutdown();
  });

  it('isReady() returns true before spawning', () => {
    embedder = createSubprocessEmbedder({ modelsDir: '' });
    expect(embedder.isReady()).toBe(true);
  });

  it('does not terminate a request that runs longer than the idle timeout', async () => {
    const slowWorkerPath = resolve(import.meta.dirname, '..', 'fixtures', 'slow-embedder-worker.cjs');
    embedder = createSubprocessEmbedder({ modelsDir: '', workerPath: slowWorkerPath, idleTimeoutMs: 25 });

    await embedder.embedDocument('fast');
    const vectors = await embedder.embedDocument('slow');

    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(256);
  });

  it('keeps the worker off this process\'s stdout, which is the MCP channel on stdio', () => {
    const engineDir = resolve(import.meta.dirname, '..', '..');
    const run = spawnSync(resolve(engineDir, '../../node_modules/.bin/tsx'), [
      resolve(import.meta.dirname, '..', 'fixtures', 'embed-once.ts'),
      resolve(import.meta.dirname, '..', 'fixtures', 'stdout-embedder-worker.cjs'),
    ], { cwd: engineDir, encoding: 'utf8', timeout: 60_000 });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('[stdout-embedder-worker] embed served');
  });

  it('sends only bounded semantic context over IPC', async () => {
    // Given
    const contextSizeWorkerPath = resolve(import.meta.dirname, '..', 'fixtures', 'context-size-embedder-worker.cjs');
    embedder = createSubprocessEmbedder({ modelsDir: '', workerPath: contextSizeWorkerPath });
    const context = baseContext({ fields: { huge: 'x'.repeat(2_000_000) } });

    // When
    const [vector] = await embedder.embedDocument('body', context);

    // Then
    expect(vector[0]).toBeLessThanOrEqual(64 * 1024);
  });

  it('bounds aggregate context size before IPC', async () => {
    // Given
    const contextSizeWorkerPath = resolve(import.meta.dirname, '..', 'fixtures', 'context-size-embedder-worker.cjs');
    embedder = createSubprocessEmbedder({ modelsDir: '', workerPath: contextSizeWorkerPath });
    const fields = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`field-${index}`, 'x'.repeat(2 * 1024)]),
    );

    // When
    const [vector] = await embedder.embedDocument('body', baseContext({ fields }));

    // Then
    expect(vector[0]).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('resolveModelsDir', () => {
  it('defaults to the vault engine folder', () => {
    expect(resolveModelsDir('/vault', undefined)).toBe('/vault/.vault-engine/models');
    expect(resolveModelsDir('/vault', '  ')).toBe('/vault/.vault-engine/models');
  });

  it('uses EMBEDDER_MODELS_DIR, resolved against the working directory', () => {
    expect(resolveModelsDir('/vault', ' /data/models ')).toBe('/data/models');
    expect(resolveModelsDir('/vault', 'cache/models')).toBe(resolve('cache/models'));
  });
});
