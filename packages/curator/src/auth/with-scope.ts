export interface ScopedExtra {
  authInfo?: { scopes?: string[]; clientId?: string };
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type ToolHandler<A, E extends ScopedExtra = ScopedExtra> = (args: A, extra: E) => Promise<ToolResult> | ToolResult;

/**
 * Wrap a tool handler so it only runs when the verified bearer carries `scope`
 * (read off extra.authInfo.scopes). Missing scope → a FORBIDDEN error result,
 * handler not invoked. Reusable — step 7's curator-status wraps with curate:read.
 */
export function withScope<A, E extends ScopedExtra = ScopedExtra>(scope: string, handler: ToolHandler<A, E>): ToolHandler<A, E> {
  return async (args, extra) => {
    const scopes = extra.authInfo?.scopes ?? [];
    if (!scopes.includes(scope)) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: `missing required scope: ${scope}` } }),
        }],
      };
    }
    return handler(args, extra);
  };
}
