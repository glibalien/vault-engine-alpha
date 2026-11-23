import type { DossierSubject } from '../dossier/evidence.js';
import type { DossierKind } from '../prompts/dossier.js';
import type { SourceObservation } from '../provenance-types.js';
import type { EngineNode, EvidenceMeeting, ExistingWiki, Memory, ProjectEvidence } from '../types.js';
import type { GoldenCheck } from './wiki-golden-cases.js';

/**
 * Golden dossier cases (#721): fictional people and companies whose evidence reproduces what the
 * first real builds got wrong or nearly wrong (2026-11-21). Each case runs one real dossier call on
 * the wiki home model, the rule check when the subject has rules, and the page code, then checks the
 * page with patterns. Informational: run with `npm run eval:dossier` before changing the dossier
 * prompt, its schema or the home model. All names are fictional.
 */

/** Every case is built as of this day. */
export const DOSSIER_GOLDEN_NOW = new Date('2026-11-21T12:00:00.000Z');
/** The vault owner in every case: never the subject, called "you". */
export const DOSSIER_GOLDEN_OWNER = 'Avery Stone';

export interface GoldenMemory {
  readonly id: number;
  readonly content: string;
  readonly category?: 'rule' | 'preference';
  /** The day it became true. */
  readonly day: string;
  /** The note it came from, by title; none for a chat memory. */
  readonly from?: string;
  /** A past fact (#717): the day a newer memory contradicted it, and that memory's id. */
  readonly until?: string;
  readonly by?: number;
}

export interface GoldenMeeting {
  readonly title: string;
  readonly date: string;
  readonly attendees: readonly string[];
  /** Read in full when among the newest (#720). */
  readonly body?: string;
}

export interface DossierGoldenCase {
  readonly id: string;
  /** What this case guards against. */
  readonly failure: string;
  readonly kind: DossierKind;
  readonly subject: { readonly title: string; readonly body: string; readonly company?: string };
  readonly memories: readonly GoldenMemory[];
  readonly meetings?: readonly GoldenMeeting[];
  readonly people?: ReadonlyArray<{ readonly title: string; readonly companies: readonly string[]; readonly direct?: boolean }>;
  readonly companies?: readonly string[];
  /** Pattern checks on the page as code writes it, its "Rules on what to say" section left out. */
  readonly checks: readonly GoldenCheck[];
}

const id = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function observation(kind: 'node' | 'memory', nativeId: string): SourceObservation {
  return { source: { namespace: 'vault', kind, native_id: nativeId }, authority: 'engine', observed_at: DOSSIER_GOLDEN_NOW.toISOString(),
    native_version: 1, content_hash: `golden-${nativeId}`, hash_semantics: kind === 'node' ? 'engine_content_hash' : 'selected_projection_v1',
    observation_projection: kind === 'node' ? 'node-token-v2' : 'memory-content-v1', observation_digest: `sha256:json-v1:${'0'.repeat(64)}`,
    label: nativeId, path: null };
}

