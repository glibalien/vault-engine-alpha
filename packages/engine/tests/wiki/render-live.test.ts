import { describe, expect, it } from 'vitest';
import { renderLiveSections, renderSubPages } from '../../src/wiki/render-live.js';
import type { ProjectDigest, WikiCatalogPage, WikiState } from '../../src/wiki/digest.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { computeWikiTopologyHash } from '../../src/wiki/topology.js';

type SubpageFixture = Pick<WikiCatalogPage, 'id' | 'title' | 'file_path'> & { readonly wiki_state?: WikiState };

function catalogPage(page: SubpageFixture): WikiCatalogPage {
  return {
    ...page,
    version: 1,
    content_hash: page.id,
    wiki_state: page.wiki_state ?? 'active',
    wiki_origin: 'automatic',
    wiki_pinned: false,
  };
}

describe('renderLiveSections', () => {
  it('renders grouped wikilink bullets without checkboxes or tables', () => {
    const digest: ProjectDigest = {
      project: { id: 'p1', title: 'Project', file_path: 'Project.md' },
      config_used: DEFAULT_WIKI_CONFIG,
      windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
      tasks: {
        open: [{ id: 't1', title: 'Open Task', file_path: 'Open Task.md', file_mtime: 1, content_hash: null, status: 'open', due: null }],
        blocked: [],
        overdue: [{ id: 't2', title: 'Late Task', file_path: 'Late Task.md', file_mtime: 2, content_hash: null, status: 'blocked', due: '2026-05-20' }],
        upcoming: [],
        done_recent: [],
        backlog: [],
      },
      notes: [],
      signals: { overdue_count: 1, blocked_count: 0, stale: [], hot: [], churn_rate: 0 },
      neighborhood: {
        incoming: { 'wiki-link': [{ id: 'n1', title: 'Note', file_path: 'Note.md', file_mtime: 1, content_hash: null }] },
        outgoing: {},
      },
      existing_wiki: {
        home_id: 'w1',
        home: { id: 'w1', version: 1 },
        topology_hash: computeWikiTopologyHash([catalogPage({ id: 's1', title: 'Project - Theme', file_path: 'Wikis/Project - Theme.md' })]),
        catalog_valid: true,
        subpages: [catalogPage({ id: 's1', title: 'Project - Theme', file_path: 'Wikis/Project - Theme.md' })],
      },
      synthesis_hints: {
        top_task_ids: [],
        top_note_ids: [],
        stale_task_ids: [],
        overdue_task_ids: [],
        recently_done_ids: [],
        suggested_reads: [],
      },
      generated_at: '2026-05-25T00:00:00.000Z',
    };
    const live = renderLiveSections(digest);
    expect(live.tasks).toContain('**Overdue (1)**');
    expect(live.tasks).toContain('- [[Late Task]] — due 2026-05-20 · blocked');
    expect(live.related).toContain('- [[Note]]');
    expect(live['sub-pages']).toBe('- [[Project - Theme]]');
    expect(Object.values(live).join('\n')).not.toContain('|');
    expect(Object.values(live).join('\n')).not.toContain('- [ ]');
  });

  it('caps live task groups and evidence links from config', () => {
    const digest: ProjectDigest = {
      project: { id: 'p1', title: 'Project', file_path: 'Project.md' },
      config_used: { ...DEFAULT_WIKI_CONFIG, liveTaskGroupCap: 1, liveRelatedCap: 1 },
      windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
      tasks: {
        open: [
          { id: 't1', title: 'First', file_path: 'First.md', file_mtime: 1, content_hash: null, status: 'open', due: null },
          { id: 't2', title: 'Second', file_path: 'Second.md', file_mtime: 1, content_hash: null, status: 'open', due: null },
        ],
        blocked: [],
        overdue: [],
        upcoming: [],
        done_recent: [],
        backlog: [],
      },
      notes: [],
      signals: { overdue_count: 0, blocked_count: 0, stale: [], hot: [], churn_rate: 0 },
      neighborhood: {
        incoming: {
          'wiki-link': [
            { id: 'n1', title: 'First Note', file_path: 'First Note.md', file_mtime: 1, content_hash: null },
            { id: 'n2', title: 'Second Note', file_path: 'Second Note.md', file_mtime: 1, content_hash: null },
          ],
        },
        outgoing: {},
      },
      existing_wiki: {
        home_id: null,
        home: null,
        topology_hash: computeWikiTopologyHash([]),
        catalog_valid: true,
        subpages: [],
      },
      synthesis_hints: {
        top_task_ids: [],
        top_note_ids: [],
        stale_task_ids: [],
        overdue_task_ids: [],
        recently_done_ids: [],
        suggested_reads: [],
      },
      generated_at: '2026-05-25T00:00:00.000Z',
    };

    const live = renderLiveSections(digest);
    // Label reflects what is actually shown after the cap, not the full count.
    expect(live.tasks).toContain('**Open (1 of 2)**');
    expect(live.tasks).toContain('[[First]]');
    expect(live.tasks).not.toContain('[[Second]]');
    expect(live.related).toContain('[[First Note]]');
    expect(live.related).not.toContain('[[Second Note]]');
  });
});

