/**
 * Flatten opaque AI-SDK UIMessage blobs into plain conversation text.
 *
 * chat-core owns the message shape, so this module is the single place that
 * knows it — the engine stores `message_json` opaquely (charter) and the
 * curator must never learn the shape itself.
 *
 * Deliberately IMPORTLESS: it is published on the `./transcript` subpath so
 * consumers get it without pulling `dist/index.js`, which re-exports
 * `providers.ts` and would drag `ai` plus three provider SDKs into their
 * runtime.
 *
 * Text parts are an ALLOWLIST, not a blocklist: `dynamic-tool` (the MCP tool
 * part type — note it is NOT `tool-*`), `reasoning`, `step-start`, every
 * `data-*` part, and any type not yet seen are dropped. A part type introduced
 * by a future AI SDK upgrade is therefore excluded by construction rather than
 * silently flowing into an LLM extraction prompt.
 */

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface FlattenedTranscript {
  /** Ordered turns, one per message that contributed at least one text part. */
  turns: TranscriptTurn[];
  /** Total characters of USER text — the sweep's prose floor is measured on this. */
  userChars: number;
  /** Non-text parts discarded. A high count with zero turns signals a shape change. */
  droppedParts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function roleOf(value: unknown): TranscriptTurn['role'] | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

export function flattenTranscript(messages: readonly unknown[]): FlattenedTranscript {
  const turns: TranscriptTurn[] = [];
  let userChars = 0;
  let droppedParts = 0;

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = roleOf(message.role);
    if (role === null) continue;

    const parts: readonly unknown[] = Array.isArray(message.parts) ? message.parts : [];
    const chunks: string[] = [];
    for (const part of parts) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
        const text = part.text.trim();
        if (text !== '') chunks.push(text);
        continue;
      }
      droppedParts += 1;
    }

    if (chunks.length === 0) continue;
    const text = chunks.join('\n\n');
    if (role === 'user') userChars += text.length;
    turns.push({ role, text });
  }

  return { turns, userChars, droppedParts };
}
