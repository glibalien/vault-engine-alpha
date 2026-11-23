import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAttachmentDir } from '../../src/pipeline/attachment-dir.js';

// The duplicate-case-variant branch of resolveAttachmentDir is only reachable on a
// case-sensitive filesystem, and creating two case-variant directories throws EEXIST
// during fixture setup on a case-insensitive one (issue #68). Probe actual FS behavior
// once — this covers macOS, Windows, and case-sensitive Linux regardless of how the
// host volume is mounted. Fixture portability only; not a resolver-coverage claim.
let caseInsensitiveFs: boolean | undefined;
function isCaseInsensitiveFs(): boolean {
  if (caseInsensitiveFs === undefined) {
    const probe = mkdtempSync(join(tmpdir(), 'vault-attach-case-'));
    try {
      mkdirSync(join(probe, 'CaseProbe'));
      caseInsensitiveFs = existsSync(join(probe, 'caseprobe'));
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  return caseInsensitiveFs;
}

describe('resolveAttachmentDir', () => {
  let vault: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'vault-attach-dir-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    errorSpy.mockRestore();
    rmSync(vault, { recursive: true, force: true });
  });

  it('adopts on-disk Attachments when configured is the lowercase default', () => {
    mkdirSync(join(vault, 'Attachments'));
    expect(resolveAttachmentDir(vault, undefined)).toBe('Attachments');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the exact configured casing with no warning when it matches on disk', () => {
    mkdirSync(join(vault, 'Attachments'));
    expect(resolveAttachmentDir(vault, 'Attachments')).toBe('Attachments');
    expect(warn).not.toHaveBeenCalled();
  });

  it('on-disk casing wins over configured (lowercase folder, capital configured)', () => {
    mkdirSync(join(vault, 'attachments'));
    expect(resolveAttachmentDir(vault, 'Attachments')).toBe('attachments');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the configured/default name unchanged when no folder exists', () => {
    expect(resolveAttachmentDir(vault, undefined)).toBe('attachments');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not throw when the vault root does not exist; returns configured name', () => {
    const missing = join(vault, 'does-not-exist');
    expect(resolveAttachmentDir(missing, 'Attachments')).toBe('Attachments');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it.skipIf(isCaseInsensitiveFs())(
    'prefers the exact casing and warns when multiple case-variants exist',
    () => {
      mkdirSync(join(vault, 'Attachments'));
      mkdirSync(join(vault, 'attachments'));
      expect(resolveAttachmentDir(vault, 'Attachments')).toBe('Attachments');
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});
