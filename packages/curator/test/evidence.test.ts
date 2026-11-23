import { describe, expect, it } from 'vitest';
import { gapFillQueryText, collectEvidenceIds, buildEvidence, truncate, requestedPageEvidence, closedSinceBlock } from '../src/evidence.js';
import type { ProjectEvidence, ProjectRef } from '../src/types.js';
import type { GapFillCandidate, Memory } from '../src/types.js';

function evidence(over: Partial<ProjectEvidence> = {}): ProjectEvidence {
  return {
    project: { id: 'p1', title: 'Demo', file_path: 'Projects/Demo.md', status: 'in-progress' },
    tasks: { open: [], overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [] },
    notes: [],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    meetings: { recent: [], upcoming: [] },
    contacts: { people: [], companies: [] },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    evidence_hash: 'h',
    generated_at: '2026-06-06T00:00:00Z',
    ...over,
  };
}

const project: ProjectRef = { id: 'p1', title: 'Demo', file_path: 'Projects/Demo.md', status: 'in-progress' };

describe('gapFillQueryText', () => {
  it('degrades to just the title when there are no tasks or notes', () => {
    expect(gapFillQueryText(project, evidence())).toBe('Demo');
  });

  it('takes up to 3 task titles in overdue→blocked→open priority, then up to 3 note titles', () => {
    const text = gapFillQueryText(project, evidence({
      tasks: {
        overdue: [{ id: 'o1', title: 'pay invoice', status: null, due: null }],
        blocked: [{ id: 'b1', title: 'await legal', status: null, due: null }],
        open: [
          { id: 'op1', title: 'draft plan', status: null, due: null },
          { id: 'op2', title: 'should not appear', status: null, due: null },
        ],
        upcoming: [], backlog: [], done_recent: [],
      },
      notes: [
        { id: 'n1', title: 'spec' }, { id: 'n2', title: 'retro' },
        { id: 'n3', title: 'kickoff' }, { id: 'n4', title: 'overflow note' },
      ],
    }));
    expect(text).toBe('Demo\npay invoice\nawait legal\ndraft plan\nspec\nretro\nkickoff');
  });
});

describe('collectEvidenceIds', () => {
  it('collects ids from every evidence collection plus the project', () => {
    const ids = collectEvidenceIds(evidence({
      tasks: { open: [{ id: 't-open', title: 'x', status: null, due: null }], overdue: [{ id: 't-over', title: 'y', status: null, due: null }], blocked: [], upcoming: [], backlog: [], done_recent: [] },
      notes: [{ id: 'note1', title: 'n' }],
      contacts: { people: [{ id: 'c1', title: 'Pat', companies: [], direct: true, meeting_count: 0, last_seen: null }], companies: [] },
      meetings: { recent: [{ id: 'm1', title: 'Sync', date: null, file_mtime: null, attendees: [] }], upcoming: [{ id: 'm2', title: 'Plan', date: null, file_mtime: null, attendees: [] }] },
      synthesis_hints: { suggested_reads: [{ id: 'r1', title: 'Read', reason: 'why' }], overdue_task_ids: [], recently_done_ids: [] },
      existing_wiki: { home_id: 'home1', subpages: [{ id: 'sub1', title: 'Sub' }] },
    }), project);
    expect(ids).toEqual(new Set(['p1', 't-open', 't-over', 'note1', 'c1', 'm1', 'm2', 'r1', 'home1', 'sub1']));
  });
});

