import { requestUrl } from 'obsidian';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EngineToolInfo } from '@vault/chat-core';
import type { CallFn } from './types.js';

const CLIENT_INFO = { name: 'vault-obsidian', version: '0.1.0' } as const;
const PROTOCOL_VERSION = '2025-06-18';

/** Pure: the auth headers for a bearer token (empty token -> no header). */
export function bearerHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A tool call that may carry MCP request metadata (`_meta`) beside its arguments. */
export type MetaCallFn = (tc: Parameters<CallFn>[0] & { _meta?: Record<string, unknown> }) => ReturnType<CallFn>;

export interface EngineConnection {
  call: MetaCallFn;
  listTools: () => Promise<EngineToolInfo[]>;
  close: () => Promise<void>;
}

/** Network/HTTP failure, distinct from a tool envelope or JSON-RPC error. */
export class EngineTransportError extends Error {
  override name = 'EngineTransportError';
}

interface JsonRpcReply {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Pure: extract JSON-RPC messages from an MCP StreamableHTTP POST response body.
 * The engine replies with a *finite* `text/event-stream` (one `data:` line per
 * message, then the connection closes) — or a plain JSON body. We never need the
 * persistent server→client SSE stream, so a buffered body is sufficient.
 */
export function parseMcpBody(text: string, contentType: string | null): JsonRpcReply[] {
  if (!text || !text.trim()) return [];
  if (contentType && contentType.includes('text/event-stream')) {
    const out: JsonRpcReply[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {
        try { out.push(JSON.parse(data) as JsonRpcReply); } catch { /* skip SSE comments / keep-alives */ }
      }
    }
    return out;
  }
  try { return [JSON.parse(text) as JsonRpcReply]; } catch { return []; }
}

export interface HttpResponse { status: number; headers: Record<string, string>; text: string; }
export type HttpPost = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<HttpResponse>;

/** Default transport: Obsidian's `requestUrl` — runs in the main process, so it
 *  is CORS-free and buffered (never streams). Statically imported so esbuild emits
 *  `require("obsidian")` (the renderer can't resolve a native `import("obsidian")`);
 *  vitest aliases `obsidian` to a stub and callers there inject `post`, so this
 *  default never runs outside Obsidian. */
const requestUrlPost: HttpPost = async ({ url, method, headers, body }) => {
  const res = await requestUrl({ url, method, headers, body: body || undefined, throw: false });
  return { status: res.status, headers: res.headers ?? {}, text: res.text ?? '' };
};

/**
 * Connect to the engine's /mcp endpoint and return a CallFn + listTools + close().
 *
 * Drives MCP StreamableHTTP by hand over Obsidian's `requestUrl` instead of the
 * SDK's `StreamableHTTPClientTransport`: that transport relies on the renderer's
 * `fetch` + a persistent SSE stream, which stalls in Obsidian's Electron renderer
 * (the handshake times out with `-32001`, and the chat loop's tool calls hang
 * ~2min then surface a bogus CORS error — even though the engine sends
 * `Access-Control-Allow-Origin: *` and answers in ms). `requestUrl` is buffered
 * and CORS-free; each MCP message is one POST whose finite SSE body we parse. We
 * skip the server→client SSE stream entirely (not needed for request/response
 * tool calls). `post` is injectable for tests.
 */
export async function connectEngine(
  engineUrl: string,
  token: string,
  post: HttpPost = requestUrlPost,
): Promise<EngineConnection> {
  let sessionId: string | undefined;
  let nextId = 1;

  const send = async (message: Record<string, unknown>): Promise<JsonRpcReply[]> => {
    const headers: Record<string, string> = {
      ...bearerHeaders(token),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
    let res: HttpResponse;
    try {
      res = await post({ url: engineUrl, method: 'POST', headers, body: JSON.stringify(message) });
    } catch (error) {
      throw new EngineTransportError('Engine transport request failed', { cause: error });
    }
    const sid = res.headers['mcp-session-id'] ?? res.headers['Mcp-Session-Id'];
    if (sid) sessionId = sid;
    const contentType = res.headers['content-type'] ?? res.headers['Content-Type'] ?? null;
    const replies = parseMcpBody(res.text, contentType);
    if (res.status >= 400) {
      const errMsg = replies.find((m) => m.error)?.error?.message;
      throw new EngineTransportError(`engine ${String(message.method)}: HTTP ${res.status}${errMsg ? ` — ${errMsg}` : ''}`);
    }
    return replies;
  };

  const rpc = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const replies = await send({ jsonrpc: '2.0', id, method, params });
    const reply = replies.find((m) => m.id === id) ?? replies.find((m) => m.result !== undefined || m.error);
    if (reply?.error) throw new Error(`engine ${method}: ${reply.error.message}`);
    return reply?.result ?? {};
  };

  // Handshake: initialize, then the required initialized notification (no reply).
  await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const call: MetaCallFn = async (tc) =>
    (await rpc('tools/call', {
      name: tc.name, arguments: tc.arguments ?? {}, ...(tc._meta ? { _meta: tc._meta } : {}),
    })) as unknown as CallToolResult;

  const listTools = async (): Promise<EngineToolInfo[]> => {
    const result = await rpc('tools/list', {});
    const tools = (result.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>;
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  };

  const close = async (): Promise<void> => {
    if (!sessionId) return;
    try {
      await post({
        url: engineUrl,
        method: 'DELETE',
        headers: { ...bearerHeaders(token), 'mcp-session-id': sessionId },
        body: '',
      });
    } catch { /* best-effort session teardown */ }
  };

  return { call, listTools, close };
}
