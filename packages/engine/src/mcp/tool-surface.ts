import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Which tools one MCP session sees.
 *
 * - `full`: every registered tool. Service-token clients (Curator, the Obsidian
 *   plugin, the installer), stdio, and unauthenticated local HTTP.
 * - `external`: OAuth-flow clients (claude.ai, Claude Code). The suite's own
 *   plumbing, which only those services call from code, is not registered, so
 *   these clients don't load its definitions into model context.
 *
 * This saves context; it is not an authorization boundary. Every client
 * authenticates as the vault owner.
 */
export type ToolSurface = 'full' | 'external';

/** Tools that only the suite's own services call. Hidden from the external surface. */
export const SERVICE_ONLY_TOOL_NAMES: readonly string[] = [
  // Spend ledger and settings bootstrap written by each service for itself.
  'record-usage',
  'register-prompt-defaults',
  // Curator sweeps and the wiki provenance protocol.
  'refresh-memory-note',
  'list-field-guess-candidates',
  'memory-subject-pass',
  'wiki-reconcile',
  'wiki-status',
  'provenance-prepare',
  'provenance-stage-result',
  'provenance-transition',
  // Board persistence for the Obsidian plugin.
  'list-boards',
  'get-board',
  'save-board',
  'delete-board',
  'link-board',
  // Chat conversation persistence for the chat hosts.
  'list-conversations',
  'get-conversation',
  'save-conversation',
  'link-conversation',
  'archive-conversation',
  'delete-conversation',
  'set-conversation-state',
];

/**
 * Run `register` against `server`, then remove the service-only tools when the
 * surface is external. Handles are captured from the public `tool`/`registerTool`
 * return values while `register` runs; the original methods are restored after.
 */
export function registerToolsForSurface(server: McpServer, surface: ToolSurface, register: () => void): void {
  if (surface === 'full') {
    register();
    return;
  }
  const hidden = new Set(SERVICE_ONLY_TOOL_NAMES);
  const handles: RegisteredTool[] = [];
  const { tool, registerTool } = server;
  const capture = (method: (...args: unknown[]) => RegisteredTool) => (...args: unknown[]): RegisteredTool => {
    const handle = method.apply(server, args);
    if (hidden.has(args[0] as string)) handles.push(handle);
    return handle;
  };
  server.tool = capture(tool as (...args: unknown[]) => RegisteredTool) as McpServer['tool'];
  server.registerTool = capture(registerTool as (...args: unknown[]) => RegisteredTool) as McpServer['registerTool'];
  try {
    register();
  } finally {
    server.tool = tool;
    server.registerTool = registerTool;
  }
  for (const handle of handles) handle.remove();
}
