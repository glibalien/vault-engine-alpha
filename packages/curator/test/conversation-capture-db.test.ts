import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  getConversationCaptureArtifact,
  getConversationCaptureLedger,
  lastConversationCaptureAt,
  listConversationCaptureArtifacts,
  listConversationCaptureLedgerByOutcome,
  setLastConversationCaptureAt,
  upsertConversationCaptureArtifact,
  upsertConversationCaptureLedger,
  type ConversationCaptureArtifactRow,
  type ConversationCaptureLedgerRow,
} from '../src/db/conversation-capture.js';

function artifact(over: Partial<ConversationCaptureArtifactRow> = {}): ConversationCaptureArtifactRow {
  return {
    capture_id: 'cap1',
    conversation_id: 'c1',
    input_hash: 'input1',
    destination_kind: 'created',
    destination_node_id: 'node1',
    content_hash: 'content1',
    content_markdown: '<!-- start -->\nA',
    committed_at: '2026-08-25T12:00:00.000Z',
    ...over,
  };
}

function ledger(over: Partial<ConversationCaptureLedgerRow> = {}): ConversationCaptureLedgerRow {
  return {
    conversation_id: 'c1',
    input_hash: 'input1',
    processed_at: '2026-08-25T12:00:00.000Z',
    outcome: 'captured',
    artifact_count: 1,
    destination_count: 1,
    decision_evidence_hash: null,
    decision_evidence_version: null,
    ...over,
  };
}

