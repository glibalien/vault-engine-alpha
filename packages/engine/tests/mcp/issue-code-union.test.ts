import { describe, it, expect } from 'vitest';
import type { IssueCode } from '../../src/mcp/tools/errors.js';

// Compile-time exhaustiveness pin: every variant of IssueCode must
// appear as a key in this map. If a future PR adds a code to the
// union, TS will flag the missing key here. If a code is removed
// from the union but left in the map, TS flags an unknown key.
//
// The Record<IssueCode, true> type IS the test. The runtime assertion
// below just keeps Vitest from skipping the file as empty.
const ALL_ISSUE_CODES: Record<IssueCode, true> = {
  // ValidationIssueCode subset
  REQUIRED_MISSING: true,
  ENUM_MISMATCH: true,
  TYPE_MISMATCH: true,
  COERCION_FAILED: true,
  LIST_ITEM_COERCION_FAILED: true,
  MERGE_CONFLICT: true,
  INTERNAL_CONSISTENCY: true,
  TYPE_KEY_FIELD: true,
  // ToolIssueCode subset
  TITLE_WIKILINK_UNSAFE: true,
  FRONTMATTER_IN_BODY: true,
  TYPE_OP_CONFLICT: true,
  TITLE_FILENAME_SANITIZED: true,
  UNPRICED_MODELS: true,
  // Tool-only warning codes (errors.ts)
  CHANGED_SINCE_UNPARSEABLE: true,
  CROSS_NODE_FILTER_UNRESOLVED: true,
  DEPRECATED_PARAM: true,
  EMBEDDINGS_UNVERIFIED: true,
  FIELD_OPERATOR_MISMATCH: true,
  FIELD_PRESENCE_BACKFILL_PENDING: true,
  FTS_QUERY_INVALID: true,
  LAST_TYPE_REMOVAL: true,
  MEMORY_CONSOLIDATION_FAILED: true,
  MEMORY_DEDUP_DEGRADED: true,
  MEMORY_SUBJECT_UNRESOLVED: true,
  PENDING_REFERENCES: true,
  SCHEMA_FILE_RENDER_BLOCKED: true,
  SEMANTIC_SEARCH_UNAVAILABLE: true,
  REFERENCE_AMBIGUOUS: true,
  REFERENCE_TARGET_TYPE_MISMATCH: true,
  REFERENCE_RESOLUTION_STALE: true,
  RESULT_TRUNCATED: true,
  TEXT_BUDGET_EXCEEDED: true,
  UNDO_FILE_KEPT: true,
  SETTINGS_INVALID_VALUE: true,
  SETTINGS_MODEL_REF_UNRESOLVED: true,
  SETTINGS_NOTE_WRITE_FAILED: true,
  SETTINGS_NOT_IN_VAULT: true,
  SETTINGS_UNKNOWN_KEY: true,
  WIKI_NARRATIVE_EMPTY: true,
  WIKI_SCHEMA_BOOTSTRAP_REQUIRED: true,
  STALE_ACTIVE_REPLACEMENT: true,
  STALE_NODE: true,
  WIKI_SUBPAGE_CAP: true,
  WIKI_SUBPAGE_REUSED: true,
};

describe('IssueCode union', () => {
  it('all variants are pinned (compile-time check via Record)', () => {
    // The Record<IssueCode, true> declaration is the actual exhaustiveness
    // check — it lives at compile time. This runtime assertion confirms
    // the map is non-empty and the import resolves.
    expect(Object.keys(ALL_ISSUE_CODES).length).toBeGreaterThan(0);
  });
});
