import { describe, expect, it } from 'vitest';
import { renderContacts, renderMeetings, renderNotes, renderSubPages } from '../../src/wiki/render-live.js';
import type { EvidenceContact, EvidenceMeeting } from '../../src/wiki/evidence.js';
import type { DigestNode, ProjectDigest, WikiCatalogPage } from '../../src/wiki/digest.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { computeWikiTopologyHash } from '../../src/wiki/topology.js';

describe('renderContacts', () => {
  it('renders people with company/meeting/contact meta and a companies section', () => {
    const people: EvidenceContact[] = [
      { id: 'pA', title: 'Alice', file_path: 'Persons/Alice.md', companies: ['Globex'], direct: true, meeting_count: 2, last_seen: 1 },
      { id: 'pC', title: 'Carol', file_path: 'Persons/Carol.md', companies: [], direct: false, meeting_count: 1, last_seen: 1 },
    ];
    const out = renderContacts({ people, companies: [{ id: 'cX', title: 'Acme', file_path: 'Companies and Organizations/Acme.md' }] });
    expect(out).toContain('**People (2)**');
    expect(out).toContain('- [[Alice]] — Globex · 2 meetings · project contact');
    expect(out).toContain('- [[Carol]] — 1 meeting');
    expect(out).toContain('**Companies (1)**');
    expect(out).toContain('- [[Acme]]');
  });

  it('is empty when there are no contacts', () => {
    expect(renderContacts({ people: [], companies: [] })).toBe('');
  });
});

describe('renderMeetings', () => {
  it('lists upcoming before recent with date and attendees', () => {
    const recent: EvidenceMeeting[] = [{ id: 'm1', title: 'Kickoff', file_path: 'Meetings/Kickoff.md', date: '2026-05-01', file_mtime: 1, content_hash: null, attendees: ['Alice', 'Carol'], project_count: 1 }];
    const upcoming: EvidenceMeeting[] = [{ id: 'm2', title: 'Review', file_path: 'Meetings/Review.md', date: '2026-07-01', file_mtime: 1, content_hash: null, attendees: ['Alice'], project_count: 1 }];
    const out = renderMeetings({ recent, upcoming });
    expect(out.indexOf('Upcoming')).toBeLessThan(out.indexOf('Recent'));
    expect(out).toContain('- [[Review]] — 2026-07-01 · Alice');
    expect(out).toContain('- [[Kickoff]] — 2026-05-01 · Alice, Carol');
  });
});

describe('renderNotes', () => {
  it('lists note wikilinks and is empty for none', () => {
    const notes: DigestNode[] = [{ id: 'n1', title: 'A Note', file_path: 'Notes/A Note.md', file_mtime: 1, content_hash: null }];
    expect(renderNotes(notes)).toBe('- [[A Note]]');
    expect(renderNotes([])).toBe('');
  });
});

describe('renderSubPages reconciliation tiers', () => {
  it('renders active pages, collapsed dormant pages, and retired history in order', () => {
    // Given
    const target = catalogPage('target', 'Project — Canonical', 'active');
    const dormant = catalogPage('dormant', 'Project — Paused', 'dormant');
    const retired = {
      ...catalogPage('retired', 'Project — Legacy', 'retired'),
      wiki_replaced_by: { id: target.id, title: target.title },
    } satisfies WikiCatalogPage;

    // When
    const output = renderSubPages(digestWith([retired, dormant, target]));

    // Then
    expect(output.indexOf('**Active pages**')).toBeLessThan(output.indexOf('<summary>Dormant (1)</summary>'));
    expect(output.indexOf('<summary>Dormant (1)</summary>')).toBeLessThan(output.indexOf('**History**'));
    expect(output).toContain('- [[Project — Canonical]]');
    expect(output).toContain('- [[Project — Paused]]');
    expect(output).toContain('- [[Project — Legacy]] → [[Project — Canonical]]');
    expect(output).toContain('</details>');
  });

  it('renders a replaced stale-active page only in history', () => {
    // Given
    const target = catalogPage('target', 'Project — Target', 'active');
    const stale = {
      ...catalogPage('stale', 'Project — Stale Active', 'active'),
      wiki_replaced_by: { id: target.id, title: target.title },
    } satisfies WikiCatalogPage;

    // When
    const output = renderSubPages(digestWith([stale, target]));

    // Then
    const active = output.slice(0, output.indexOf('**History**'));
    expect(active).not.toContain('Project — Stale Active');
    expect(output).toContain('- [[Project — Stale Active]] → [[Project — Target]]');
  });
});

describe('sanitized filenames (title != filename)', () => {
  it('aliases meeting links so they resolve in Obsidian', () => {
    // `/` is filename-illegal, so the file on disk is "Sync w- Kira Del Mar".
    const upcoming: EvidenceMeeting[] = [{
      id: 'm3', title: 'Sync w/ Kira Del Mar', file_path: 'Meetings/Sync w- Kira Del Mar.md',
      date: '2026-08-01', file_mtime: 1, content_hash: null, attendees: [], project_count: 1,
    }];
    expect(renderMeetings({ recent: [], upcoming }))
      .toContain('- [[Sync w- Kira Del Mar|Sync w/ Kira Del Mar]] — 2026-08-01');
  });

  it('aliases note links so they resolve in Obsidian', () => {
    const notes: DigestNode[] = [{
      id: 'n2', title: 'Maps / Tile-Cache Layout — Design Spec',
      file_path: 'Notes/Maps - Tile-Cache Layout — Design Spec.md', file_mtime: 1, content_hash: null,
    }];
    expect(renderNotes(notes))
      .toBe('- [[Maps - Tile-Cache Layout — Design Spec|Maps / Tile-Cache Layout — Design Spec]]');
  });

  it('leaves healthy titles as plain links (no churn)', () => {
    const notes: DigestNode[] = [{ id: 'n3', title: 'Plain Note', file_path: 'Notes/Plain Note.md', file_mtime: 1, content_hash: null }];
    expect(renderNotes(notes)).toBe('- [[Plain Note]]');
  });
});

function catalogPage(id: string, title: string, wikiState: WikiCatalogPage['wiki_state']): WikiCatalogPage {
  return {
    id,
    title,
    file_path: `Wikis/${title}.md`,
    version: 1,
    content_hash: id,
    wiki_state: wikiState,
    wiki_origin: 'automatic',
    wiki_pinned: false,
  };
}

function digestWith(subpages: readonly WikiCatalogPage[]): ProjectDigest {
  return {
    project: { id: 'project', title: 'Project', file_path: 'Project.md' },
    config_used: DEFAULT_WIKI_CONFIG,
    windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
    tasks: { open: [], blocked: [], overdue: [], upcoming: [], done_recent: [], backlog: [] },
    notes: [],
    signals: { overdue_count: 0, blocked_count: 0, stale: [], hot: [], churn_rate: 0 },
    neighborhood: { incoming: {}, outgoing: {} },
    existing_wiki: {
      home_id: 'home',
      home: { id: 'home', version: 1 },
      topology_hash: computeWikiTopologyHash(subpages),
      catalog_valid: true,
      subpages: [...subpages],
    },
    synthesis_hints: {
      top_task_ids: [],
      top_note_ids: [],
      stale_task_ids: [],
      overdue_task_ids: [],
      recently_done_ids: [],
      suggested_reads: [],
    },
    generated_at: '2026-08-13T00:00:00.000Z',
  };
}
