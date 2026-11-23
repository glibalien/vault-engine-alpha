// Corpus builder: extracts every recorded assistant turn from the VEfO chat
// database, paired with the conversation history that preceded it, its
// recorded tool calls, and a TurnClass. This is the replay corpus for the
// model-orchestration benchmark (Tasks 5-9 sample, run, and score against it).
//
// Safety: dbPath is always opened readonly. The production DB
// (/srv/example-vault/.vault-engine/vault.db) is WAL-mode with a live
// engine writing concurrently — a readonly open is safe, a write or a raw
// file copy is not. Never change the `{ readonly: true }` open below.

import Database from 'better-sqlite3';
import type { UIMessage } from 'ai';
import { coerceContext, type ContextState } from '@vault/chat-core';
import { toolKind } from './tools-readwrite.js';
import { classifyTurn, type TurnClass } from './classify.js';

export interface RecordedCall {
  toolName: string;
  state: string;
}

export interface CorpusTurn {
  conversationId: string;
  seq: number; // seq of the assistant message being replayed
  turnClass: TurnClass;
  history: UIMessage[]; // messages[0..seq-1], verbatim parts (tiering re-seeds deferred tools from these)
  recordedCalls: RecordedCall[]; // terminal-state tool calls only
  partial: boolean; // any non-terminal tool part (input-streaming/input-available) → excluded from replay
  unknownTools: string[]; // tools with toolKind 'unknown' (curator connection) → excluded from replay
  modelRef: string | null; // conversation client_state.modelRef via coerceContext
  /** The whole conversation `client_state` parsed through chat-core's own
   *  `coerceContext` — the per-conversation chip state (doc/board toggles,
   *  pinned node ids, persisted board choice) production feeds to
   *  `assembleContext`. Shared by every turn of a conversation; treat as
   *  read-only. `modelRef` above is one field of this same object, kept
   *  separate because the sampler keys on it. */
  contextState: ContextState;
  conversationUpdatedAt: string; // ISO — used as the replay 'now'
}

// Terminal tool-part states. Everything else (input-streaming, input-available,
// approval-requested, approval-responded, ...) is non-terminal → the turn is
// marked partial and the call is excluded from recordedCalls.
const TERMINAL_STATES: ReadonlySet<string> = new Set(['output-available', 'output-error']);

interface RawMessageRow {
  seq: number;
  role: string;
  message_json: string;
}

interface RawConversationRow {
  id: string;
  updated_at: string;
  client_state: string | null;
}

/** A tool part is either the dynamic-tool wrapper (our MCP tools) or a typed
 *  `tool-<name>` part (provider-native tools, e.g. `tool-web_search`). */
function isToolPart(part: { type: string }): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function toolNameOf(part: { type: string; toolName?: unknown }): string {
  if (part.type === 'dynamic-tool') {
    return typeof part.toolName === 'string' ? part.toolName : '';
  }
  return part.type.slice('tool-'.length);
}

function parseMessageJson(conversationId: string, seq: number, raw: string): UIMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `corpus: malformed message_json for conversation_id=${conversationId} seq=${seq}: ${reason}`
    );
  }
  return parsed as UIMessage;
}

function parseClientState(conversationId: string, raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`corpus: malformed client_state for conversation_id=${conversationId}: ${reason}`);
  }
}

export function extractTurns(dbPath: string): CorpusTurn[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const turns: CorpusTurn[] = [];

    const conversations = db
      .prepare('SELECT id, updated_at, client_state FROM conversations')
      .all() as RawConversationRow[];

    const messagesStmt = db.prepare(
      'SELECT seq, role, message_json FROM messages WHERE conversation_id = ? ORDER BY seq'
    );

    for (const conv of conversations) {
      const rows = messagesStmt.all(conv.id) as RawMessageRow[];
      const messages: UIMessage[] = rows.map((row) => parseMessageJson(conv.id, row.seq, row.message_json));

      const clientState = parseClientState(conv.id, conv.client_state);
      const contextState = coerceContext(clientState);
      const modelRef = contextState.modelRef ?? null;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        if (row.role !== 'assistant') continue;

        const message = messages[i];
        const parts: ReadonlyArray<{ type: string; toolName?: unknown; state?: unknown }> = Array.isArray(
          message?.parts
        )
          ? (message.parts as Array<{ type: string; toolName?: unknown; state?: unknown }>)
          : [];

        const recordedCalls: RecordedCall[] = [];
        const unknownTools = new Set<string>();
        let partial = false;

        for (const part of parts) {
          if (!isToolPart(part)) continue;
          const name = toolNameOf(part);
          const state = typeof part.state === 'string' ? part.state : '';
          if (!TERMINAL_STATES.has(state)) {
            partial = true;
            continue; // non-terminal calls are never "recorded"
          }
          recordedCalls.push({ toolName: name, state });
          if (toolKind(name) === 'unknown') unknownTools.add(name);
        }

        turns.push({
          conversationId: conv.id,
          seq: row.seq,
          turnClass: classifyTurn(recordedCalls.map((c) => c.toolName)),
          history: messages.slice(0, i),
          recordedCalls,
          partial,
          unknownTools: [...unknownTools],
          modelRef,
          contextState,
          conversationUpdatedAt: conv.updated_at,
        });
      }
    }

    return turns;
  } finally {
    db.close();
  }
}

export function replayable(t: CorpusTurn): boolean {
  return !t.partial && t.unknownTools.length === 0;
}
