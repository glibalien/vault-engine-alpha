import type Database from 'better-sqlite3';

export type CaptureDestinationKind = 'created' | 'appended';

export interface ConversationCaptureLedgerRow {
  conversation_id: string;
  input_hash: string;
  processed_at: string;
  outcome: string;
  artifact_count: number;
  destination_count: number;
  decision_evidence_hash: string | null;
  decision_evidence_version: number | null;
}

type LegacyConversationCaptureLedgerRow = Omit<ConversationCaptureLedgerRow, 'decision_evidence_hash' | 'decision_evidence_version'>;

export interface ConversationCaptureArtifactRow {
  capture_id: string;
  conversation_id: string;
  input_hash: string;
  destination_kind: CaptureDestinationKind;
  destination_node_id: string;
  content_hash: string;
  content_markdown: string;
  committed_at: string;
}

export function createConversationCaptureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE conversation_capture_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sweep_at TEXT
    );
    CREATE TABLE conversation_capture_ledger (
      conversation_id TEXT PRIMARY KEY,
      input_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      artifact_count INTEGER NOT NULL,
      destination_count INTEGER NOT NULL
    );
    CREATE TABLE conversation_capture_artifacts (
      capture_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('created', 'appended')),
      destination_node_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_markdown TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );
    CREATE INDEX idx_conversation_capture_artifacts_conversation
      ON conversation_capture_artifacts(conversation_id);
  `);
}

export function lastConversationCaptureAt(db: Database.Database): string | null {
  const row = db.prepare(`
    SELECT last_sweep_at FROM conversation_capture_state WHERE id = 1
  `).get() as { last_sweep_at: string | null } | undefined;
  return row?.last_sweep_at ?? null;
}

export function setLastConversationCaptureAt(db: Database.Database, ts: string): void {
  db.prepare(`
    INSERT INTO conversation_capture_state (id, last_sweep_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_sweep_at = excluded.last_sweep_at
  `).run(ts);
}

export function getConversationCaptureLedger(
  db: Database.Database,
  id: string,
): ConversationCaptureLedgerRow | undefined {
  return db.prepare(`
    SELECT conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count,
      decision_evidence_hash, decision_evidence_version
    FROM conversation_capture_ledger WHERE conversation_id = ?
  `).get(id) as ConversationCaptureLedgerRow | undefined;
}

export function listConversationCaptureLedgerByOutcome(
  db: Database.Database,
  outcome: string,
  limit: number,
  conversationIds?: readonly string[],
): ConversationCaptureLedgerRow[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('ledger revisit limit must be a positive integer');
  if (conversationIds !== undefined) {
    const ids = [...new Set(conversationIds)];
    if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new Error('ledger revisit conversation ids must be non-empty strings');
    }
    if (ids.length === 0) return [];
    const candidates: ConversationCaptureLedgerRow[] = [];
    const parameterChunkSize = 400;
    for (let offset = 0; offset < ids.length; offset += parameterChunkSize) {
      const chunk = ids.slice(offset, offset + parameterChunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      candidates.push(...db.prepare(`
        SELECT conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count,
          decision_evidence_hash, decision_evidence_version
        FROM conversation_capture_ledger
        WHERE outcome = ? AND conversation_id IN (${placeholders})
        ORDER BY processed_at, conversation_id
        LIMIT ?
      `).all(outcome, ...chunk, limit) as ConversationCaptureLedgerRow[]);
      candidates.sort((left, right) => (
        left.processed_at < right.processed_at ? -1
          : left.processed_at > right.processed_at ? 1
            : left.conversation_id < right.conversation_id ? -1
              : left.conversation_id > right.conversation_id ? 1 : 0
      ));
      if (candidates.length > limit) candidates.length = limit;
    }
    return candidates;
  }
  return db.prepare(`
    SELECT conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count,
      decision_evidence_hash, decision_evidence_version
    FROM conversation_capture_ledger
    WHERE outcome = ?
    ORDER BY processed_at, conversation_id
    LIMIT ?
  `).all(outcome, limit) as ConversationCaptureLedgerRow[];
}

export function upsertConversationCaptureLedger(
  db: Database.Database,
  row: ConversationCaptureLedgerRow | LegacyConversationCaptureLedgerRow,
): void {
  const normalized: ConversationCaptureLedgerRow = {
    ...row,
    decision_evidence_hash: 'decision_evidence_hash' in row ? row.decision_evidence_hash : null,
    decision_evidence_version: 'decision_evidence_version' in row ? row.decision_evidence_version : null,
  };
  validateDecisionEvidence(normalized);
  db.prepare(`
    INSERT INTO conversation_capture_ledger (
      conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count,
      decision_evidence_hash, decision_evidence_version
    ) VALUES (@conversation_id, @input_hash, @processed_at, @outcome, @artifact_count, @destination_count,
      @decision_evidence_hash, @decision_evidence_version)
    ON CONFLICT(conversation_id) DO UPDATE SET
      input_hash = excluded.input_hash,
      processed_at = excluded.processed_at,
      outcome = excluded.outcome,
      artifact_count = excluded.artifact_count,
      destination_count = excluded.destination_count,
      decision_evidence_hash = excluded.decision_evidence_hash,
      decision_evidence_version = excluded.decision_evidence_version
  `).run(normalized);
}

function validateDecisionEvidence(row: ConversationCaptureLedgerRow): void {
  const paired = row.decision_evidence_hash !== null && row.decision_evidence_version !== null;
  if (!paired) {
    if (row.decision_evidence_hash !== null || row.decision_evidence_version !== null) {
      throw new Error('decision evidence hash and version must be both null or both set');
    }
    return;
  }
  if (row.outcome !== 'no-fitting-destination') {
    throw new Error('decision evidence is valid only for no-fitting-destination');
  }
  const hash = row.decision_evidence_hash;
  const evidenceVersion = row.decision_evidence_version;
  if (hash === null || evidenceVersion === null) return;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('decision evidence hash must be lowercase SHA-256 hex');
  }
  if (evidenceVersion !== 1) {
    throw new Error('unsupported decision evidence version');
  }
}

export function getConversationCaptureArtifact(
  db: Database.Database,
  captureId: string,
): ConversationCaptureArtifactRow | undefined {
  return db.prepare(`
    SELECT capture_id, conversation_id, input_hash, destination_kind, destination_node_id,
      content_hash, content_markdown, committed_at
    FROM conversation_capture_artifacts WHERE capture_id = ?
  `).get(captureId) as ConversationCaptureArtifactRow | undefined;
}

export function listConversationCaptureArtifacts(
  db: Database.Database,
  conversationId: string,
): ConversationCaptureArtifactRow[] {
  return db.prepare(`
    SELECT capture_id, conversation_id, input_hash, destination_kind, destination_node_id,
      content_hash, content_markdown, committed_at
    FROM conversation_capture_artifacts
    WHERE conversation_id = ?
    ORDER BY committed_at, capture_id
  `).all(conversationId) as ConversationCaptureArtifactRow[];
}

export function upsertConversationCaptureArtifact(
  db: Database.Database,
  row: ConversationCaptureArtifactRow,
): void {
  const write = db.transaction(() => {
    const existing = getConversationCaptureArtifact(db, row.capture_id);
    if (existing === undefined) {
      db.prepare(`
        INSERT INTO conversation_capture_artifacts (
          capture_id, conversation_id, input_hash, destination_kind, destination_node_id,
          content_hash, content_markdown, committed_at
        ) VALUES (@capture_id, @conversation_id, @input_hash, @destination_kind, @destination_node_id,
          @content_hash, @content_markdown, @committed_at)
      `).run(row);
      return;
    }

    const identical = Object.keys(row).every((key) => {
      const field = key as keyof ConversationCaptureArtifactRow;
      return existing[field] === row[field];
    });
    if (!identical) {
      throw new Error(`capture_id ${row.capture_id} invariant violation`);
    }
  });
  write();
}
