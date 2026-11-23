import type Database from 'better-sqlite3';
import { isServiceClientId } from './service-client.js';

/**
 * A short, readable name for a client that signed in through the OAuth flow: its id's
 * first eight characters, then the name it registered under in quotes. Registration is
 * open, so the name is whatever the client chose; the id is the part to trust, and it
 * matches the `client_id` in the log line written when access was granted.
 */
export function oauthClientLabel(db: Database.Database, clientId: string): string {
  const label = `client ${clientId.slice(0, 8)}`;
  let name: unknown;
  try {
    const row = db.prepare('SELECT metadata FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | { metadata: string }
      | undefined;
    name = row ? (JSON.parse(row.metadata) as { client_name?: unknown }).client_name : undefined;
  } catch {
    // No oauth tables (stdio) or unreadable metadata: the id alone is the label.
    return label;
  }
  if (typeof name !== 'string') return label;
  const clean = name.replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean ? `${label} "${clean}"` : label;
}

/**
 * The `_meta` key a trusted host sets on a tool call that its chat model chose, with the
 * host's name for that chat as the value (for example "Obsidian chat"). A chat host holds
 * a service token, so without this the Engine cannot tell a call the model chose from one
 * the host's own code made. `@vault/chat-core` exports the same key for hosts.
 */
export const CHAT_MODEL_META_KEY = 'vault-engine/chat-model';

/** Who made a tool call, as far as the chat-client rules care. */
export interface ToolCaller {
  /** The bearer token's client id; undefined without auth (stdio, local HTTP). */
  clientId: string | undefined;
  /** The host's name for its chat, when the host says a chat model chose this call. */
  chatModel: string | undefined;
}

/** Reads the caller from a tool handler's `extra`. */
export function toolCaller(
  extra: { authInfo?: { clientId?: string } | undefined; _meta?: Record<string, unknown> | undefined } | undefined,
): ToolCaller {
  const declared = extra?._meta?.[CHAT_MODEL_META_KEY];
  const chatModel = typeof declared === 'string'
    ? declared.replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';
  return { clientId: extra?.authInfo?.clientId, chatModel: chatModel || undefined };
}

/**
 * The label to record for a caller's edit, or undefined when the caller is the suite
 * itself and nothing is recorded. A chat client is either a client that signed in through
 * the OAuth flow, or a trusted caller (a service token, or no auth) that says its chat
 * model chose the call. Saying so only ever adds rules, so any trusted caller may; a
 * signed-in client is a chat client whatever it says, and its label comes from its token.
 */
export function chatClientEditor(
  caller: ToolCaller | string | undefined,
  label: (clientId: string) => string = (id) => `client ${id.slice(0, 8)}`,
): string | undefined {
  const { clientId, chatModel } = typeof caller === 'object' ? caller : { clientId: caller, chatModel: undefined };
  if (clientId !== undefined && !isServiceClientId(clientId)) return label(clientId);
  if (chatModel === undefined) return undefined;
  return clientId === undefined ? `chat "${chatModel}"` : `chat "${chatModel}" (${clientId})`;
}
