import type Database from 'better-sqlite3';
import { createOperation } from './operation.js';

/** TTL after which an idle client session is treated as finished. Must be >= the
 *  client's idle-finalize window (120s) so the engine never evicts a session the
 *  client still treats as active. */
const SESSION_TTL_MS = 5 * 60_000;

interface SessionEntry { operationId: string; lastWriteTs: number; }

/**
 * Maps a client-generated edit_session_id to a single undo operation_id so the N
 * autosaves of one editing session coalesce into one undo entry. In-memory in the
 * long-lived MCP process. On engine restart the map is lost, so a mid-session
 * client mints a fresh operation_id on its next write — one extra undo entry,
 * never data loss.
 */
export class EditSessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  /** Find-or-create the operation_id for a session. A session idle longer than
   *  ttlMs is treated as finished and a fresh operation_id is minted. Also
   *  re-mints if the cached op row was deleted by the orphan sweep while the
   *  session was still alive (prevents FK violations on the next autosave). */
  resolve(db: Database.Database, sessionId: string, makeDescription: () => string, now: number): string {
    const existing = this.sessions.get(sessionId);
    if (existing && now - existing.lastWriteTs <= this.ttlMs && this.operationExists(db, existing.operationId)) {
      existing.lastWriteTs = now;
      return existing.operationId;
    }
    const operationId = createOperation(db, { source_tool: 'update-node', description: makeDescription() });
    this.sessions.set(sessionId, { operationId, lastWriteTs: now });
    return operationId;
  }

  private operationExists(db: Database.Database, operationId: string): boolean {
    return db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get(operationId) !== undefined;
  }

  /** Drop sessions idle longer than ttlMs (bounds memory). */
  sweepExpired(now: number): void {
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastWriteTs > this.ttlMs) this.sessions.delete(id);
    }
  }

  size(): number { return this.sessions.size; }

  /** Start a periodic sweep (effectful; mirrors startUndoCleanup). */
  startSweep(intervalMs = 60 * 60 * 1000): { stop: () => void } {
    const handle = setInterval(() => this.sweepExpired(Date.now()), intervalMs);
    return { stop: () => clearInterval(handle) };
  }
}

/** Process-wide singleton used by update-node in production. Tests build their own. */
export const editSessions = new EditSessionRegistry();