describe('renderSubPages wiki_state grouping', () => {
  function digestWith(subpages: SubpageFixture[]): ProjectDigest {
    const pages = subpages.map(catalogPage);
    return {
      project: { id: 'p1', title: 'Project', file_path: 'Project.md' },
      config_used: DEFAULT_WIKI_CONFIG,
      windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
      tasks: { open: [], blocked: [], overdue: [], upcoming: [], done_recent: [], backlog: [] },
      notes: [],
      signals: { overdue_count: 0, blocked_count: 0, stale: [], hot: [], churn_rate: 0 },
      neighborhood: { incoming: {}, outgoing: {} },
      existing_wiki: {
        home_id: 'w1', home: { id: 'w1', version: 1 },
        topology_hash: computeWikiTopologyHash(pages), catalog_valid: true, subpages: pages,
      },
      synthesis_hints: {
        top_task_ids: [], top_note_ids: [], stale_task_ids: [],
        overdue_task_ids: [], recently_done_ids: [], suggested_reads: [],
      },
      generated_at: '2026-06-06T00:00:00.000Z',
    };
  }

  it('renders a flat list when nothing is retired or dormant', () => {
    const out = renderSubPages(digestWith([
      { id: 's1', title: 'Project — Task Board', file_path: 'Wikis/Project — Task Board.md' },
      { id: 's2', title: 'Project — Contacts', file_path: 'Wikis/Project — Contacts.md', wiki_state: 'active' },
    ]));
    expect(out).toBe('- [[Project — Contacts]]\n- [[Project — Task Board]]');
    expect(out).not.toContain('**Active workstreams**');
  });

  it('splits active, dormant, and retired pages into three tiers', () => {
    const out = renderSubPages(digestWith([
      { id: 's1', title: 'Project — Task Board', file_path: 'Wikis/Project — Task Board.md', wiki_state: 'active' },
      { id: 's2', title: 'Project — ID Check Pilot', file_path: 'Wikis/Project — ID Check Pilot.md', wiki_state: 'retired' },
      { id: 's3', title: 'Project — Old Theme', file_path: 'Wikis/Project — Old Theme.md', wiki_state: 'dormant' },
    ]));
    expect(out).toBe(
      '**Active pages**\n' +
      '- [[Project — Task Board]]\n' +
      '\n' +
      '<details>\n' +
      '<summary>Dormant (1)</summary>\n' +
      '\n' +
      '- [[Project — Old Theme]]\n' +
      '\n' +
      '</details>\n' +
      '\n' +
      '**History**\n' +
      '- [[Project — ID Check Pilot]]'
    );
  });

  it('treats unknown wiki_state as active', () => {
    const out = renderSubPages(digestWith([
      { id: 's1', title: 'Project — Weird', file_path: 'Wikis/Project — Weird.md', wiki_state: 'bogus' as WikiState },
    ]));
    expect(out).toBe('- [[Project — Weird]]');
  });
});

describe('renderSubPages with sanitized filenames (regression: broken wiki sub-page links)', () => {
  function digestWith(subpages: SubpageFixture[]): ProjectDigest {
    const pages = subpages.map(catalogPage);
    return {
      project: { id: 'p1', title: 'North-South Rail Link', file_path: 'Topics/North-South Rail Link.md' },
      config_used: DEFAULT_WIKI_CONFIG,
      windows: { today: '2026-05-25', time_zone: 'UTC', stale_days: 30, upcoming_days: 14, recent_days: 7 },
      tasks: { open: [], blocked: [], overdue: [], upcoming: [], done_recent: [], backlog: [] },
      notes: [],
      signals: { overdue_count: 0, blocked_count: 0, stale: [], hot: [], churn_rate: 0 },
      neighborhood: { incoming: {}, outgoing: {} },
      existing_wiki: {
        home_id: 'w1', home: { id: 'w1', version: 1 },
        topology_hash: computeWikiTopologyHash(pages), catalog_valid: true, subpages: pages,
      },
      synthesis_hints: {
        top_task_ids: [], top_note_ids: [], stale_task_ids: [],
        overdue_task_ids: [], recently_done_ids: [], suggested_reads: [],
      },
      generated_at: '2026-08-03T00:00:00.000Z',
    };
  }

  it('emits [[basename|title]] for a colon-titled sub-page so Obsidian resolves it', () => {
    const out = renderSubPages(digestWith([{
      id: 's1',
      title: 'North-South Rail Link — 2023 Route Survey: Planning & Lessons',
      file_path: 'Wikis/North-South Rail Link — 2023 Route Survey- Planning & Lessons.md',
    }]));
    expect(out).toBe('- [[North-South Rail Link — 2023 Route Survey- Planning & Lessons|North-South Rail Link — 2023 Route Survey: Planning & Lessons]]');
  });

  it('leaves sub-pages whose title matches their filename untouched', () => {
    const out = renderSubPages(digestWith([{
      id: 's2',
      title: 'North-South Rail Link — Rolling Stock Shortage',
      file_path: 'Wikis/North-South Rail Link — Rolling Stock Shortage.md',
    }]));
    expect(out).toBe('- [[North-South Rail Link — Rolling Stock Shortage]]');
  });

  it('also repairs a title that drifted from its filename by a rename', () => {
    const out = renderSubPages(digestWith([{
      id: 's3',
      title: 'Vault Curator Wiki',
      file_path: 'Wikis/Vault Curator Enhancements Wiki.md',
    }]));
    expect(out).toBe('- [[Vault Curator Enhancements Wiki|Vault Curator Wiki]]');
  });
});
