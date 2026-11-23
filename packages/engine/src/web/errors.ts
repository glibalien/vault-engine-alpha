// packages/engine/src/web/errors.ts
/**
 * Error raised inside the web module whose `errorCode` maps 1:1 onto the MCP
 * ErrorCode union. INVALID_PARAMS = the caller gave a bad or disallowed input
 * (malformed/non-http(s)/private-host URL, empty query); UPSTREAM_ERROR = the
 * remote service failed (non-2xx, network error, timeout).
 */
export class WebError extends Error {
  constructor(
    public readonly errorCode: 'INVALID_PARAMS' | 'UPSTREAM_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'WebError';
  }
}
