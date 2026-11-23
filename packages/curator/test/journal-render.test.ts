import { describe, expect, it } from 'vitest';
import type { JournalEventRow } from '../src/db/journal.js';
import { formatStamp, journalNoteTitle, renderBody, deterministicLede, renderEntry } from '../src/journal/render.js';

function row(overrides: Partial<JournalEventRow>): JournalEventRow {
  return {
    id: 1, ts: '2026-07-13T09:00:00.000Z', run_ref: 'r', trigger: 'scheduled',
    function: 'org-sweep', kind: 'action', action: 'typed', node_id: null, target: null,
    detail: 'typed "X" → recipe', dry_run: 0, journaled_at: null,
    ...overrides,
  };
}

describe('formatStamp / journalNoteTitle', () => {
  it('formats date, time and month in the given timezone', () => {
    // 2026-07-13T03:30Z is 2026-07-12 23:30 in America/New_York.
    const s = formatStamp(new Date('2026-07-13T03:30:00.000Z'), 'America/New_York');
    expect(s).toEqual({ date: '2026-07-12', time: '23:30', month: '2026-07' });
    expect(journalNoteTitle(s.month)).toBe('Curator Journal — 2026-07');
  });
});

describe('renderBody', () => {
  it('groups by function, summaries first, and surfaces errors', () => {
    const events = [
      row({ id: 1, function: 'wiki-curation', kind: 'summary', action: null, detail: JSON.stringify({ line: 'Proj A — written (1 created, 1 merged)', stats: { outcome: 'written', errors: 0 } }) }),
      row({ id: 2, function: 'wiki-curation', action: 'wiki-written', detail: 'updated wiki home for "Proj A"' }),
      row({ id: 3, function: 'org-sweep', kind: 'summary', action: null, detail: JSON.stringify({ line: 'typing: 2 typed, 1 errors', stats: { errors: 1 } }) }),
      row({ id: 4, function: 'org-sweep', action: 'typed', detail: 'typed "X" → recipe' }),
    ];
    const { body, actionLines, anyErrors } = renderBody(events as JournalEventRow[]);
    expect(anyErrors).toBe(true);
    expect(actionLines).toEqual(['updated wiki home for "Proj A"', 'typed "X" → recipe']);
    expect(body).toBe([
      '**Wiki curation**',
      '- Proj A — written (1 created, 1 merged)',
      '- updated wiki home for "Proj A"',
      '**Org sweep**',
      '- typing: 2 typed, 1 errors',
      '- typed "X" → recipe',
    ].join('\n'));
  });

  it('tolerates a malformed summary detail (falls back to the raw string, no throw)', () => {
    const { body } = renderBody([row({ kind: 'summary', action: null, detail: 'not-json' })]);
    expect(body).toContain('- not-json');
  });

  it('adds only a bounded closed refresh trigger and warning codes to topic summaries', () => {
    const sourceContent = 'SECRET SOURCE BODY AND WEB SNIPPET';
    const warnings = [
      'source_baseline_not_ready', 'source_read_unavailable', 'web_baseline_not_ready',
      'web_probe_unavailable', 'web_probe_overflow', 'assessment_cap_exhausted',
      'assessment_failed', 'refresh_state_persist_failed', 'not_closed',
    ];
    const detail = JSON.stringify({
      line: 'Topic — skipped (cadence not due)',
      stats: {
        outcome: 'skipped_cadence_not_due', errors: 0,
        refresh_trigger: 'not_due', refresh_warnings: warnings,
        changed_source_node_ids: ['secret-source-id'], source_body: sourceContent,
      },
    });

    const { body } = renderBody([row({ function: 'topic-curation', kind: 'summary', action: null, detail })]);

    expect(body).toContain('refresh trigger: not_due');
    expect(body).toContain('refresh warnings: source_baseline_not_ready, source_read_unavailable');
    expect(body).toContain('refresh_state_persist_failed');
    expect(body).not.toContain('not_closed');
    expect(body).not.toContain('secret-source-id');
    expect(body).not.toContain(sourceContent);
  });
});

describe('deterministicLede', () => {
  it('says quiet when nothing happened', () => {
    expect(deterministicLede([], false)).toBe('A quiet run — checks came back with nothing needing changes.');
  });
  it('inlines 1-2 actions', () => {
    expect(deterministicLede(['typed "X" → recipe'], false)).toBe('Quick update: typed "X" → recipe.');
  });
});

describe('renderEntry', () => {
  it('assembles header, lede and body', () => {
    const entry = renderEntry('nightly sweep', { date: '2026-07-13', time: '05:04' }, 'A quiet night.', '**Org sweep**\n- typed "X" → recipe');
    expect(entry).toBe('## 2026-07-13 05:04 — nightly sweep\n\nA quiet night.\n\n**Org sweep**\n- typed "X" → recipe');
  });
});
