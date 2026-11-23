import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { basename, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import { addUndoTables } from '../src/db/migrate.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('HTTP attachment serve route', () => {
  let db: Database.Database;
  // rootDir holds the vault and, beside it, a real image that must never be served.
  let rootDir: string;
  let vaultDir: string;
  let outsideFile: string;
  const attachmentDir = 'Attachments';

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'vault-engine-attach-test-'));
    vaultDir = join(rootDir, 'vault');
    mkdirSync(join(vaultDir, attachmentDir), { recursive: true });
    outsideFile = join(rootDir, 'outside.png');
    writeFileSync(outsideFile, PNG_BYTES);
    db = openDatabase(join(vaultDir, '.vault-engine', 'vault.db'));
    createSchema(db);
    addUndoTables(db);
  });

  afterEach(() => {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  function app() {
    return createHttpApp(() => createServer(db), undefined, { vaultPath: vaultDir, dir: attachmentDir });
  }

  it('serves an attachment whose filename contains spaces (Obsidian screenshot names)', async () => {
    const name = 'Screenshot 2026-06-19 at 1.04.29 PM.png';
    writeFileSync(join(vaultDir, attachmentDir, name), PNG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent(name)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
  });

  it('serves an attachment with parentheses in the name', async () => {
    const name = 'Pasted image (1).png';
    writeFileSync(join(vaultDir, attachmentDir, name), PNG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent(name)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('serves a slugified engine-generated filename', async () => {
    const name = 'my-photo-a1b2c3d4e5f6.png';
    writeFileSync(join(vaultDir, attachmentDir, name), PNG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent(name)}`);

    expect(res.status).toBe(200);
  });

  it('404s for a nonexistent attachment', async () => {
    const res = await request(app()).get('/attachments/does-not-exist.png');
    expect(res.status).toBe(404);
  });

  it('404s for a non-image extension', async () => {
    writeFileSync(join(vaultDir, attachmentDir, 'notes.md'), 'secret');
    const res = await request(app()).get('/attachments/notes.md');
    expect(res.status).toBe(404);
  });

  it('404s for traversal refs that escape the vault root', async () => {
    // Each ref resolves to the real image just outside the vault, so only containment stops it.
    // Slashes are sent encoded: a real slash never reaches the single-segment :ref route.
    for (const ref of ['../outside.png', 'Attachments/../../outside.png', 'Attachments/sub/../../../outside.png']) {
      const res = await request(app()).get(`/attachments/${encodeURIComponent(ref)}`);
      expect(res.status, `ref=${ref}`).toBe(404);
    }
  });

  it('404s for a symlink in the vault that leads outside it', async () => {
    symlinkSync(outsideFile, join(vaultDir, attachmentDir, 'linked-out.png'));
    symlinkSync(rootDir, join(vaultDir, attachmentDir, 'up'));
    for (const ref of ['linked-out.png', 'Attachments/linked-out.png', 'Attachments/up/outside.png']) {
      const res = await request(app()).get(`/attachments/${encodeURIComponent(ref)}`);
      expect(res.status, `ref=${ref}`).toBe(404);
    }
  });

  it('serves a symlink to an image elsewhere inside the vault', async () => {
    mkdirSync(join(vaultDir, 'Images'));
    writeFileSync(join(vaultDir, 'Images', 'real.png'), PNG_BYTES);
    symlinkSync(join(vaultDir, 'Images', 'real.png'), join(vaultDir, attachmentDir, 'linked-in.png'));

    const res = await request(app()).get('/attachments/linked-in.png');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
  });

  it('serves attachments from a vault reached through a symlinked root', async () => {
    const linkedRoot = join(rootDir, 'vault-link');
    symlinkSync(vaultDir, linkedRoot);
    writeFileSync(join(vaultDir, attachmentDir, 'pic.png'), PNG_BYTES);
    mkdirSync(join(vaultDir, 'Notes'));
    writeFileSync(join(vaultDir, 'Notes', 'elsewhere.png'), PNG_BYTES);
    const linked = createHttpApp(() => createServer(db), undefined, { vaultPath: linkedRoot, dir: attachmentDir });

    // Attachment dir, vault-root-relative, and the vault-wide search.
    for (const ref of ['pic.png', 'Attachments/pic.png', 'elsewhere.png']) {
      const res = await request(linked).get(`/attachments/${encodeURIComponent(ref)}`);
      expect(res.status, `ref=${ref}`).toBe(200);
      expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
    }
  });

  const SVG_BYTES = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Icon</title><rect width="10" height="10"/></svg>`,
    'utf-8',
  );

  it('serves a subfolder embed ref (Attachments/sub/x.png) via %2F encoding', async () => {
    mkdirSync(join(vaultDir, attachmentDir, 'sub'), { recursive: true });
    writeFileSync(join(vaultDir, attachmentDir, 'sub', 'diagram.png'), PNG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent('Attachments/sub/diagram.png')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
  });

  it('serves an .svg as image/svg+xml with a hardening CSP', async () => {
    writeFileSync(join(vaultDir, attachmentDir, 'icon.svg'), SVG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent('icon.svg')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('resolves a bare filename vault-wide when not in the attachment dir', async () => {
    mkdirSync(join(vaultDir, 'Notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'Notes', 'embedded-pic.png'), PNG_BYTES);

    const res = await request(app()).get(`/attachments/${encodeURIComponent('embedded-pic.png')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('blocks traversal outside the vault root', async () => {
    // The real image outside the vault must be unreachable: by absolute path, by climbing past
    // the vault's parent and back down, or with the dots percent-encoded too.
    for (const path of [
      encodeURIComponent(outsideFile),
      encodeURIComponent(`../../${basename(rootDir)}/outside.png`),
      '%2E%2E%2Foutside.png',
    ]) {
      const res = await request(app()).get(`/attachments/${path}`);
      expect(res.status, `path=${path}`).toBe(404);
    }
  });
});
