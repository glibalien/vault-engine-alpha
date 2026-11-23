import { describe, it, expect } from 'vitest';
import {
  computeMetrics,
  countWords,
  extractWikilinks,
  evidenceTitles,
  doneTaskTitles,
} from '../../src/eval/metrics.js';
import type { ProjectEvidence } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal ProjectEvidence fixture
// ---------------------------------------------------------------------------
const KNOWN_NOTE_TITLE = 'Architecture Overview';
const DONE_TASK_TITLE = 'Migrate database schema';

function makeEvidence(): ProjectEvidence {
  return {
    project: { id: 'proj-1', title: 'Demo Project', file_path: 'Demo Project.md', status: 'active' },
    tasks: {
      overdue: [],
      blocked: [],
      open: [{ id: 't1', title: 'Write tests', status: 'open', due: null }],
      upcoming: [],
      backlog: [],
      done_recent: [{ id: 't-done', title: DONE_TASK_TITLE, status: 'done', due: null }],
    },
    notes: [{ id: 'n1', title: KNOWN_NOTE_TITLE, file_mtime: null }],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: {
      recent: [{ id: 'm1', title: 'Sprint Planning', date: '2026-06-01', file_mtime: null, attendees: [] }],
      upcoming: [],
    },
    contacts: {
      people: [{ id: 'c1', title: 'Alice Smith', companies: [], direct: true, meeting_count: 1, last_seen: null }],
      companies: [{ id: 'co1', title: 'Acme Corp' }],
    },
    evidence_hash: 'abc123',
    generated_at: '2026-06-17T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Fixture markdown: one of each formatting element
// ---------------------------------------------------------------------------
const FIXTURE_CALLOUT = `> [!NOTE] This is a callout\nSome body text here.`;
const FIXTURE_TABLE = `| Name | Value |\n| --- | --- |\n| foo | bar |`;
const FIXTURE_CHECKBOX = `- [ ] An unchecked item`;
const FIXTURE_MERMAID = '```mermaid\ngraph TD\n A --> B\n```';
const FIXTURE_BULLET = `- A plain bullet point`;
const FIXTURE_HEADING = `## Section Heading`;

// Combine all into one string for formatting tests
const FORMATTING_FIXTURE = [
  FIXTURE_CALLOUT,
  FIXTURE_TABLE,
  FIXTURE_CHECKBOX,
  FIXTURE_MERMAID,
  FIXTURE_BULLET,
  FIXTURE_HEADING,
].join('\n\n');

// Wikilink fixture: one link to a known note, one to a nonexistent page
const WIKILINK_FIXTURE = `See [[${KNOWN_NOTE_TITLE}]] and also [[Nonexistent Page]] for details.`;

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------
describe('countWords', () => {
  it('counts space-separated words', () => {
    expect(countWords('hello world foo')).toBe(3);
  });
  it('returns 0 for empty / whitespace-only string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
  it('handles multiple spaces', () => {
    expect(countWords('one  two   three')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------
describe('extractWikilinks', () => {
  it('extracts plain wikilinks', () => {
    expect(extractWikilinks('See [[Foo]] here.')).toEqual(['Foo']);
  });
  it('extracts alias wikilinks, returning target not alias', () => {
    expect(extractWikilinks('See [[Foo|Bar]] here.')).toEqual(['Foo']);
  });
  it('extracts multiple wikilinks', () => {
    expect(extractWikilinks('[[A]] and [[B]]')).toEqual(['A', 'B']);
  });
  it('returns empty array when no wikilinks', () => {
    expect(extractWikilinks('no links here')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evidenceTitles
// ---------------------------------------------------------------------------
describe('evidenceTitles', () => {
  it('includes project title, note titles, task titles, meeting titles, contact titles, company titles', () => {
    const titles = evidenceTitles(makeEvidence());
    expect(titles.has('Demo Project')).toBe(true);
    expect(titles.has(KNOWN_NOTE_TITLE)).toBe(true);
    expect(titles.has('Write tests')).toBe(true);
    expect(titles.has(DONE_TASK_TITLE)).toBe(true);
    expect(titles.has('Sprint Planning')).toBe(true);
    expect(titles.has('Alice Smith')).toBe(true);
    expect(titles.has('Acme Corp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// doneTaskTitles
// ---------------------------------------------------------------------------
describe('doneTaskTitles', () => {
  it('returns titles from done_recent bucket only', () => {
    const titles = doneTaskTitles(makeEvidence());
    expect(titles).toContain(DONE_TASK_TITLE);
  });
  it('returns empty array when done_recent is absent', () => {
    const ev = makeEvidence();
    delete (ev.tasks as Record<string, unknown>)['done_recent'];
    expect(doneTaskTitles(ev)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formatting counts
// ---------------------------------------------------------------------------
describe('formatting counts via computeMetrics', () => {
  const sections = {
    now: FORMATTING_FIXTURE,
    focus: '',
    open_threads: '',
    log_entry: '',
  };
  const ev = makeEvidence();

  it('counts one callout', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.callouts).toBe(1);
  });
  it('counts one table (one separator line)', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.tables).toBe(1);
  });
  it('counts one checkbox (the - [ ] item)', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.checkboxes).toBe(1);
  });
  it('counts one mermaid block', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.mermaid).toBe(1);
  });
  it('counts bullets >= 1 (superset of checkbox)', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.bullets).toBeGreaterThanOrEqual(1);
    // checkbox line is also a bullet, so bullets >= checkboxes
    expect(m.formatting.bullets).toBeGreaterThanOrEqual(m.formatting.checkboxes);
  });
  it('counts one heading', () => {
    const m = computeMetrics(sections, ev);
    expect(m.formatting.headings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Word counts
// ---------------------------------------------------------------------------
describe('word counts via computeMetrics', () => {
  it('counts words per section and totals correctly', () => {
    const sections = {
      now: 'one two three',
      focus: 'alpha beta',
      open_threads: 'x',
      log_entry: '',
      at_a_glance: 'hello world',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.words.now).toBe(3);
    expect(m.words.focus).toBe(2);
    expect(m.words.open_threads).toBe(1);
    expect(m.words.log_entry).toBe(0);
    expect(m.words.at_a_glance).toBe(2);
    expect(m.words.total).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Wikilink resolution
// ---------------------------------------------------------------------------
describe('wikilink resolution via computeMetrics', () => {
  it('splits wikilinks into resolved and unverified', () => {
    const sections = {
      now: WIKILINK_FIXTURE,
      focus: '',
      open_threads: '',
      log_entry: '',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.wikilinks.total).toBe(2);
    expect(m.wikilinks.resolvedInEvidence).toBe(1);
    expect(m.wikilinks.unverified).toEqual(['Nonexistent Page']);
  });

  it('dedupes unverified wikilinks', () => {
    const sections = {
      now: '[[Ghost]] and [[Ghost]] again',
      focus: '',
      open_threads: '',
      log_entry: '',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.wikilinks.unverified).toEqual(['Ghost']);
  });
});

// ---------------------------------------------------------------------------
// Done-task leak heuristic
// ---------------------------------------------------------------------------
describe('doneLeaks heuristic via computeMetrics', () => {
  it('flags a focus line whose content names distinctive tokens of a done task', () => {
    // DONE_TASK_TITLE = 'Migrate database schema'
    // distinctive tokens (len>=4): migrate, database, schema
    const sections = {
      now: 'Some unrelated content',
      focus: 'We need to migrate database schema to PostgreSQL.',
      open_threads: '',
      log_entry: '',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.doneLeaks).toContain(DONE_TASK_TITLE);
  });

  it('does NOT flag an unrelated focus line', () => {
    const sections = {
      now: '',
      focus: 'Working on frontend redesign and user flows.',
      open_threads: '',
      log_entry: '',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.doneLeaks).not.toContain(DONE_TASK_TITLE);
  });

  it('flags a done task mentioned in open_threads', () => {
    const sections = {
      now: '',
      focus: '',
      open_threads: 'Still discussing migrate database schema approach.',
      log_entry: '',
    };
    const m = computeMetrics(sections, makeEvidence());
    expect(m.doneLeaks).toContain(DONE_TASK_TITLE);
  });

  it('does NOT flag when only short words match (tokens < 4 chars are excluded)', () => {
    // A done task with only short words would yield no distinctive tokens → never leaks
    const ev = makeEvidence();
    (ev.tasks as Record<string, unknown[]>)['done_recent'] = [
      { id: 't2', title: 'Do it now', status: 'done', due: null },
    ];
    const sections = {
      now: '',
      focus: 'do it now immediately',
      open_threads: '',
      log_entry: '',
    };
    const m = computeMetrics(sections, ev);
    // 'Do it now' has no tokens >= 4 chars, so it's never flagged
    expect(m.doneLeaks).not.toContain('Do it now');
  });
});
