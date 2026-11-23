import type { Request, Response } from 'express';

/**
 * Auth-failure attribution for the HTTP request log.
 *
 * The request log is deliberately IP-free: it records method, path, status and
 * duration so the journal never becomes a record of who connected from where.
 * A failed authentication is the one exception — there the caller's address is
 * the entire point of the line.
 *
 * Most rejections are legible from the status code, but not all: a wrong owner
 * password re-renders the login form as a 200 (see `VaultOAuthProvider.authorize`),
 * which is exactly the request an attacker repeats. Handlers whose failure is
 * invisible to `res.statusCode` mark the response with `markAuthFailure`.
 */
const AUTH_FAILURE_KEY = 'authFailure';

export function markAuthFailure(res: Response, reason: string): void {
  res.locals[AUTH_FAILURE_KEY] = reason;
}

/** The reason this request counts as an auth failure, or undefined if it doesn't. */
export function authFailureReason(res: Response): string | undefined {
  const marked = res.locals?.[AUTH_FAILURE_KEY];
  if (typeof marked === 'string') return marked;

  switch (res.statusCode) {
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    // The SDK's auth router rate-limits /authorize (5 a minute here, where the owner
    // password is tried), /token, /register and /revoke; nothing else in the app does.
    // A 429 is then a throttled auth attempt, where losing the address would be worst.
    // The Engine's /llm/stream also passes an upstream provider's 429 through, which
    // lands here too.
    case 429: return 'rate-limited';
    default: return undefined;
  }
}

/**
 * Best-effort client address.
 *
 * `CF-Connecting-IP` is set by the Cloudflare edge and passed through by
 * cloudflared; it is the true client even when `X-Forwarded-For` carries extra
 * hops. It is trustworthy here only because the HTTP server binds 127.0.0.1 —
 * nothing off-box can reach the origin to forge it. `req.ip` (with the app's
 * `trust proxy` setting) covers direct and non-Cloudflare callers.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded;
  return req.ip ?? 'unknown';
}
