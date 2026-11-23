/** The scopes the curator's MCP tools check: every tool is wrapped in withScope (./with-scope.ts). */
export const CURATOR_SCOPES = new Set<string>(['curate:trigger', 'curate:read']);

export const DEFAULT_SCOPES: readonly string[] = ['curate:trigger', 'curate:read'];

/**
 * Parses a `--scope` CSV into a validated, de-duplicated scope list. An
 * undefined/empty input yields the default set. Every parsed scope must be in
 * CURATOR_SCOPES — an unknown scope throws (fail-fast so a typo can't mint a
 * useless token).
 */
export function parseScopes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_SCOPES];
  }
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const scope of parsed) {
    if (!CURATOR_SCOPES.has(scope)) {
      throw new Error(
        `unknown scope "${scope}" — allowed: ${[...CURATOR_SCOPES].join(', ')}`,
      );
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      result.push(scope);
    }
  }
  return result;
}
