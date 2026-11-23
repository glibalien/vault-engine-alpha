import type { Request, Response } from 'express';
import { MODEL_PROVIDERS, providerHost } from '@vault/settings-registry';

export interface LlmStreamDeps {
  /** Injectable for tests; defaults to the global fetch (undici in Node). */
  fetchImpl?: typeof fetch;
  /** Upstream hosts this relay may forward to. */
  allowedHosts?: string[];
  /** Injectable for tests; defaults to UPSTREAM_INACTIVITY_MS. */
  inactivityMs?: number;
}

/**
 * How long the upstream may send nothing, neither its response headers nor a chunk, before the
 * relay gives up on it. Long on purpose: a slow model that is still working must never be cut.
 */
const UPSTREAM_INACTIVITY_MS = 10 * 60 * 1000;

/**
 * Transparent streaming proxy to an allowlisted LLM upstream.
 *
 * This is a TRANSPORT, not an LLM feature: the engine never composes prompts or
 * generates text. It forwards the plugin's verbatim request `{ url, headers, body }`
 * to an allowlisted host and pipes the response bytes straight back as they arrive,
 * so Obsidian's Electron renderer (where `requestUrl` is buffered-only) can stream
 * tokens via the engine. The upstream key rides in the forwarded `headers` and is
 * never stored. The upstream status + error body are propagated verbatim so the AI
 * SDK throws a meaningful error instead of going silent on a bad key/request.
 */
export function createLlmStreamHandler(deps: LlmStreamDeps = {}): (req: Request, res: Response) => Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // Default: the API host of every catalog model provider.
  const allowed = new Set(deps.allowedHosts ?? MODEL_PROVIDERS.map(providerHost));
  const inactivityMs = deps.inactivityMs ?? UPSTREAM_INACTIVITY_MS;

  return async (req: Request, res: Response): Promise<void> => {
    const envelope = (req.body ?? {}) as { url?: unknown; headers?: unknown; body?: unknown };
    if (typeof envelope.url !== 'string') {
      res.status(400).json({ error: 'url required' });
      return;
    }
    let target: URL;
    try {
      target = new URL(envelope.url);
    } catch {
      res.status(400).json({ error: 'invalid url' });
      return;
    }
    if (!allowed.has(target.host)) {
      res.status(403).json({ error: 'host not allowed' });
      return;
    }
    if (target.protocol !== 'https:') {
      res.status(403).json({ error: 'https required' });
      return;
    }

    const controller = new AbortController();
    // Wire the abort BEFORE the await so a disconnect during connect still aborts.
    res.on('close', () => controller.abort());

    // One inactivity timer: armed for the wait for headers, re-armed before every read.
    let timedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        // A pending read ends at once (done) instead of waiting on a body that ignores the abort.
        reader?.cancel().catch(() => {});
      }, inactivityMs);
    };

    try {
      arm();
      // `globalThis.Response` (WHATWG fetch), not Express's `Response` imported above.
      let upstream: globalThis.Response;
      try {
        upstream = await fetchImpl(envelope.url, {
          method: 'POST',
          headers: (envelope.headers ?? {}) as Record<string, string>,
          body: typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body ?? {}),
          // The allowlist covers the host that was asked for. A redirect would lead somewhere it
          // never checked, so a redirect is an error.
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (err) {
        if (!res.headersSent) {
          if (timedOut) res.status(504).json({ error: 'upstream timed out' });
          else res.status(502).json({ error: `upstream fetch failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      // Defeat any intermediary buffering so chunks reach the client as they arrive.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (!upstream.body) {
        res.end();
        return;
      }
      reader = upstream.body.getReader();
      try {
        for (;;) {
          arm();
          const { done, value } = await reader.read();
          if (done) break;
          // res.write's boolean return (backpressure signal) is intentionally ignored:
          // the loop is already paced by `await reader.read()` — upstream token production
          // limits throughput to one chunk at a time, so we can't outrun the socket.
          if (value) res.write(Buffer.from(value));
        }
      } catch {
        // client aborted, upstream errored or went silent mid-stream — fall through to end()
      } finally {
        res.end();
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