describe('conversation capture persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('creates all capture tables and the conversation artifact index', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'conversation_capture_state', 'conversation_capture_ledger', 'conversation_capture_artifacts'
      )
    `).all();
    expect(tables).toHaveLength(3);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_conversation_capture_artifacts_conversation'
    `).all()).toHaveLength(1);
  });

  it('stores exact stamped Markdown and upserts idempotently', () => {
    const row = artifact({ content_markdown: '<!-- start -->\nA' });
    upsertConversationCaptureArtifact(db, row);
    upsertConversationCaptureArtifact(db, row);

    expect(listConversationCaptureArtifacts(db, 'c1')).toHaveLength(1);
    expect(getConversationCaptureArtifact(db, 'cap1')?.content_markdown).toBe('<!-- start -->\nA');
  });

  it('rejects a same-ID artifact with a different identity, content, or destination', () => {
    upsertConversationCaptureArtifact(db, artifact());

    expect(() => upsertConversationCaptureArtifact(db, artifact({ conversation_id: 'c2' })))
      .toThrow(/capture_id.*invariant/i);
    expect(() => upsertConversationCaptureArtifact(db, artifact({ content_hash: 'content2' })))
      .toThrow(/capture_id.*invariant/i);
    expect(() => upsertConversationCaptureArtifact(db, artifact({ destination_node_id: 'node2' })))
      .toThrow(/capture_id.*invariant/i);
    expect(getConversationCaptureArtifact(db, 'cap1')).toEqual(artifact());
  });

  it('upserts the ledger and capture watermark with caller-supplied timestamps', () => {
    expect(getConversationCaptureLedger(db, 'c1')).toBeUndefined();
    upsertConversationCaptureLedger(db, ledger());
    upsertConversationCaptureLedger(db, ledger({ input_hash: 'input2', outcome: 'skipped', processed_at: '2026-08-25T13:00:00.000Z' }));
    expect(getConversationCaptureLedger(db, 'c1')).toEqual(ledger({ input_hash: 'input2', outcome: 'skipped', processed_at: '2026-08-25T13:00:00.000Z' }));

    expect(lastConversationCaptureAt(db)).toBeNull();
    setLastConversationCaptureAt(db, '2026-08-25T14:00:00.000Z');
    expect(lastConversationCaptureAt(db)).toBe('2026-08-25T14:00:00.000Z');
    setLastConversationCaptureAt(db, '2026-08-25T15:00:00.000Z');
    expect(lastConversationCaptureAt(db)).toBe('2026-08-25T15:00:00.000Z');
  });

  it('lists only artifacts belonging to the requested conversation', () => {
    upsertConversationCaptureArtifact(db, artifact());
    upsertConversationCaptureArtifact(db, artifact({ capture_id: 'cap2', conversation_id: 'c2' }));
    expect(listConversationCaptureArtifacts(db, 'c1')).toEqual([artifact()]);
  });

  it('round-trips decision evidence for a no-fitting-destination outcome', () => {
    const digest = 'a'.repeat(64);
    const row = ledger({ outcome: 'no-fitting-destination', decision_evidence_hash: digest, decision_evidence_version: 1 });
    upsertConversationCaptureLedger(db, row);
    expect(getConversationCaptureLedger(db, 'c1')).toEqual(row);
  });

  it('round-trips null decision evidence for other outcomes', () => {
    const row = ledger({ outcome: 'captured' });
    upsertConversationCaptureLedger(db, row);
    expect(getConversationCaptureLedger(db, 'c1')).toEqual(row);
  });

  it.each([
    ['hash-only', { decision_evidence_hash: 'a'.repeat(64), decision_evidence_version: null }],
    ['version-only', { decision_evidence_hash: null, decision_evidence_version: 1 }],
  ])('rejects a %s decision evidence pair before SQL', (_name, evidence) => {
    expect(() => upsertConversationCaptureLedger(db, ledger({ outcome: 'no-fitting-destination', ...evidence }))).toThrow(/both null or both set/);
    expect(getConversationCaptureLedger(db, 'c1')).toBeUndefined();
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])('rejects malformed decision evidence hash before SQL', (hash) => {
    expect(() => upsertConversationCaptureLedger(db, ledger({ outcome: 'no-fitting-destination', decision_evidence_hash: hash, decision_evidence_version: 1 }))).toThrow(/lowercase SHA-256 hex/);
    expect(getConversationCaptureLedger(db, 'c1')).toBeUndefined();
  });

  it.each([0, -1, 1.5, 2])('rejects unsupported decision evidence version %s before SQL', (version) => {
    expect(() => upsertConversationCaptureLedger(db, ledger({ outcome: 'no-fitting-destination', decision_evidence_hash: 'a'.repeat(64), decision_evidence_version: version }))).toThrow(/unsupported decision evidence version/);
    expect(getConversationCaptureLedger(db, 'c1')).toBeUndefined();
  });

  it('rejects decision evidence for outcomes other than no-fitting-destination before SQL', () => {
    expect(() => upsertConversationCaptureLedger(db, ledger({ outcome: 'captured', decision_evidence_hash: 'a'.repeat(64), decision_evidence_version: 1 }))).toThrow(/valid only for no-fitting-destination/);
    expect(getConversationCaptureLedger(db, 'c1')).toBeUndefined();
  });

  it('lists a bounded oldest-first protected-only revisit ledger', () => {
    upsertConversationCaptureLedger(db, ledger({ conversation_id: 'newer', outcome: 'protected-only', processed_at: '2026-08-25T15:00:00.000Z' }));
    upsertConversationCaptureLedger(db, ledger({ conversation_id: 'other', outcome: 'captured', processed_at: '2026-08-25T10:00:00.000Z' }));
    upsertConversationCaptureLedger(db, ledger({ conversation_id: 'older', outcome: 'protected-only', processed_at: '2026-08-25T11:00:00.000Z' }));

    expect(listConversationCaptureLedgerByOutcome(db, 'protected-only', 1))
      .toEqual([expect.objectContaining({ conversation_id: 'older' })]);
    expect(listConversationCaptureLedgerByOutcome(db, 'protected-only', 1, ['newer']))
      .toEqual([expect.objectContaining({ conversation_id: 'newer' })]);
    expect(listConversationCaptureLedgerByOutcome(db, 'protected-only', 10, []))
      .toEqual([]);
    expect(() => listConversationCaptureLedgerByOutcome(db, 'protected-only', 0)).toThrow(/positive integer/);
  });
});
