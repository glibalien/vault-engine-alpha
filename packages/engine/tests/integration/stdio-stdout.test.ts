/**
 * On the stdio transport stdout is the MCP channel: a client reads every line there as a
 * JSON-RPC message. A full server start, and its shutdown, must put their logs on stderr.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sharedTestModelsDir } from '../helpers/test-models-dir.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Lines that are not JSON-RPC messages. */
function strayLines(stdout: string): string[] {
  return stdout.split('\n').filter(line => line.trim() !== '').filter(line => {
    try { return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc !== '2.0'; } catch { return true; }
  });
}

it('writes only MCP messages to stdout on the stdio transport, from start to shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stdio-stdout-')); dirs.push(dir);
  const vault = join(dir, 'vault');
  const engineDir = resolve(import.meta.dirname, '../..');
  // A note, so the start indexes something and has the usual lines to log.
  mkdirSync(vault);
  writeFileSync(join(vault, 'Note.md'), '---\ntypes:\n  - note\n---\nA note.\n');

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'VAULT_TYPE_KEY'));
  const child = spawn(resolve(engineDir, '../../node_modules/.bin/tsx'), [join(engineDir, 'src', 'index.ts'), '--transport', 'stdio'], {
    cwd: engineDir,
    env: {
      ...env, VAULT_PATH: vault, DB_PATH: join(dir, 'vault.db'), DOTENV_CONFIG_QUIET: 'true', EMBEDDER_MODELS_DIR: sharedTestModelsDir(),
      FIREWORKS_API_KEY: '', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', EXA_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-stdout-test', version: '0' } },
  })}\n`);
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Engine did not start\n${stdout}\n${stderr}`)), 60_000);
      const poll = setInterval(() => {
        if (!/"id":1\b/.test(stdout)) return;
        clearInterval(poll); clearTimeout(timer); done();
      }, 25);
      child.once('exit', code => { clearInterval(poll); clearTimeout(timer); fail(new Error(`Engine exited ${code}\n${stdout}\n${stderr}`)); });
    });
  } finally {
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await exited;
  }

  expect(strayLines(stdout)).toEqual([]);
  expect(stdout).toMatch(/"id":1\b/);
  // The logs still exist; they moved.
  expect(stderr).toContain('Indexing vault at');
  expect(stderr).toContain('Shutting down...');
}, 120_000);