/** What the dossier code reads for a case, as the Engine would give it. */
export function goldenDossierInputs(c: DossierGoldenCase): {
  readonly subject: DossierSubject;
  readonly evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki };
  readonly memories: { owner: Memory[]; rules: Memory[]; facts: Memory[]; past: Memory[]; replacedBy: Map<number, Memory>; total: number; omitted: number };
  readonly bodies: Map<string, EngineNode>;
  readonly sourceTitles: Map<string, string>;
} {
  const subjectId = id(c.subject.title);
  const types = [c.kind];
  const node: EngineNode = { id: subjectId, title: c.subject.title, types, body: c.subject.body,
    fields: c.subject.company ? { company: { value: `[[${c.subject.company}]]` } } : {}, provenance_observation: observation('node', subjectId) } as EngineNode;
  const meetings: EvidenceMeeting[] = (c.meetings ?? []).map(m => ({ id: id(m.title), title: m.title, date: m.date, file_mtime: null,
    attendees: [...m.attendees] }));
  const people = (c.people ?? []).map(p => ({ id: id(p.title), title: p.title, companies: [...p.companies], direct: p.direct ?? false,
    meeting_count: meetings.filter(m => m.attendees.includes(p.title)).length, last_seen: null }));
  const companies = (c.companies ?? []).map(title => ({ id: id(title), title }));
  const noteIds = new Set([subjectId, ...meetings.map(m => m.id), ...people.map(p => p.id), ...companies.map(co => co.id),
    ...c.memories.flatMap(m => m.from ? [id(m.from)] : [])]);
  const evidence = {
    project: { id: subjectId, title: c.subject.title, file_path: `${c.kind === 'person' ? 'People' : 'Companies'}/${c.subject.title}.md`, status: null },
    tasks: {}, notes: [], signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: { recent: [...meetings].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')), upcoming: [] },
    contacts: { people, companies, unlinked: [] },
    evidence_hash: `golden-${c.id}`, generated_at: DOSSIER_GOLDEN_NOW.toISOString(),
    provenance_observations: { nodes: Object.fromEntries([...noteIds].map(n => [n, observation('node', n)])), truncated: false, aggregate_coverage: 'opaque' as const },
    existing_wiki: { home_id: null, home: null, topology_hash: 'golden', catalog_valid: true, subpages: [] },
  } as unknown as ProjectEvidence & { existing_wiki: ExistingWiki };
  const memory = (m: GoldenMemory): Memory => ({ id: m.id, source: m.from ? 'curator' : 'chat', scope: 'vault', node_id: null, content: m.content,
    category: m.category ?? 'fact', created_at: `${m.day}T09:00:00.000Z`, updated_at: `${m.day}T09:00:00.000Z`, valid_at: `${m.day}T00:00:00.000Z`,
    evidence_kind: m.from ? 'note' : 'conversation', evidence_node_id: m.from ? id(m.from) : null, provenance_observation: observation('memory', String(m.id)),
    ...(m.until ? { invalid_at: `${m.until}T00:00:00.000Z`, expired_at: `${m.until}T09:00:00.000Z`, expire_reason: 'contradicted',
      superseded_by: m.by ?? null } : {}) });
  const all = c.memories.filter(m => !m.until).map(memory);
  const past = c.memories.filter(m => m.until).map(memory);
  const live = new Map(all.map(m => [m.id, m]));
  const replacedBy = new Map(past.flatMap(m => m.superseded_by && live.has(m.superseded_by) ? [[m.id, live.get(m.superseded_by)!] as [number, Memory]] : []));
  const bodies = new Map((c.meetings ?? []).filter(m => m.body !== undefined).map(m => [id(m.title),
    { id: id(m.title), title: m.title, types: ['meeting'], body: m.body, provenance_observation: observation('node', id(m.title)) } as EngineNode]));
  const sourceTitles = new Map<string, string>([[subjectId, c.subject.title], ...(c.meetings ?? []).map(m => [id(m.title), m.title] as [string, string]),
    ...c.memories.flatMap(m => m.from ? [[id(m.from), m.from] as [string, string]] : [])]);
  return {
    subject: { id: subjectId, title: c.subject.title, kind: c.kind, types, node },
    evidence,
    memories: { owner: [], rules: all.filter(m => m.category === 'rule'), facts: all.filter(m => m.category !== 'rule'), past, replacedBy, total: all.length, omitted: 0 },
    bodies,
    sourceTitles,
  };
}

export const DOSSIER_GOLDEN_CASES: readonly DossierGoldenCase[] = [
  {
    id: 'person-timeline-days',
    failure: 'the first real build (2026-11-21) left 27 of 41 lines undated, most from a dated timeline in the person\'s own note; and a past deadline sat under Open items',
    kind: 'person',
    subject: {
      title: 'Dana Whitfield', company: 'Northwind',
      body: [
        '## Background',
        '- Runs procurement at [[Northwind]]; joined from a logistics firm in 2024.',
        '',
        '## Timeline',
        '- **2026-02-10:** first call with [[Lee Okafor]] about the warehouse pilot.',
        '- **2026-03-04, [[Kickoff call]]:**',
        '  - Agreed the pilot scope with [[Lee Okafor]] and you.',
        '  - Asked for weekly status reports by email.',
        '- **2026-04-15:** the renewal budget was approved by the finance committee.',
        '- **2026-12-01:** planned site visit at the Rotterdam warehouse.',
      ].join('\n'),
    },
    memories: [
      { id: 101, content: 'Dana Whitfield leads procurement at Northwind.', day: '2026-03-04', from: 'Kickoff call' },
      { id: 102, content: 'Dana Whitfield prefers email over calls.', category: 'preference', day: '2026-05-02' },
    ],
    meetings: [
      { title: 'Pilot review', date: '2026-10-02', attendees: ['Dana Whitfield', 'Avery Stone'],
        body: '- Dana asked for the pilot report by 2026-10-15.\n- Dana confirmed the Rotterdam site visit on 2026-12-01.' },
      { title: 'Kickoff call', date: '2026-03-04', attendees: ['Dana Whitfield', 'Lee Okafor', 'Avery Stone'] },
    ],
    people: [{ title: 'Lee Okafor', companies: ['Northwind'] }],
    companies: ['Northwind'],
    checks: [
      { kind: 'includes', pattern: /renewal budget[^\n]*· 2026-04-15/i, section: 'History', why: 'the renewal budget line is dated by its own timeline entry' },
      { kind: 'excludes', pattern: /renewal budget[^\n]*· 2026-0(2-10|3-04)/i, why: 'no other entry\'s day on the renewal budget line' },
      { kind: 'excludes', pattern: /pilot report/i, section: 'Open items', why: 'a deadline that has passed is not an open item' },
      { kind: 'includes', pattern: /Rotterdam/i, why: 'the planned site visit, said in the note and the meeting, is on the page' },
      { kind: 'excludes', pattern: /Avery Stone/, why: 'the owner is "you", never named' },
    ],
  },
  {
    id: 'company-people-and-bodies',
    failure: 'a company dossier listed a colleague of the owner under People (2026-11-21); and before #720 a fact said only in a meeting never reached the page',
    kind: 'company',
    subject: { title: 'Northwind', body: 'Logistics firm. Account since 2025.' },
    memories: [
      { id: 201, content: 'Northwind is a logistics firm based in Rotterdam.', day: '2025-06-01', from: 'Northwind' },
      { id: 202, content: 'Northwind\'s renewal is due on 2027-01-31.', day: '2026-09-15', from: 'Renewal planning' },
    ],
    meetings: [
      { title: 'Expansion check-in', date: '2026-11-10', attendees: ['Lee Okafor', 'Avery Stone', 'Sam Patel'],
        body: '- Lee Okafor said the board approved the warehouse expansion.\n- Sam Patel (our side) to send revised pricing.' },
    ],
    people: [
      { title: 'Dana Whitfield', companies: ['Northwind'], direct: true },
      { title: 'Lee Okafor', companies: ['Northwind'] },
      { title: 'Sam Patel', companies: ['Acme'] },
    ],
    checks: [
      { kind: 'includes', pattern: /\[\[Dana Whitfield\]\]/, section: 'People', why: 'its people, by their notes' },
      { kind: 'includes', pattern: /\[\[Lee Okafor\]\]/, section: 'People', why: 'its people, by their notes' },
      { kind: 'excludes', pattern: /Sam Patel/, section: 'People', why: 'the owner\'s colleague is not one of its people' },
      { kind: 'includes', pattern: /warehouse expansion[^\n]*\[\[Expansion check-in\]\]/i, why: 'a fact said only in a meeting reaches the page, cited to it' },
      { kind: 'includes', pattern: /logistics/i, section: 'What it is', why: 'what it is, from its memory' },
    ],
  },
  {
    id: 'rule-kept',
    failure: 'rules on what may be said were listed on dossiers but never checked (#721)',
    kind: 'person',
    subject: { title: 'Lee Okafor', company: 'Northwind', body: 'Operations director at [[Northwind]].' },
    memories: [
      { id: 301, content: 'Never mention Northwind\'s acquisition talks with Contoso on anything about Lee Okafor.', category: 'rule', day: '2026-10-01', from: 'Account notes' },
      { id: 302, content: 'Northwind is in early acquisition talks with Contoso, which Lee Okafor is leading.', day: '2026-10-01', from: 'Account notes' },
      { id: 303, content: 'Lee Okafor runs operations at Northwind.', day: '2026-03-04', from: 'Kickoff call' },
    ],
    meetings: [{ title: 'Kickoff call', date: '2026-03-04', attendees: ['Lee Okafor', 'Avery Stone'] }],
    companies: ['Northwind'],
    checks: [
      { kind: 'excludes', pattern: /acquisition|Contoso/i, why: 'the rule holds everywhere but its own listing' },
      { kind: 'includes', pattern: /operations/i, section: 'Who', why: 'the facts the rule allows are still written' },
    ],
  },
  {
    id: 'employer-changed',
    failure: 'a dossier read live memories only, so an employer a newer memory replaced was gone from the page; and a correction must not read as a change (#717)',
    kind: 'person',
    subject: { title: 'Sam Rivera', company: 'Contoso', body: 'Head of partnerships at [[Contoso]].' },
    memories: [
      { id: 401, content: 'Sam Rivera works at Northwind as an account lead.', day: '2026-01-10', from: 'Intro call', until: '2026-03-04', by: 402 },
      { id: 402, content: 'Sam Rivera works at Contoso as head of partnerships.', day: '2026-03-04', from: 'Catch-up' },
      // A correction: Lyon was never true, so it is nowhere on the page.
      { id: 403, content: 'Sam Rivera is based in Lyon.', day: '2026-01-10', from: 'Intro call', until: '2026-03-04', by: 404 },
      { id: 404, content: 'Sam Rivera is based in Lille; the intro call notes had the city wrong.', day: '2026-03-04', from: 'Catch-up' },
    ],
    meetings: [{ title: 'Catch-up', date: '2026-03-04', attendees: ['Sam Rivera', 'Avery Stone'] }],
    companies: ['Contoso'],
    checks: [
      { kind: 'includes', pattern: /Northwind[^\n]*· 2026-01-10 to 2026-03-04/i, section: 'History', why: 'the old employer is in History with the days it was true' },
      { kind: 'excludes', pattern: /Northwind/i, section: 'Who', why: 'a past fact is never written as present' },
      { kind: 'excludes', pattern: /Lyon/i, why: 'a corrected fact was never true: it is not a past fact' },
      { kind: 'includes', pattern: /Contoso/i, section: 'Who', why: 'the current employer is who they are' },
    ],
  },
];
