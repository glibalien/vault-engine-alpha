import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileBuffer } from '../../src/pipeline/file-writer.js';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe('atomicWriteFileBuffer', () => {
  it('writes binary bytes exactly, creating parent dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 've-fw-')); dirs.push(root);
    const target = join(root, 'attachments', 'x.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    atomicWriteFileBuffer(target, bytes, join(root, '.tmp'));
    expect(readFileSync(target).equals(bytes)).toBe(true);
  });
});
