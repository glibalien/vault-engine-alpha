import { HomeRefreshError, HomeRefreshNotSentError, type HomeRefreshApi, type HomeRefreshPreview, type HomeRefreshStatus } from '@vault/query-core';
import { connectEngine, EngineTransportError, type EngineConnection } from '../engine/transport.js';

export function normalizedCuratorEndpoint(raw: string): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw Error('Invalid Curator endpoint');
  return url.href.replace(/\/$/, '');
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const phases = new Set(['queued', 'preparing', 'dispatch_intent', 'stage_pending', 'publishing', 'awaiting_recovery', 'committed', 'conflict', 'failed', 'uncertain']);
function previewData(data: unknown): HomeRefreshPreview {
  if (!object(data) || typeof data.eligible !== 'boolean' || !Array.isArray(data.reasons) || !Array.isArray(data.sections)
    || !data.sections.every(x => typeof x === 'string')
    || !data.reasons.every(x => object(x) && typeof x.code === 'string' && typeof x.message === 'string')
    || (data.target_kind !== 'home' && data.target_kind !== 'page')
    || !['project_title', 'home_title', 'home_path', 'page_title', 'page_path'].every(k => data[k] === null || typeof data[k] === 'string')
    || (data.eligible && (!object(data.guard) || data.guard.version !== 1
      || !['vault_namespace', 'project_id', 'home_node_id', 'output_revision_id', 'topology_hash', 'configuration_digest', 'corrections_digest'].every(k => typeof (data.guard as Record<string, unknown>)[k] === 'string')
      || !Number.isInteger(data.guard.home_version) || !object(data.model)
      || (data.target_kind === 'page' && (typeof data.guard.page_node_id !== 'string' || !Number.isInteger(data.guard.page_version)))
      || typeof data.model.ref !== 'string' || typeof data.model.provider !== 'string' || !Number.isInteger(data.model.max_output_tokens))))
    throw Error('Invalid refresh preview');
  return data as unknown as HomeRefreshPreview;
}
function statusData(data: unknown): HomeRefreshStatus {
  if (!object(data) || !['request_id', 'phase', 'message', 'created_at', 'updated_at', 'replaces_output_revision_id'].every(k => typeof data[k] === 'string')
    || !phases.has(String(data.phase))
    || (data.output !== null && (!object(data.output) || typeof data.output.output_revision_id !== 'string' || typeof data.output.output_node_id !== 'string'))
    || (data.usage !== null && (!object(data.usage) || !['input', 'output', 'cacheWrite', 'cacheRead'].every(k => typeof (data.usage as Record<string, unknown>)[k] === 'number'))))
    throw Error('Invalid refresh status');
  return data as unknown as HomeRefreshStatus;
}
/** Lazy Curator-only transport; no paid retries or credential-bearing payloads. */
export function makeHomeRefreshClient(input: { endpoint: string; token: string;
  connect?: typeof connectEngine }): { api: HomeRefreshApi; close(): Promise<void> } {
  let connection: EngineConnection | null = null;
  let connecting: Promise<EngineConnection> | null = null;
  let closed = false;
  const connect = async () => {
    if (closed) throw Error('Refresh connection closed');
    if (!input.token?.trim()) throw Error('Configure a Curator token with curate:read and curate:trigger.');
    if (connection) return connection;
    connecting ??= (async () => {
      const conn = await (input.connect ?? connectEngine)(normalizedCuratorEndpoint(input.endpoint), input.token);
      try {
        const names = new Set((await conn.listTools()).map(t => t.name));
        if (closed) throw Error('Refresh connection closed');
        if (!['preview-wiki-refresh', 'refresh-wiki-page', 'wiki-refresh-status'].every(n => names.has(n)))
          throw Error('Update Curator to enable rebuilding a single page.');
        connection = conn; return conn;
      } catch (error) { await conn.close().catch(() => {}); throw error; }
    })().finally(() => { connecting = null; });
    return connecting;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    let conn: EngineConnection;
    try {
      conn = await connect();
      if (closed) throw Error('Refresh connection closed');
    } catch (cause) {
      if (name === 'refresh-wiki-page') throw new HomeRefreshNotSentError();
      throw cause;
    }
    // Beyond this boundary a thrown error or malformed reply is ambiguous.
    let result: Awaited<ReturnType<EngineConnection['call']>>;
    try {
      result = await conn.call({ name, arguments: args });
    } catch (error) {
      // Invalidate only the session that failed. A late failure from an older
      // request must not clear or close a connection established by a retry.
      if (error instanceof EngineTransportError && connection === conn) {
        connection = null;
        void conn.close().catch(() => {});
      }
      throw error;
    }
    const block = result.content.find(c => c.type === 'text');
    let envelope: unknown;
    try { envelope = block?.type === 'text' ? JSON.parse(block.text) : null; } catch { throw Error('Invalid refresh response'); }
    if (object(envelope) && envelope.ok === false && object(envelope.error)
      && typeof envelope.error.code === 'string' && /^[A-Z_]{1,64}$/.test(envelope.error.code))
      throw new HomeRefreshError(envelope.error.code);
    if (result.isError || !object(envelope) || envelope.ok !== true) throw Error('Invalid refresh response');
    return envelope.data;
  };
  return { api: {
    preview: async outputRevisionId => previewData(await call('preview-wiki-refresh', { output_revision_id: outputRevisionId })),
    execute: async request => statusData(await call('refresh-wiki-page', request)),
    status: async requestId => statusData(await call('wiki-refresh-status', { request_id: requestId })),
  }, close: async () => { closed = true; const conn = connection; connection = null; await conn?.close().catch(() => {}); } };
}