describe('truncate', () => {
  const long = 'x'.repeat(50);

  it('returns text unchanged when cap is null (no suffix)', () => {
    expect(truncate(long, null)).toBe(long);
  });

  it('truncates with a suffix when over a numeric cap', () => {
    const out = truncate(long, 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('[truncated 40 chars]');
  });

  it('leaves text at or under the cap unchanged', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('applies the same body limit independently to each page read', () => {
    // Given/When: two full page bodies cross the bounded synthesis seam.
    const bodies = ['A'.repeat(12), 'B'.repeat(15)].map(body => truncate(body, 5));

    // Then: neither body can consume the other page's allowance.
    expect(bodies).toEqual(['AAAAA\n…[truncated 7 chars]', 'BBBBB\n…[truncated 10 chars]']);
  });
});

describe('buildEvidence — body cap', () => {
  const longBody = 'B'.repeat(9000);
  const bigNode = { id: 'n1', title: 'Big Note', types: ['note'], fields: {}, body: longBody };

  it('includes the full body verbatim when bodyCharCap is null', () => {
    const out = buildEvidence(project, evidence(), [bigNode], null, []);
    expect(out).toContain(longBody);
    expect(out).not.toContain('[truncated');
  });

  it('truncates the body when a numeric cap is given', () => {
    const out = buildEvidence(project, evidence(), [bigNode], 4000, []);
    expect(out).toContain('[truncated 5000 chars]');
    expect(out).not.toContain(longBody);
  });
});

describe('buildEvidence — gap-fill candidates', () => {
  it('omits the candidate block entirely when there are no candidates', () => {
    const out = buildEvidence(project, evidence(), [], 4000, []);
    expect(out).not.toContain('RELATED (UNLINKED) CANDIDATES');
  });

  it('renders a labeled block; bodies appear only for candidates that have one', () => {
    const candidates: GapFillCandidate[] = [
      { id: 'n1', title: 'Alpha', types: ['note'], status: 'open', match_sources: ['semantic'], body: 'first line\nsecond line' },
      { id: 'n2', title: 'Beta', types: ['task'], status: null, match_sources: ['fts', 'semantic'] },
    ];
    const out = buildEvidence(project, evidence(), [], 4000, candidates);
    expect(out).toContain('## RELATED (UNLINKED) CANDIDATES — low confidence');
    expect(out).toContain('- Alpha (types: note; status: open) [matched: semantic]');
    expect(out).toContain('- Beta (types: task; status: (none)) [matched: fts+semantic]');
    expect(out).toContain('  first line\n  second line'); // body indented under Alpha
    // Beta has no body line
    const betaIdx = out.indexOf('- Beta');
    expect(out.slice(betaIdx).trim().split('\n').length).toBe(1);
  });
});

describe('buildEvidence — legacy spine filtering', () => {
  it('omits all retired-spine pages (Task Board / Contacts / etc.) from the Existing sub-pages line', () => {
    const txt = buildEvidence(project, evidence({
      existing_wiki: { home_id: 'h', subpages: [
        { id: 'a', title: 'Demo — Task Board' },
        { id: 'b', title: 'Demo — Contacts' },
      ] },
    }), [], null);
    expect(txt).not.toContain('Demo — Task Board');
    expect(txt).not.toContain('Demo — Contacts');
    expect(txt).not.toContain('Existing sub-pages:');
  });
});

// Alias for requestedPageEvidence tests — same shape as evidence() helper above.
const makeEvidence = evidence;

describe('requestedPageEvidence', () => {
  it('renders the request, project tasks, and related material with bodies', () => {
    const ev = makeEvidence({
      tasks: { open: [{ id: 't1', title: 'Wire SSO', status: 'open', due: null }], overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [] },
      notes: [{ id: 'n1', title: 'Auth meeting notes' }],
    });
    const related: GapFillCandidate[] = [
      { id: 'r1', title: 'POT findings', types: ['note'], status: null, body: 'entra id works' },
      { id: 'r2', title: 'Vendor call', types: ['meeting'], status: null },
    ];
    const txt = requestedPageEvidence(ev, 'Demo — ID Check Pilot', 'the auth workstream', related, null);
    expect(txt).toContain('## THE REQUEST');
    expect(txt).toContain('Page: Demo — ID Check Pilot');
    expect(txt).toContain('Brief: the auth workstream');
    expect(txt).toContain('Wire SSO');
    expect(txt).toContain('- Auth meeting notes');
    expect(txt).toContain('### POT findings');
    expect(txt).toContain('entra id works');
    expect(txt).toContain('(body not read)'); // r2 has no body attached
  });

  it('says plainly when nothing related was found', () => {
    const txt = requestedPageEvidence(makeEvidence(), 'Demo — X', undefined, [], null);
    expect(txt).toContain('nothing related found');
  });

  it("shows the build's memories right after the request, named for the wiki's subject (#313)", () => {
    const memories: Memory[] = [
      { id: 1, source: 'owner', scope: 'vault', node_id: null, content: 'Keep pages short.', category: 'preference', created_at: '', updated_at: '' },
      { id: 2, source: 'curator', scope: 'vault', node_id: null, content: 'The gateway ships in March.', category: 'fact', created_at: '', updated_at: '' },
    ];
    const txt = requestedPageEvidence(makeEvidence(), 'Demo — X', 'brief', [], null, undefined, memories, 'topic');
    expect(txt.indexOf('## THE REQUEST')).toBeLessThan(txt.indexOf('## OWNER MEMORIES'));
    expect(txt.indexOf('- [fact] The gateway ships in March.')).toBeLessThan(txt.indexOf('## Tasks'));
    expect(txt).toContain('durable facts about this topic');
    expect(requestedPageEvidence(makeEvidence(), 'Demo — X', 'brief', [], null)).not.toContain('MEMORIES');
  });
});

describe('buildEvidence — engine projections', () => {
  it('labels churn with the recent window Engine used, else the old 7 days (#448)', () => {
    const windows = { today: '2026-06-06', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 3 };
    expect(buildEvidence(project, evidence({ windows }), [], null)).toContain('- churn (nodes touched in last 3d): 0');
    expect(buildEvidence(project, evidence(), [], null)).toContain('- churn (nodes touched in last 7d): 0');
  });

  it('renders changed-since-curation, risk proxies, timeline, and salience when present', () => {
    const out = buildEvidence(project, evidence({
      changed_since_curation: {
        since: '2026-06-01T00:00:00Z',
        buckets: {
          task: [{ id: 't1', title: 'Ship X', type: 'task', file_mtime: 3_000_000, modified: '2026-06-10T00:00:00Z' }],
        },
      },
      signals_detail: {
        risk_proxies: [{ id: 'r1', title: 'Blocked thing', status: 'blocked', due: '2026-06-01', priority: 'high', scheduled: null, bucket: 'overdue', blocked: true }],
        timeline: [{ id: 'm1', title: 'Kickoff', date: '2026-05-01', type: 'meeting' }],
      },
      synthesis_hints: {
        suggested_reads: [], overdue_task_ids: [], recently_done_ids: [],
        salience: [{ id: 's1', title: 'Hot thread', score: 0.9, components: { recency: 1, degree: 0.7, urgency: 1 } }],
      },
    }), [], 4000);
    expect(out).toContain('CHANGED SINCE LAST CURATION');
    expect(out).toContain('Ship X');
    expect(out).toContain('RISK PROXIES');
    expect(out).toContain('Blocked thing');
    expect(out).toContain('TIMELINE');
    expect(out).toContain('Kickoff');
    expect(out).toContain('SALIENCE');
    expect(out).toContain('Hot thread');
  });

  it('prints a changed node\'s modified date in the configured zone (#459)', () => {
    // 22:30 on 9 March in New York is already 10 March in UTC.
    const changed = evidence({ changed_since_curation: { since: '2026-03-01T00:00:00Z', buckets: {
      task: [{ id: 't1', title: 'Ship X', type: 'task', file_mtime: Date.parse('2026-03-10T03:30:00Z'), modified: '2026-03-10T03:30:00.000Z' }],
    } } });
    const inZone = (timeZone: string) => buildEvidence(project, changed, [], 4000, [], new Set(), [], [], undefined, 'wiki', timeZone);
    expect(inZone('America/New_York')).toContain('  - Ship X (modified 2026-03-09)');
    expect(inZone('UTC')).toContain('  - Ship X (modified 2026-03-10)');
  });

  it('omits all four blocks when the fields are absent', () => {
    const out = buildEvidence(project, evidence(), [], 4000);
    expect(out).not.toContain('CHANGED SINCE LAST CURATION');
    expect(out).not.toContain('RISK PROXIES');
    expect(out).not.toContain('TIMELINE');
    expect(out).not.toContain('SALIENCE');
  });
});

describe('closedSinceBlock', () => {
  it('renders a CLOSED SINCE block listing each done item', () => {
    const lines = closedSinceBlock([
      { id: 'a', title: 'Book lodging', status: 'done', due: null, closed_at: 1 },
      { id: 'b', title: 'Send invoice', status: 'done', due: '2026-06-20', closed_at: 2 },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('CLOSED SINCE LAST CURATION');
    expect(text).toContain('Book lodging');
    expect(text).toContain('Send invoice');
  });

  it('returns [] when there is nothing closed', () => {
    expect(closedSinceBlock(undefined)).toEqual([]);
    expect(closedSinceBlock([])).toEqual([]);
  });
});

describe('buildEvidence — caller corrections', () => {
  it('renders a CALLER CORRECTIONS block above ## Signals when present', () => {
    const out = buildEvidence(project, evidence(), [], 4000, [], new Set(),
      ['stop tracking the Q2 migration', 'lodging is booked']);
    expect(out).toContain('## CALLER CORRECTIONS');
    expect(out).toContain('- stop tracking the Q2 migration');
    expect(out).toContain('- lodging is booked');
    expect(out.indexOf('CALLER CORRECTIONS')).toBeLessThan(out.indexOf('## Signals'));
  });

  it('omits the block when there are no corrections', () => {
    const out = buildEvidence(project, evidence(), [], 4000);
    expect(out).not.toContain('CALLER CORRECTIONS');
  });
});

function memory(over: Partial<Memory> = {}): Memory {
  return {
    id: 1, source: 'curator', scope: 'vault', node_id: null,
    content: 'Prefers concise summaries.', category: 'preference',
    metadata: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
    ...over,
  };
}

describe('buildEvidence — curator memories', () => {
  it("renders the owner's memories and the project's facts apart, after CALLER CORRECTIONS, without ids (#299)", () => {
    const memories: Memory[] = [
      memory({ id: 3, source: 'owner', category: 'preference', content: 'Keep the Now section to three lines.' }),
      memory({ id: 7, category: 'fact', content: 'The client runs its own API gateway.' }),
      memory({ id: 9, source: 'chat', category: null, content: 'Lodging is already booked.' }),
    ];
    const out = buildEvidence(project, evidence(), [], 4000, [], new Set(), ['a correction'], memories);
    const owner = out.indexOf('## OWNER MEMORIES');
    const facts = out.indexOf('## MEMORIES (durable facts about this project');
    expect(out.slice(owner, facts)).toContain('- [preference] Keep the Now section to three lines.');
    expect(out.slice(facts)).toContain('- [fact] The client runs its own API gateway.');
    expect(out.slice(facts)).toContain('- Lodging is already booked.'); // no category prefix when null
    expect(out).not.toMatch(/\(id: \d+\)/);
    expect(out.indexOf('CALLER CORRECTIONS')).toBeLessThan(owner);
    expect(owner).toBeLessThan(facts);
    expect(facts).toBeLessThan(out.indexOf('## Signals'));
  });

  it('cuts a long generated memory and marks it, but never an owner memory', () => {
    const long = 'word '.repeat(400);
    const out = buildEvidence(project, evidence(), [], 4000, [], new Set(), [], [
      memory({ id: 1, source: 'owner', category: null, content: long }), memory({ id: 2, category: null, content: long }),
    ]);
    expect(out).toContain(`- ${long}`);
    expect(out).toMatch(/- (word ){199}word… \(cut\)/);
  });

  it('omits the blocks entirely when there are no memories', () => {
    const out = buildEvidence(project, evidence(), [], 4000, [], new Set(), [], []);
    expect(out).not.toContain('MEMORIES');
  });
});

import { EvidenceCollector } from '../src/provenance-evidence.js';
import { observedNode } from './provenance-page-fixtures.js';
it('attributes only supplied requested-home material and keeps caller-generated instructions opaque', () => {
  const tasks = Array.from({ length: 13 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}`, status: 'open', due: null }));
  const notes = Array.from({ length: 16 }, (_, i) => ({ id: `note-${i}`, title: `Note ${i}` }));
  const ids = ['p1', ...tasks.slice(0, 12).map(t => t.id), ...notes.slice(0, 15).map(n => n.id)];
  const collector = new EvidenceCollector(Object.fromEntries(ids.map(id => [id, observedNode(id).provenance_observation!])));
  const text = requestedPageEvidence(evidence({ tasks: { open: tasks }, notes }), 'é Decisions', 'caller brief', [], null, collector);
  const selected = collector.items.flatMap(item => item.observation ? [item.observation.source.native_id] : []);
  expect(selected).toContain('task-11'); expect(selected).not.toContain('task-12');
  expect(selected).toContain('note-14'); expect(selected).not.toContain('note-15');
  const opaque = collector.items.find(item => item.origin === 'opaque')!;
  expect(opaque.observation).toBeNull();
  const span = opaque.spans[0]!;
  expect(Buffer.from(text).subarray(span.start, span.end).toString()).toContain('Page: é Decisions\nBrief: caller brief');
});


it('attributes each requested task row without sibling rows or aggregate counts', () => {
  const tasks = Array.from({ length: 13 }, (_, i) => ({
    id: `t${i}`, title: `Décision ${i}\ncontinued`, status: 'open', due: '2026-10-01',
  }));
  const ev = evidence({ tasks: { open: tasks } });
  const collector = new EvidenceCollector(Object.fromEntries(['p1', ...tasks.slice(0, 12).map(t => t.id)]
    .map(id => [id, observedNode(id).provenance_observation!])));
  const text = requestedPageEvidence(ev, 'Decisions', undefined, [], null, collector);
  expect(text).toBe(requestedPageEvidence(ev, 'Decisions', undefined, [], null));
  const retained = (item: typeof collector.items[number]) => item.spans.map(span =>
    Buffer.from(text).subarray(span.start, span.end).toString()).join('');
  for (const task of tasks.slice(0, 12)) {
    const item = collector.items.find(item => item.observation?.source.native_id === task.id)!;
    expect(retained(item)).toBe(`  - ${task.title} (due 2026-10-01 · open)`);
  }
  expect(collector.items.some(item => item.observation?.source.native_id === 't12')).toBe(false);
  const opaque = collector.items.filter(item => item.origin === 'opaque').map(retained);
  expect(opaque).toContain('Open (13):');
  expect(opaque).toContain('  - …and 1 more');
});
