// Read/write classification of the engine's MCP tool surface, plus the two
// client-side tools (present-viz, load-vault-tools) that the bench replays
// alongside it. Consumed by classify.ts to derive a TurnClass per recorded
// turn, and by later bench tasks (corpus builder, write interception).
//
// The three sets below are intended to be mutually exclusive and, together
// with 'unknown', exhaustive over the live engine's advertised tools. A
// sandbox tools/list integration test (Task 10) guards against drift.

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'query-nodes',
  'get-node',
  'get-board',
  'get-conversation',
  'get-memory',
  'get-settings',
  'describe-schema',
  'describe-global-field',
  'discover-models',
  'fetch-url',
  'infer-field-type',
  'list-boards',
  'list-conversations',
  'list-field-values',
  'list-global-fields',
  'list-memories',
  'list-memory-near-pairs',
  'list-schemas',
  'list-transcripts',
  'list-undo-history',
  'project-evidence',
  'query-edits-log',
  'query-sync-log',
  'read-embedded',
  'usage-report',
  'validate-node',
  'vault-doctor',
  'vault-stats',
  'web-search',
  // client-side tools
  'present-viz',
  'load-vault-tools',
]);

// Verified to have a no-commit path (dry-run / SAVEPOINT rollback).
export const DRY_RUNNABLE_WRITES: ReadonlySet<string> = new Set([
  'create-node',
  'update-node',
  'delete-node',
  'batch-mutate',
  'update-schema',
]);

// No no-commit path exists for these.
export const UNVALIDATABLE_WRITES: ReadonlySet<string> = new Set([
  'add-model',
  'archive-conversation',
  'archive-source',
  'create-global-field',
  'create-memory',
  'create-schema',
  'delete-board',
  'delete-conversation',
  'delete-global-field',
  'delete-schema',
  'embed-attachment',
  'expire-memory',
  'link-board',
  'link-conversation',
  'materialize-transcript',
  'record-usage',
  'register-prompt-defaults',
  'rename-global-field',
  'save-board',
  'save-conversation',
  'set-conversation-state',
  'undo-operations',
  'update-global-field',
  'update-memory',
  'update-settings',
  'wiki-write',
]);

export type ToolKind = 'read' | 'write-dry-runnable' | 'write-unvalidatable' | 'unknown';

export function toolKind(name: string): ToolKind {
  if (READ_ONLY_TOOLS.has(name)) return 'read';
  if (DRY_RUNNABLE_WRITES.has(name)) return 'write-dry-runnable';
  if (UNVALIDATABLE_WRITES.has(name)) return 'write-unvalidatable';
  return 'unknown';
}
