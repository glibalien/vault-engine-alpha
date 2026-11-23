import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEmbedAttachment } from '../../src/mcp/tools/embed-attachment.js';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function handlerFor(vaultPath: string, attachmentDir = 'attachments') {
  let captured!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  const fake = { tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => { captured = (a) => h(a) as Promise<{ content: Array<{ text: string }> }>; } } as unknown as McpServer;
  registerEmbedAttachment(fake, vaultPath, attachmentDir);
  return captured;
}
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
const WEBM_B64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'); // EBML/WebM magic

describe('embed-attachment', () => {
  it('writes the image into the attachment dir and returns its ref', async () => {
    const vault = mkdtempSync(join(tmpdir(), 've-att-')); dirs.push(vault);
    const env = parse(await handlerFor(vault)({ filename: 'shot.png', mime: 'image/png', data_base64: PNG_B64 }));
    expect(env.ok).toBe(true);
    expect(env.data.ref).toMatch(/^shot-[0-9a-f]{12}\.png$/);
    expect(env.data.vault_path).toBe(`attachments/${env.data.ref}`);
    const onDisk = join(vault, 'attachments', env.data.ref);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });
  it('is idempotent — re-embedding the same bytes returns the same ref and does not error', async () => {
    const vault = mkdtempSync(join(tmpdir(), 've-att-')); dirs.push(vault);
    const h = handlerFor(vault);
    const a = parse(await h({ filename: 'a.png', mime: 'image/png', data_base64: PNG_B64 }));
    const b = parse(await h({ filename: 'a.png', mime: 'image/png', data_base64: PNG_B64 }));
    expect(b.ok).toBe(true);
    expect(b.data.ref).toBe(a.data.ref);
  });
  it('rejects a non-image mime', async () => {
    const vault = mkdtempSync(join(tmpdir(), 've-att-')); dirs.push(vault);
    const env = parse(await handlerFor(vault)({ filename: 'x.txt', mime: 'text/plain', data_base64: PNG_B64 }));
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });
  it('writes an audio/webm attachment and returns a .webm ref', async () => {
    const vault = mkdtempSync(join(tmpdir(), 've-att-')); dirs.push(vault);
    const env = parse(await handlerFor(vault)({ filename: 'Recording 20260618213455', mime: 'audio/webm', data_base64: WEBM_B64 }));
    expect(env.ok).toBe(true);
    expect(env.data.ref).toMatch(/^recording-20260618213455-[0-9a-f]{12}\.webm$/);
    expect(existsSync(join(vault, 'attachments', env.data.ref))).toBe(true);
  });
});
