import { describe, it, expect } from 'vitest';
import { verdict, dryRunVerdict, EMPTY_COLLECTION_KEYS, type Verdict } from './verdict.js';
import type { Envelope, ErrorCode, Issue } from './index.js';

const NO_WARNINGS: Issue[] = [];

const ALL_ERROR_CODES: ErrorCode[] = [
  'NOT_FOUND', 'ALREADY_MATERIALIZED', 'INVALID_PARAMS', 'AMBIGUOUS_MATCH',
  'INTERNAL_ERROR', 'VALIDATION_FAILED', 'UNKNOWN_TYPE', 'EXTRACTOR_UNAVAILABLE',
  'AMBIGUOUS_FILENAME', 'CONFLICT', 'BATCH_FAILED', 'OPERATION_NOT_FOUND',
  'CONFIRMATION_REQUIRED', 'STALE_NODE', 'CONTENT_HASH_MISMATCH', 'NOT_ELIGIBLE',
  'UPSTREAM_ERROR', 'DUPLICATE_MEMORY',
];

function failEnv(code: ErrorCode): Envelope<unknown> {
  return { ok: false, error: { code, message: 'x' }, warnings: NO_WARNINGS };
}
function okEnv<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: NO_WARNINGS };
}

describe('verdict: FAIL', () => {
  it.each(ALL_ERROR_CODES)('ok:false with %s is FAIL for any tool', (code) => {
    expect(verdict('query-nodes', failEnv(code))).toBe('FAIL');
    expect(verdict('get-node', failEnv(code))).toBe('FAIL');
    expect(verdict('some-future-tool', failEnv(code))).toBe('FAIL');
  });
});

describe('verdict: WEAK (empty collection on mapped read tools)', () => {
  it('query-nodes with empty nodes is WEAK', () => {
    expect(verdict('query-nodes', okEnv({ nodes: [], total: 0 }))).toBe('WEAK');
  });
  it('web-search with empty results is WEAK', () => {
    expect(verdict('web-search', okEnv({ results: [] }))).toBe('WEAK');
  });
  it('list-memories with empty memories is WEAK, with or without a query', () => {
    expect(verdict('list-memories', okEnv({ memories: [], total: 0, query: 'q' }))).toBe('WEAK');
    expect(verdict('list-memories', okEnv({ memories: [], total: 0 }))).toBe('WEAK');
  });
  it('list-transcripts / list-boards / list-conversations empty are WEAK', () => {
    expect(verdict('list-transcripts', okEnv({ transcripts: [], count: 0 }))).toBe('WEAK');
    expect(verdict('list-boards', okEnv({ boards: [] }))).toBe('WEAK');
    expect(verdict('list-conversations', okEnv({ conversations: [] }))).toBe('WEAK');
  });
  // Same payload shape as the unscoped siblings above — scoring one WEAK and
  // the other PASS would ship an arbitrary asymmetry into the runtime router,
  // which uses this same predicate to decide when to escalate.
  it('doc-filtered list-boards / list-conversations empty are WEAK, like the unfiltered lists', () => {
    expect(verdict('list-boards', okEnv({ boards: [] }))).toBe('WEAK');
    expect(verdict('list-conversations', okEnv({ conversations: [] }))).toBe('WEAK');
  });
});

describe('verdict: PASS', () => {
  it('query-nodes with results is PASS', () => {
    expect(verdict('query-nodes', okEnv({ nodes: [{ id: 'x' }], total: 1 }))).toBe('PASS');
  });
  it('unmapped tools are PASS on any ok:true — even with empty arrays inside', () => {
    // get-node legitimately returns embeds: [] — must never be WEAK
    expect(verdict('get-node', okEnv({ id: 'n1', embeds: [], embed_errors: [] }))).toBe('PASS');
    expect(verdict('vault-stats', okEnv({ node_count: 0 }))).toBe('PASS');
    expect(verdict('some-future-tool', okEnv({}))).toBe('PASS');
  });
  it('mapped tool whose collection key is ABSENT is PASS (defensive: shape drift must not fabricate WEAK)', () => {
    expect(verdict('query-nodes', okEnv({ unexpected: true }))).toBe('PASS');
  });
});

describe('EMPTY_COLLECTION_KEYS', () => {
  it('contains exactly the six verified tools', () => {
    expect(Object.keys(EMPTY_COLLECTION_KEYS).sort()).toEqual([
      'list-boards', 'list-conversations',
      'list-memories', 'list-transcripts',
      'query-nodes', 'web-search',
    ]);
  });
});

describe('dryRunVerdict', () => {
  it('ok:false is INVALID', () => {
    expect(dryRunVerdict(failEnv('VALIDATION_FAILED'))).toBe('INVALID');
    expect(dryRunVerdict(failEnv('NOT_FOUND'))).toBe('INVALID');
  });
  it('ok:true with an error-severity warning is INVALID (engine dry-runs report failures this way)', () => {
    const env: Envelope<unknown> = { ok: true, data: { updated: false }, warnings: [
      { code: 'REQUIRED_MISSING', message: 'status is required', severity: 'error' },
    ] };
    expect(dryRunVerdict(env)).toBe('INVALID');
  });
  it('ok:true with only warning-severity warnings is VALID', () => {
    const env: Envelope<unknown> = { ok: true, data: { updated: true }, warnings: [
      { code: 'TITLE_WIKILINK_UNSAFE', message: 'soft', severity: 'warning' },
    ] };
    expect(dryRunVerdict(env)).toBe('VALID');
  });
  it('ok:true with no warnings is VALID', () => {
    expect(dryRunVerdict(okEnv({ updated: true }))).toBe('VALID');
  });
});

describe('type-level', () => {
  it('Verdict is exactly the three literals', () => {
    const v: Verdict = 'PASS';
    expect(['PASS', 'WEAK', 'FAIL']).toContain(v);
  });
});
