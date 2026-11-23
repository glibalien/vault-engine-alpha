import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { MemoryService } from '../../src/memories/service.js';
import { MemoryNoteReceipts } from '../../src/memories/note-receipts.js';
import { MemoryNoteIngest } from '../../src/memories/note-ingest.js';
import { renderMemoryNote, memoryNotePath, editableMemoryHash } from '../../src/memories/note-format.js';
import type { MemoryProjectionRow } from '../../src/memories/types.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let service: MemoryService;
let receipts: MemoryNoteReceipts;
let ingest: MemoryNoteIngest;
const SETTINGS_DIR = 'Settings';
const NOTE_PATH = memoryNotePath(SETTINGS_DIR);

function writeNote(content: string): string {
  const p = join(vaultPath, NOTE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return content;
}

/** Simulate what the watcher does: index the note as an ordinary node. */
function indexNote(content: string): { id: string; content_hash: string } {
  const hash = 'sha256:' + createHash('sha256').update(content).digest('hex');
  // Ensure a nodes row exists for the memory note path.
  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE_PATH) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(hash, existing.id);
    return { id: existing.id, content_hash: hash };
  }
  const id = `mem-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO nodes (id, file_path, title, content_hash) VALUES (?, ?, ?, ?)').run(id, NOTE_PATH, 'Memories', hash);
  return { id, content_hash: hash };
}

/** Write the note and index it, returning the indexed content hash. */
function writeAndIndexNote(content: string): void {
  writeNote(content);
  indexNote(content);
}

function makeRow(partial: Partial<MemoryProjectionRow> & { id: number; content: string; updated_at: string; source: string }): MemoryProjectionRow {
  return {
    scope: 'vault', node_id: null, category: null, metadata: null,
    created_at: partial.updated_at, expired_at: null, valid_at: partial.updated_at,
    invalid_at: null, superseded_by: null, predecessors: [],
    evidence_kind: 'conversation', evidence_node_id: null, evidence_hash: null,
    evidence_ref: 'test#0', expire_reason: null, changed_by: null, embedded: false, subjects: [], ...partial,
  };
}

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new MemoryService(db);
  receipts = new MemoryNoteReceipts(db);
  ingest = new MemoryNoteIngest({ db, vaultPath, settingsDir: SETTINGS_DIR, service, receipts });
});
afterEach(() => { cleanup(); db.close(); });

describe('MemoryNoteIngest', () => {
  it('handles only the memory note path', () => {
    expect(ingest.handles(NOTE_PATH)).toBe(true);
    expect(ingest.handles('Settings/Engine.md')).toBe(false);
    expect(ingest.handles('Notes/Random.md')).toBe(false);
  });

  it('content versioning: edits content → new versioned row via MemoryService.update', async () => {
    // Seed a memory
    const { result } = await service.create({ source: 'chat', content: 'original fact', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;

    // Render the canonical note and edit the content
    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('original fact', 'revised fact');
    writeAndIndexNote(edited);

    // Simulate the watcher hook (the node is already indexed as ordinary)
    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    // The original row should be expired (superseded), and a new live row exists
    const liveRows = db.prepare('SELECT content FROM memories WHERE expired_at IS NULL').all() as { content: string }[];
    expect(liveRows.map((r) => r.content)).toContain('revised fact');
    const oldRow = db.prepare('SELECT expired_at, superseded_by FROM memories WHERE id = ?').get(id) as { expired_at: string | null; superseded_by: number | null };
    expect(oldRow.expired_at).not.toBeNull();
    expect(oldRow.superseded_by).not.toBeNull();
  });

  it('category-only edit: stays in place (same id, no new row)', async () => {
    const { result } = await service.create({ source: 'chat', content: 'stable fact', scope: 'vault', evidence: EV, category: 'fact' });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('category: fact', 'category: preference');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    const row = db.prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string | null };
    expect(row.category).toBe('preference');
  });

  it('expire: status live→expired retires the memory', async () => {
    const { result } = await service.create({ source: 'chat', content: 'to expire', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('status: live', 'status: expired');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const row = db.prepare('SELECT expired_at, expire_reason FROM memories WHERE expired_at IS NOT NULL').get() as { expired_at: string; expire_reason: string };
    expect(row.expire_reason).toBe('owner-edited-memory-note');
  });

  it('reactivate: status expired→live un-retires the memory', async () => {
    const { result } = await service.create({ source: 'chat', content: 'phoenix', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;
    await service.expire({ id, reason: 'test' });

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('status: expired', 'status: live');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const row = db.prepare('SELECT expired_at FROM memories WHERE id = ?').get(id) as { expired_at: string | null };
    expect(row.expired_at).toBeNull();
  });

  it('no-op echo: unchanged content produces no mutation', async () => {
    const { result } = await service.create({ source: 'chat', content: 'stable', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    writeAndIndexNote(rendered.bytes); // unchanged

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
  });

  it('stale conflict: DB advanced past the marker revision → reject and receipt', async () => {
    const { result } = await service.create({ source: 'chat', content: 'v1', scope: 'vault', evidence: EV, category: 'fact' });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;

    // Render the note (captures revision = updated_at at time T1)
    const snapshot1 = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot1, []);

    // Ensure the next update gets a different timestamp (T2 > T1).
    await new Promise((r) => setTimeout(r, 10));

    // DB advances: category-only update (stays in place, bumps updated_at to T2)
    await service.update({ id, category: 'preference' });

    // Now apply the OLD note (revision still points at T1, but DB is at T2).
    // Edit only the content (not status) to avoid the compound-edit rejection.
    const edited = rendered.bytes.replace('v1', 'edited from note');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    // The stale edit should NOT have been applied — DB state wins.
    const liveRow = db.prepare('SELECT content, category FROM memories WHERE id = ?').get(id) as { content: string; category: string | null };
    expect(liveRow.content).toBe('v1'); // content unchanged
    expect(liveRow.category).toBe('preference'); // DB category change preserved

    // A conflict receipt should exist
    const conflictReceipts = receipts.findByBlockKey(`mem:${id}`);
    expect(conflictReceipts.some((r) => r.outcome === 'conflict')).toBe(true);
  });

  it('stale status change cannot expire a memory after its revision advanced', async () => {
    const { result } = await service.create({ source: 'chat', content: 'must remain live', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;
    const rendered = renderMemoryNote(service.snapshotAll(), []);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.update({ id, metadata: { revision_advanced: true } });
    const edited = rendered.bytes.replace('status: live', 'status: expired');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const row = db.prepare('SELECT expired_at FROM memories WHERE id = ?').get(id) as { expired_at: string | null };
    expect(row.expired_at).toBeNull();
    expect(receipts.findByBlockKey(`mem:${id}`).some((receipt) => receipt.outcome === 'conflict')).toBe(true);
  });

  it('repeated delivery: same edit applied twice is an idempotent no-op', async () => {
    const { result } = await service.create({ source: 'chat', content: 'dedup me', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');
    const id = result.data.id;

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('dedup me', 'dedup me edited');
    writeAndIndexNote(edited);

    // First delivery
    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterFirst = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

    // Second delivery — same file, same content
    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterSecond = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    expect(afterSecond).toBe(afterFirst);
  });

  it('whole-note validation rejection: corrupted YAML → zero memory changes + edits_log', async () => {
    await service.create({ source: 'chat', content: 'existing', scope: 'vault', evidence: EV });
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

    // Write a note with a broken block (missing close fence)
    const broken = `<!-- ve:memory:1 revision="t" base="sha256:x" -->
