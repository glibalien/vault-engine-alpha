import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Secret } from './secret.js';

export class EngineToolError extends Error {
  override readonly name = 'EngineToolError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Engine refused the token: it expired, was revoked, or belongs to another database. */
export class EngineAuthError extends Error {
  override readonly name = 'EngineAuthError';
}

/** Calls one Engine MCP tool and returns the envelope's data. */
export type EngineCall = <T>(tool: string, args?: Record<string, unknown>, options?: CallOptions) => Promise<T>;

export interface CallOptions {
  /** How long to wait for the result; the MCP SDK's default is one minute. */
  timeoutMs?: number;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

/**
 * An MCP client for Engine's HTTP endpoint with a bearer service token. Each call opens
 * and closes its own session; the installer makes few calls.
 */
export function engineClient(url: string, token: Secret): EngineCall {
  return async <T>(tool: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> => {
    const { text } = await callTool(url, token, 'Engine', tool, args, options);
    const envelope = JSON.parse(text) as Envelope<T>;
    if (!envelope.ok) {
      throw new EngineToolError(envelope.error?.code ?? 'UNKNOWN', `${tool} failed: ${envelope.error?.message ?? 'no message'}`);
    }
    return envelope.data as T;
  };
}

/** Curator's tools answer with their JSON payload itself, not Engine's envelope. */
export function curatorClient(url: string, token: Secret): EngineCall {
  return async <T>(tool: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> => {
    const { text, isError } = await callTool(url, token, 'Curator', tool, args, options);
    if (isError) throw new EngineToolError('TOOL_ERROR', `${tool} failed: ${text}`);
    return JSON.parse(text) as T;
  };
}

async function callTool(
  url: string,
  token: Secret,
  service: string,
  tool: string,
  args: Record<string, unknown>,
  options: CallOptions,
): Promise<{ text: string; isError: boolean }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token.reveal()}` } },
  });
  const client = new Client({ name: 'vault-installer', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
    );
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(item => item.type === 'text')?.text;
    if (!text) throw new EngineToolError('NO_CONTENT', `${tool} returned no text`);
    return { text, isError: result.isError === true };
  } catch (error) {
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new EngineAuthError(`${service} refused the token (HTTP ${error.code}).`);
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}
