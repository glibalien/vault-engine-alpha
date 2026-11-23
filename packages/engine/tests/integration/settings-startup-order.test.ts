import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { normalizeModelRef } from '@vault/settings-registry';
import { afterEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/db/schema.js';
import { sharedTestModelsDir } from '../helpers/test-models-dir.js';
import { getStoredSettings, setStoredSettings, writeJson } from '../../src/settings/store.js';
import { notePathFor } from '../helpers/settings-notes.js';

const RAW_DEEPSEEK_ID = 'accounts/fireworks/models/deepseek-v4-pro';

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  needle: string,
  logs: { value: string },
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const interval = setInterval(() => {
      if (logs.value.includes(needle)) {
        cleanup();
        resolveWait();
      }
    }, 10);
    const timer = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`Timed out waiting for ${JSON.stringify(needle)}\n${logs.value}`));
    }, timeoutMs);
    const onExit = (code: number | null): void => {
      cleanup();
      rejectWait(new Error(`Engine exited with code ${code} before ${JSON.stringify(needle)}\n${logs.value}`));
    };
    const cleanup = (): void => {
      clearInterval(interval);
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

async function waitUntil(
  predicate: () => boolean,
  diagnostic: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for startup state\n${diagnostic()}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  const clean = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>(resolveWait => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!clean && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

describe('settings startup ordering', () => {
  // The temp vault and the Engine it runs are torn down here, so a failure or timeout
  // anywhere in the test (including before its try block) leaves nothing behind.
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('rejects a handoff-time dangling model ref before legacy model seeding can mint it', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-settings-startup-'));
    cleanups.push(() => rmSync(vaultPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    // The Engine note that shows memoryConsolidationModel (#746).
    const engineNotePath = join(vaultPath, notePathFor('engine', 'memoryConsolidationModel'));
    const dbPath = join(vaultPath, '.vault-engine', 'test.db');
    mkdirSync(dirname(engineNotePath), { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(
      engineNotePath,
      `---\nmemoryConsolidationModel: ${RAW_DEEPSEEK_ID}\n---\nBefore handoff\n`,
      'utf-8',
    );

    // Slow chokidar's initial walk without creating more Markdown nodes (which
    // would trigger expensive startup embeddings). This makes the edit below a
    // deterministic fullIndex -> suspended-watcher handoff edit.
    const delayDir = join(vaultPath, 'handoff-delay');
    mkdirSync(delayDir, { recursive: true });
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(delayDir, `${i}.txt`), 'delay', 'utf-8');
    }

    const setupDb = new Database(dbPath);
    createSchema(setupDb);
    setStoredSettings(setupDb, 'engine', {
      backupsEnabled: false,
      memoryConsolidationModel: RAW_DEEPSEEK_ID,
    });
    writeJson(setupDb, 'settings.seeded', {
      engine: '2026-08-26T00:00:00.000Z',
      wiki: '2026-08-26T00:00:00.000Z',
    });
    setupDb.close();

    const engineDir = resolve(import.meta.dirname, '../..');
    const tsxPath = resolve(engineDir, '../../node_modules/.bin/tsx');
    const child = spawn(tsxPath, [join(engineDir, 'src', 'index.ts'), '--transport', 'stdio'], {
      cwd: engineDir,
      env: {
        ...process.env,
        VAULT_PATH: vaultPath,
        DB_PATH: dbPath,
        VAULT_SETTINGS_DIR: 'Settings',
        EMBEDDER_MODELS_DIR: sharedTestModelsDir(),
        FIREWORKS_API_KEY: '',
        OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '',
        EXA_API_KEY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => stopChild(child));
    const logs = { value: '' };
    child.stdout.on('data', (chunk: Buffer) => { logs.value += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { logs.value += chunk.toString(); });

    try {
      // This log is emitted after fullIndex has committed the old note and
      // immediately before settings startup/watcher handoff orchestration.
      await waitForOutput(child, 'Embedder ready,', logs);
      writeFileSync(
        engineNotePath,
        '---\nextractionEnabled: bogus\nmemoryConsolidationModel: "[[Missing Model]]"\nmysteryKey: keep me\n---\nEdited during handoff\n',
        'utf-8',
      );

      const observer = new Database(dbPath, { readonly: true });
      try {
        await waitUntil(
          () => {
            const modelSeed = observer.prepare(
              "SELECT value FROM meta WHERE key = 'settings.models_seeded'",
            ).get();
            const nullBackfill = observer.prepare(
              "SELECT value FROM meta WHERE key = 'explicit_null_fields_backfill_v1'",
            ).get() as { value: string } | undefined;
            const note = readFileSync(engineNotePath, 'utf-8');
            return modelSeed !== undefined
              && nullBackfill?.value === 'complete'
              && (
                existsSync(join(vaultPath, 'Settings', 'Models', 'Missing Model.md'))
                || note.includes('[!warning] Settings issues')
              );
          },
          () => `${logs.value}\nstored=${JSON.stringify(getStoredSettings(observer, 'engine'))}`
            + `\nnote=${readFileSync(engineNotePath, 'utf-8')}`,
          5_000,
        );

        const stored = getStoredSettings(observer, 'engine');
        const rendered = readFileSync(engineNotePath, 'utf-8');
        expect(logs.value).toMatch(
          /Explicit-null backfill complete: \d+ scanned, 1 reingested, \d+ markers/,
        );
        expect(normalizeModelRef(stored['memoryConsolidationModel'])).toBe('DeepSeek v4 Pro');
        expect(existsSync(join(vaultPath, 'Settings', 'Models', 'DeepSeek v4 Pro.md'))).toBe(true);
        expect(existsSync(join(vaultPath, 'Settings', 'Models', 'Missing Model.md'))).toBe(false);
        expect(observer.prepare(
          'SELECT id FROM nodes WHERE file_path = ?',
        ).get('Settings/Models/DeepSeek v4 Pro.md')).toBeDefined();
        expect(observer.prepare(
          'SELECT id FROM nodes WHERE file_path = ?',
        ).get('Settings/Models/Missing Model.md')).toBeUndefined();
        expect(rendered).toContain('memoryConsolidationModel: "[[Missing Model]]"');
        expect(rendered).toContain('extractionEnabled: bogus');
        expect(rendered).toContain('mysteryKey: keep me');
        expect(rendered).toContain('[!warning] Settings issues');
        expect(rendered).toContain('value in effect: `"[[DeepSeek v4 Pro]]"`');
      } finally {
        observer.close();
      }
    } finally {
      await stopChild(child);
    }
  }, 40_000);
});
