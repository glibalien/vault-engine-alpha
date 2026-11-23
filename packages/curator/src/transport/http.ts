import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { VaultOAuthProvider } from '../auth/provider.js';
import { DEFAULT_SCOPES } from '../auth/scopes.js';
import { authFailureReason, clientIp } from './auth-log.js';

export type ServerFactory = () => McpServer;

export interface AuthConfig {
  db: Database.Database;
  ownerPassword: string;
  issuerUrl: URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMcpRequestLabel(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;

  const method = body.method;
  if (typeof method !== 'string') return undefined;

  if (method !== 'tools/call') return `MCP ${logLabel(method)}`;

  const params = body.params;
  if (!isRecord(params) || typeof params.name !== 'string') {
    return 'MCP tools/call';
  }

  return `MCP tools/call:${logLabel(params.name)}`;
}

/**
 * A method or tool name as it may appear in the request log. Both come from the request
 * body, so a caller chooses them: anything but name characters becomes `?`, and the length
 * is capped, so a request cannot add lines to the log or bury the real one.
 */
function logLabel(name: string): string {
  return name.slice(0, 64).replace(/[^A-Za-z0-9_./:-]/g, '?');
}

export function describeMcpRequestBody(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    const labels = body
      .map(item => getMcpRequestLabel(item))
      .filter((label): label is string => label !== undefined);

    if (labels.length === 0) return undefined;

    const visibleLabels = labels.slice(0, 5);
    const suffix = labels.length > visibleLabels.length ? ` +${labels.length - visibleLabels.length}` : '';
    return `MCP batch[${visibleLabels.join(', ')}${suffix}]`;
  }

  return getMcpRequestLabel(body);
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  // Capture the path now, not inside 'finish'. Express rewrites req.url to the
  // route-relative remainder while mounted middleware runs, so every handler that ends
  // the response itself (the auth router's endpoints, the /mcp bearer rejection) would
  // log a bare '/'. originalUrl is never rewritten; the split drops the query string,
  // which must stay out of the log because it carries auth codes.
  const path = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    const duration = Date.now() - start;
    const mcpRequest = path === '/mcp' ? describeMcpRequestBody(req.body) : undefined;
    const detail = mcpRequest ? ` ${mcpRequest}` : '';
    const failure = authFailureReason(res);
    const attribution = failure ? ` auth-fail=${failure} ip=${clientIp(req)}` : '';
    process.stderr.write(`[vault-curator] ${req.method} ${path}${detail} ${res.statusCode} ${duration}ms${attribution}\n`);
  });
  next();
}

/**
 * CORS middleware for browser-based MCP clients.
 *
 * The MCP 2025-06-18 spec permits clients to run in the browser. Without these
 * headers:
 *   - OPTIONS preflight gets 401'd by bearerAuth and never sees Allow-* headers.
 *   - Even when the actual POST succeeds, the WWW-Authenticate header on a 401
 *     response is not accessible to client JS (it's not a "simple response
 *     header" and CORS hides non-exposed headers), so the client can't read
 *     the resource_metadata URL and can't start OAuth discovery.
 *
 * Exposing WWW-Authenticate, Mcp-Session-Id, and MCP-Protocol-Version lets the
 * client see what it needs; short-circuiting OPTIONS ensures preflight succeeds
 * before any auth middleware runs.
 */
function corsHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * A client that never sends DELETE would otherwise keep its session's McpServer in memory
 * until restart. A session unused this long is closed; its id then gets 404, as after a restart.
 */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** Past this many sessions, a new one closes the least recently used idle one. */
const MAX_SESSIONS = 1000;
const SESSION_SWEEP_MS = 5 * 60 * 1000;

/** Seams for tests. Production uses the defaults above. */
export interface HttpAppOptions {
  sessionIdleMs?: number;
  maxSessions?: number;
  now?: () => number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  clientId: string | undefined;
  /** When a request last started or finished using the session. */
  lastUsed: number;
  /** Requests whose handler has not settled or whose response is still open (an SSE stream). */
  inFlight: number;
}

/**
 * The session a request may use: the one with this id, and only for the client that
 * opened it. Another client's session reads as missing, so a session id alone is never
 * enough to drive, watch or close someone else's session.
 */
function sessionFor(sessions: Map<string, Session>, sessionId: string, req: Request): Session | undefined {
  const session = sessions.get(sessionId);
  return session && session.clientId === req.auth?.clientId ? session : undefined;
}

