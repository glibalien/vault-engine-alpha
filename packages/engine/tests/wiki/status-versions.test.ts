import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { contentVersion, recordStatusOnlyWrite, sameButForStatus } from '../../src/wiki/status-versions.js';

// #547: versions of a wiki home that only status writes produced.
describe('status-only versions', () => {
  function db() {
    const d = createTestDb();
    d.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, version) VALUES ('h', 'Wikis/H.md', 'H', '', 'x', 0, 0, 1)").run();
    return d;
  }

  it('treats a run of status writes as one version', () => {
    const d = db();
    recordStatusOnlyWrite(d, 'h', 10, 11);
    recordStatusOnlyWrite(d, 'h', 11, 12);

    expect(sameButForStatus(d, 'h', 10, 12)).toBe(true);
    expect(sameButForStatus(d, 'h', 11, 12)).toBe(true);
    expect(sameButForStatus(d, 'h', 9, 12)).toBe(false);
    expect(contentVersion(d, 'h', 12)).toBe(10);
  });

  it('ends the run at any other write', () => {
    const d = db();
    recordStatusOnlyWrite(d, 'h', 10, 11);

    // Version 12 came from an edit, so the status write before it no longer counts.
    expect(sameButForStatus(d, 'h', 10, 12)).toBe(false);
    expect(contentVersion(d, 'h', 12)).toBe(12);

    recordStatusOnlyWrite(d, 'h', 12, 13);
    expect(sameButForStatus(d, 'h', 12, 13)).toBe(true);
    expect(sameButForStatus(d, 'h', 10, 13)).toBe(false);
    expect(contentVersion(d, 'h', 13)).toBe(12);
  });

  it('compares versions exactly for a node with no status writes', () => {
    const d = db();
    expect(sameButForStatus(d, 'h', 4, 4)).toBe(true);
    expect(sameButForStatus(d, 'h', 3, 4)).toBe(false);
    expect(sameButForStatus(d, 'h', 5, 4)).toBe(false);
    expect(contentVersion(d, 'h', 4)).toBe(4);
  });
});