~~~~yaml
id: 1
status: live
content: broken
~~~~
<!-- /ve:memory:1 -->

<!-- ve:memory:2 revision="t" base="sha256:x" -->
~~~~yaml
id: 2
: : : broken yaml
`;
    writeAndIndexNote(broken);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount); // no changes

    // An edits_log rejection event should exist
    const logRow = db.prepare("SELECT event_type FROM edits_log WHERE event_type = 'memory-note-rejected'").get() as { event_type: string } | undefined;
    expect(logRow).toBeDefined();
  });

  it('unlink never changes memories', async () => {
    await service.create({ source: 'chat', content: 'persist', scope: 'vault', evidence: EV });
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;

    ingest.onFileEvent(NOTE_PATH, 'unlink');
    await ingest.drain();

    const afterCount = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
  });

  it('zero canonical file writes: ingest never writes the note file', async () => {
    await service.create({ source: 'chat', content: 'test', scope: 'vault', evidence: EV });

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('test', 'test edited');
    writeAndIndexNote(edited);

    // Capture the file content before ingest
    const beforeContent = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    // The file on disk should be unchanged — ingest never writes it
    const afterContent = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(afterContent).toBe(beforeContent);
  });
});

describe('MemoryNoteIngest — owner-authored additions (Task 5)', () => {
  it('new:<uuid> block creates a live source=owner memory', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const draftNote = renderMemoryNote([], []).bytes + `