export function createHttpApp(serverFactory: ServerFactory, authConfig?: AuthConfig, options: HttpAppOptions = {}): Express {
  const sessions = new Map<string, Session>();
  const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const now = options.now ?? Date.now;

  /** Forgets a session and closes its transport; a failed close is dropped, never thrown. */
  function evict(id: string, session: Session): void {
    sessions.delete(id);
    Promise.resolve().then(() => session.transport.close()).catch(() => {});
  }

  /** Makes room for one more session by closing the least recently used idle ones. */
  function makeRoom(): void {
    while (sessions.size >= maxSessions) {
      let oldest: [string, Session] | undefined;
      for (const entry of sessions) {
        if (entry[1].inFlight === 0 && (!oldest || entry[1].lastUsed < oldest[1].lastUsed)) oldest = entry;
      }
      // Every session is busy: admit the new one rather than refuse a working client.
      if (!oldest) return;
      evict(oldest[0], oldest[1]);
    }
  }

  setInterval(() => {
    const cutoff = now() - sessionIdleMs;
    for (const [id, session] of sessions) {
      if (session.inFlight === 0 && session.lastUsed < cutoff) evict(id, session);
    }
  }, SESSION_SWEEP_MS).unref();

  /** Runs a request on a session, counted in flight until its handler settles and its response closes. */
  async function inUse(session: Session, res: Response, handle: () => Promise<void>): Promise<void> {
    session.inFlight++;
    session.lastUsed = now();
    let pending = 2;
    const release = (): void => {
      if (--pending > 0) return;
      session.inFlight--;
      session.lastUsed = now();
    };
    if (res.closed) release();
    else res.once('close', release);
    try {
      await handle();
    } finally {
      release();
    }
  }

  const app = express();
  app.set('trust proxy', 1);

  // CORS must run before auth so OPTIONS preflight isn't 401'd, and before the
  // body parsers so they don't try to parse an empty preflight body.
  app.use(corsHeaders);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(requestLogger);

  // Set up OAuth if auth config provided
  let bearerAuth: RequestHandler = (_req, _res, next) => { next(); };

  if (authConfig) {
    const provider = new VaultOAuthProvider(authConfig.db, authConfig.ownerPassword);

    // Resource server URL = full MCP endpoint path. Per RFC 9728 §3.1/3.2 and
    // MCP 2025-06-18 §3.1.2:
    //   (a) protected-resource metadata lives at
    //       /.well-known/oauth-protected-resource<path>, and
    //   (b) `resource` field in the metadata equals the URL the client
    //       requested.
    // The 2025-11-25 claude.ai client (dumped headers confirm clientInfo name
    // "Anthropic/ClaudeAI", protocolVersion 2025-11-25) requires this and
    // silently gives up on the OAuth flow without it.
    const resourceServerUrl = new URL('/mcp', authConfig.issuerUrl);
    const legacyResourceServerUrl = new URL('/', authConfig.issuerUrl);
    const protectedResourceMetadata = {
      resource: legacyResourceServerUrl.href,
      authorization_servers: [authConfig.issuerUrl.href],
    };

    app.use(mcpAuthRouter({
      provider,
      issuerUrl: authConfig.issuerUrl,
      resourceServerUrl,
      // Advertise the curator's scopes in OAuth discovery metadata so
      // well-behaved clients request them during authorization.
      scopesSupported: [...DEFAULT_SCOPES],
      authorizationOptions: {
        rateLimit: { windowMs: 60_000, max: 5 },
      },
    }));

    // Compatibility endpoint for clients that still probe the pre-RFC-9728 root
    // metadata URL instead of using the path-specific URL from WWW-Authenticate.
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.json(protectedResourceMetadata);
    });

    bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', authConfig.issuerUrl).toString(),
    });
  }

  // Conditional auth middleware for /mcp: HEAD and sessionless GET (protocol discovery) need no token
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    // HEAD is answered here, not by a route, so it never reaches the GET handler (and a
    // session) whatever order the routes are in.
    if (req.method === 'HEAD' && req.path === '/') {
      res.set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
      res.status(200).end();
      return;
    }
    if (req.method === 'GET' && !req.headers['mcp-session-id']) return next();
    bearerAuth(req, res, next);
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const session = sessionFor(sessions, sessionId, req);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await inUse(session, res, () => session.transport.handleRequest(req, res, req.body));
      return;
    }

    // No session ID — create new McpServer + transport for this session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        makeRoom();
        sessions.set(id, session);
      },
    });
    // Counted in flight from the initialize request on, so making room never closes it.
    const session: Session = { transport, clientId: req.auth?.clientId, lastUsed: now(), inFlight: 0 };

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    try {
      const server = serverFactory();
      await server.connect(transport);
      await inUse(session, res, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      await transport.close().catch(() => {});
      process.stderr.write(`[vault-curator] HTTP error: ${err instanceof Error ? err.message : err}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
      res.status(200).end();
      return;
    }
    const session = sessionFor(sessions, sessionId, req);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await inUse(session, res, () => session.transport.handleRequest(req, res));
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const session = sessionFor(sessions, sessionId, req);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    sessions.delete(sessionId);
    await inUse(session, res, () => session.transport.handleRequest(req, res));
    await session.transport.close().catch(() => {});
  });

  // Express's own last-resort handler answers with a stack trace unless NODE_ENV is
  // production. Answer every unhandled error, body-parser's included, with its status and
  // nothing about the server.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const claimed = isRecord(err) && typeof err.status === 'number' ? err.status : 500;
    const status = claimed >= 400 && claimed < 600 ? claimed : 500;
    const error = status === 413 ? 'Request body too large' : status < 500 ? 'Bad request' : 'Internal server error';
    res.status(status).json({ error });
  });

  return app;
}

export async function startHttpTransport(
  serverFactory: ServerFactory,
  port: number,
  authConfig?: AuthConfig,
): Promise<{ app: Express; httpServer: Server }> {
  const app = createHttpApp(serverFactory, authConfig);

  return new Promise((resolve) => {
    const httpServer = createNodeHttpServer(app);
    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[vault-curator] HTTP listening on http://localhost:${port}/mcp\n`);
      resolve({ app, httpServer });
    });
  });
}
