import type Database from 'better-sqlite3';

/**
 * DDL for the conversation-sweep idempotency ledger + watermark. Called by
 * migration #9. Mirrors `memory-sweep.ts` but keyed on conversation id — the
 * note ledger's PK is `node_id` and conversations are not nodes, so overloading
 * it with prefixed synthetic keys would make the schema lie.
 *
 * The ledger is the CORRECTNESS guarantee (one row per conversation, latest
 * transcript hash processed); the watermark is only an efficiency filter for
 * the candidate scan.
 */
export function createConversationSweepTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sweep_conversation_ledger (
      conversation_id TEXT PRIMARY KEY,
      transcript_hash TEXT NOT NULL,
      swept_at        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_sweep_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_sweep_at TEXT
    );
  `);
}

export function conversationLedgerHash(db: Database.Database, conversationId: string): string | undefined {
  const row = db.prepare(`SELECT transcript_hash FROM memory_sweep_conversation_ledger WHERE conversation_id = ?`)
    .get(conversationId) as { transcript_hash: string } | undefined;
  return row?.transcript_hash;
}

export function upsertConversationLedger(
  db: Database.Database, conversationId: string, transcriptHash: string, sweptAt: string,
): void {
  db.prepare(`
    INSERT INTO memory_sweep_conversation_ledger (conversation_id, transcript_hash, swept_at) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET transcript_hash = excluded.transcript_hash, swept_at = excluded.swept_at
  `).run(conversationId, transcriptHash, sweptAt);
}

export function lastConversationSweepAt(db: Database.Database): string | null {
  const row = db.prepare(`SELECT last_sweep_at FROM conversation_sweep_state WHERE id = 1`)
    .get() as { last_sweep_at: string | null } | undefined;
  return row?.last_sweep_at ?? null;
}

export function setLastConversationSweepAt(db: Database.Database, ts: string): void {
  db.prepare(`
    INSERT INTO conversation_sweep_state (id, last_sweep_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_sweep_at = excluded.last_sweep_at
  `).run(ts);
}