<!-- ve:memory:new:${uuid} revision="new" base="sha256:dummy" -->
~~~~yaml
id: new:${uuid}
status: live
content: An owner-authored fact.
category: fact
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:${uuid} -->
`;
    writeAndIndexNote(draftNote);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const rows = db.prepare("SELECT source, content, category FROM memories WHERE source = 'owner' AND expired_at IS NULL").all() as { source: string; content: string; category: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('An owner-authored fact.');
    expect(rows[0]!.category).toBe('fact');
  });

  describe('subjects (#554)', () => {
    function person(id: string, title: string): void {
      db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)').run(id, `People/${title}.md`, title, '', `h-${id}`);
      db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES (?, 'person')").run(id);
    }
    const subjectRows = (id: number) => db.prepare('SELECT name, node_id, set_by FROM memory_subjects WHERE memory_id = ? ORDER BY rowid').all(id);

    it('renders a memory\'s subjects after its category, and a block without any as before', async () => {
      person('dana', 'Dana Whitfield');
      const { result } = await service.create({ source: 'chat', content: 'Dana runs the pilot', scope: 'vault', evidence: EV, subjects: ['Dana Whitfield', 'Rowan Hale'] });
      const { result: plain } = await service.create({ source: 'chat', content: 'Lunch is at noon', scope: 'vault', evidence: EV });
      if (!result.ok || !plain.ok) throw new Error('create failed');
      const bytes = renderMemoryNote(service.snapshotAll(), []).bytes;
      expect(bytes).toContain('category:\nsubjects:\n  - Dana Whitfield\n  - Rowan Hale\nsource: chat');
      // No subjects: no line, and the same base as before subjects existed.
      const plainBase = editableMemoryHash({ content: 'Lunch is at noon', category: null, status: 'live' });
      expect(bytes).toContain(`<!-- ve:memory:${plain.data.id} revision="${plain.data.updated_at}" base="${plainBase}" -->`);
      expect(editableMemoryHash({ content: 'x', category: null, status: 'live', subjects: [] }))
        .toBe(editableMemoryHash({ content: 'x', category: null, status: 'live' }));
      // Order and case of names are no edit.
      expect(editableMemoryHash({ content: 'x', category: null, status: 'live', subjects: ['B', 'a'] }))
        .toBe(editableMemoryHash({ content: 'x', category: null, status: 'live', subjects: ['A', 'b'] }));
    });

    it('applies the owner\'s subject edits in place, set by the owner, keeping unchanged ones as they were set', async () => {
      person('dana', 'Dana Whitfield');
      person('lee', 'Lee Okafor');
      const { result } = await service.create({ source: 'chat', content: 'Dana runs the pilot', scope: 'vault', evidence: EV, subjects: ['Dana Whitfield'] });
      if (!result.ok) throw new Error('create failed');
      const rendered = renderMemoryNote(service.snapshotAll(), []);
      writeAndIndexNote(rendered.bytes.replace('  - Dana Whitfield\n', '  - Dana Whitfield\n  - "[[Lee Okafor]]"\n'));
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      expect(subjectRows(result.data.id)).toEqual([
        { name: 'Dana Whitfield', node_id: 'dana', set_by: 'tool' },
        { name: 'Lee Okafor', node_id: 'lee', set_by: 'owner' },
      ]);
      expect((db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    });

    it('adds subjects to a block that had none, an unquoted link included', async () => {
      person('dana', 'Dana Whitfield');
      const { result } = await service.create({ source: 'chat', content: 'Dana likes tea', scope: 'vault', evidence: EV, category: 'fact' });
      if (!result.ok) throw new Error('create failed');
      const rendered = renderMemoryNote(service.snapshotAll(), []);
      writeAndIndexNote(rendered.bytes.replace('category: fact\n', 'category: fact\nsubjects:\n  - [[Dana Whitfield]]\n'));
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      expect(subjectRows(result.data.id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'owner' }]);
    });

    it('a one-word name the owner types links, as the owner\'s own link', async () => {
      person('dana', 'Dana');
      const { result } = await service.create({ source: 'chat', content: 'Dana likes tea', scope: 'vault', evidence: EV, category: 'fact' });
      if (!result.ok) throw new Error('create failed');
      writeAndIndexNote(renderMemoryNote(service.snapshotAll(), []).bytes.replace('category: fact\n', 'category: fact\nsubjects: Dana\n'));
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      expect(subjectRows(result.data.id)).toEqual([{ name: 'Dana', node_id: 'dana', set_by: 'owner' }]);
    });

    it('a new: block can name its subjects', async () => {
      person('dana', 'Dana Whitfield');
      const uuid = '550e8400-e29b-41d4-a716-446655440001';
      writeAndIndexNote(renderMemoryNote([], []).bytes + `
