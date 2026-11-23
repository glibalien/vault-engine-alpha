import { expect, it } from 'vitest';
import { createEvidenceDiagnostics, topicCoverageNote, readEvidenceDiagnostics } from '../src/topic-evidence-diagnostics.js';
import { curateResultToRunRow } from '../src/db/runs.js';
const selection = { policyVersion: 1 as const,
  excerpts: [{ sourceId: 'n', text: 'SECRET_BODY', spans: [{ startByte: 0, endByte: 1 }], originalBytes: 10, retainedBytes: 1 }],
  omissions: Array.from({ length: 30 }, (_, n) => ({ sourceId: String(n), reason: 'request_limit' as const })) };
it('bounds diagnostics and excludes raw text', () => {
  const d = createEvidenceDiagnostics();
  for (let i = 0; i < 100; i++) d.record('page', 'page', selection, 900, 98304, true);
  const result = d.snapshot();
  expect(result.calls.length).toBeLessThanOrEqual(64);
  expect(result.calls.length + result.omittedCallCount).toBe(100);
  expect(result.calls[0]?.affectedSourceIds.length).toBe(20);
  expect(result.calls[0]?.affectedSourceIdsTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  expect(JSON.stringify(result)).not.toContain('SECRET_BODY');
});
it('discloses partial coverage without byte counters and leaves full coverage alone', () => {
  expect(topicCoverageNote(selection)).toContain('excerpts');
  expect(topicCoverageNote(selection)).toContain('omitted');
  expect(topicCoverageNote(selection)).not.toContain('bytes');
  expect(topicCoverageNote({ policyVersion: 1, excerpts: [], omissions: [] })).toBeNull();
});
it('round-trips additive run diagnostics and tolerates legacy history', () => {
  const d = createEvidenceDiagnostics(); d.record('home', undefined, selection, 900, 204800, false);
  const row = curateResultToRunRow({ project: 'Topic', outcome: 'error', dryRun: false, evidenceSelection: d.snapshot() },
    { ts: '2026-09-27T00:00:00.000Z', trigger: 'scheduled', durationMs: 1 });
  expect(readEvidenceDiagnostics(row.refresh_evidence_json)).toEqual(d.snapshot());
  expect(readEvidenceDiagnostics(null)).toBeUndefined();
  expect(readEvidenceDiagnostics('{bad')).toBeUndefined();
  expect(readEvidenceDiagnostics('{"evidence_selection":{"version":1,"calls":[{"text":"SECRET"}]}}')).toBeUndefined();
});