<!-- ve:memory:new:${uuid} revision="new" base="sha256:dummy" -->
~~~~yaml
id: new:${uuid}
status: live
content: Never call the Northwind product NCL.
category: rule
subjects: Dana Whitfield
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:${uuid} -->
`);
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      const row = db.prepare("SELECT id FROM memories WHERE source = 'owner'").get() as { id: number };
      expect(subjectRows(row.id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'owner' }]);
    });

    it('a rename of the subject\'s note leaves the note\'s blocks as they are', async () => {
      person('dana', 'Dana Whitfield');
      const { result } = await service.create({ source: 'chat', content: 'Dana runs the pilot', scope: 'vault', evidence: EV, category: 'fact', subjects: ['Dana Whitfield'] });
      if (!result.ok) throw new Error('create failed');
      const rendered = renderMemoryNote(service.snapshotAll(), []);
      db.prepare("UPDATE nodes SET title = 'Dana Whitfield-Ng', file_path = 'People/Dana Whitfield-Ng.md' WHERE id = 'dana'").run();
      // The owner edits the category; the stale-looking subject name is no edit.
      writeAndIndexNote(rendered.bytes.replace('category: fact', 'category: preference'));
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      expect(db.prepare('SELECT category FROM memories WHERE id = ?').get(result.data.id)).toEqual({ category: 'preference' });
      expect(subjectRows(result.data.id)).toEqual([{ name: 'Dana Whitfield', node_id: 'dana', set_by: 'tool' }]);
    });

    it('subjects carried onto a memory after the note was rendered make its block stale, not a rejected note', async () => {
      const { result: kept } = await service.create({ source: 'chat', content: 'Survivor fact', scope: 'vault', evidence: EV });
      const { result: gone } = await service.create({ source: 'chat', content: 'Zz retired fact', scope: 'vault', evidence: EV, subjects: ['Rowan Hale'] });
      const { result: other } = await service.create({ source: 'chat', content: 'Other fact', scope: 'vault', evidence: EV, category: 'fact' });
      if (!kept.ok || !gone.ok || !other.ok) throw new Error('create failed');
      const rendered = renderMemoryNote(service.snapshotAll(), []);
      await new Promise((r) => setTimeout(r, 5));
      await service.expire({ id: gone.data.id, reason: 'duplicate', superseded_by: kept.data.id });
      // An unrelated edit elsewhere in the note still applies.
      writeAndIndexNote(rendered.bytes.replace('category: fact', 'category: preference'));
      ingest.onFileEvent(NOTE_PATH, 'change');
      await ingest.drain();
      expect(db.prepare('SELECT category FROM memories WHERE id = ?').get(other.data.id)).toEqual({ category: 'preference' });
      expect(subjectRows(kept.data.id)).toEqual([{ name: 'Rowan Hale', node_id: null, set_by: 'tool' }]);
    });
  });

  it('new-draft idempotency: repeated delivery of the same draft is single-shot', async () => {
    const uuid = '660e8400-e29b-41d4-a716-446655440000';
    const draftNote = `
<!-- ve:memory:new:${uuid} revision="new" base="sha256:dummy" -->
~~~~yaml
id: new:${uuid}
status: live
content: Owner fact to dedup.
category: fact
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:${uuid} -->
`;
    writeAndIndexNote(draftNote);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterFirst = (db.prepare('SELECT COUNT(*) c FROM memories WHERE source = ?').get('owner') as { c: number }).c;
    expect(afterFirst).toBe(1);

    // Second delivery — same draft key, should be a no-op
    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    const afterSecond = (db.prepare('SELECT COUNT(*) c FROM memories WHERE source = ?').get('owner') as { c: number }).c;
    expect(afterSecond).toBe(1);
  });

  it('source spoof prevention: the file cannot set source=owner manually on an existing block', async () => {
    // The engine fixes source='owner' only for new:<uuid> blocks. An existing
    // block that tries to change source to 'owner' is a read-only field change
    // and gets rejected by the validator.
    const { result } = await service.create({ source: 'chat', content: 'chat fact', scope: 'vault', evidence: EV });
    if (!result.ok) throw new Error('create failed');

    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []);
    const edited = rendered.bytes.replace('source: chat', 'source: owner');
    writeAndIndexNote(edited);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    // Source should still be 'chat'
    const row = db.prepare('SELECT source FROM memories WHERE expired_at IS NULL').get() as { source: string };
    expect(row.source).toBe('chat');
  });

  it('duplicate receipt: DUPLICATE_MEMORY is receipted as duplicate, not retried forever', async () => {
    // Seed an owner memory
    await service.create({ source: 'owner', content: 'same fact', scope: 'vault', evidence: { kind: 'note', node_id: 'n1', hash: 'h1' } });

    const uuid = '770e8400-e29b-41d4-a716-446655440000';
    const draftNote = `
<!-- ve:memory:new:${uuid} revision="new" base="sha256:dummy" -->
~~~~yaml
id: new:${uuid}
status: live
content: same fact
category: fact
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:${uuid} -->
`;
    writeAndIndexNote(draftNote);

    ingest.onFileEvent(NOTE_PATH, 'change');
    await ingest.drain();

    // A duplicate receipt should exist
    const dupReceipts = receipts.findByBlockKey(`mem:new:${uuid}`);
    expect(dupReceipts.some((r) => r.outcome === 'duplicate')).toBe(true);

    // Total memory count should not have increased
    const count = (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
