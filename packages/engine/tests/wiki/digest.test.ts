import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { buildProjectDigest, resolveProject } from '../../src/wiki/digest.js';
import { setStoredSettings } from '../../src/settings/store.js';

describe('buildProjectDigest', () => {
  it('resolves exact IDs but rejects ambiguous title-only project references', () => {
    // A single OR query can return whichever duplicate-title row SQLite visits first.
    const db = createTestDb();
    const projectId = 'orchard-project';
    seedNode(db, 'orchard-page', 'Wikis/Orchard Pilot Project.md', 'Orchard Pilot Project', 1, ['wiki']);
    seedNode(db, projectId, 'Meetings/Orchard Pilot Project.md', 'Orchard Pilot Project', 1, ['project']);
    seedNode(db, 'orchard-home', 'Wikis/Orchard Pilot Project Wiki.md', 'Orchard Pilot Project Wiki', 1, ['wiki']);
    rel(db, 'orchard-home', 'Meetings/Orchard Pilot Project.md', 'wiki_for', projectId);
    rel(db, 'orchard-page', 'Meetings/Orchard Pilot Project.md', 'wiki_for', projectId);
    rel(db, 'orchard-page', 'Orchard Pilot Project Wiki', 'wiki_parent', 'orchard-home');

    expect(resolveProject(db, projectId)?.id).toBe(projectId);
    expect(resolveProject(db, 'Orchard Pilot Project')).toBeNull();
  });

  it('discovers associated tasks, notes, signals, and existing wiki', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedNode(db, 't1', 'Task.md', 'Task', now, ['task']);
    seedNode(db, 't2', 'Backlog.md', 'Backlog', now - 1000, ['task']);
    seedNode(db, 't3', 'Done.md', 'Done', now, ['task']);
    seedNode(db, 'n1', 'Note.md', 'Note', now - 40 * 86400000, ['note']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', now, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project - Theme.md', 'Project - Theme', now, ['wiki']);
    field(db, 't1', 'status', 'blocked');
    field(db, 't1', 'due', '2026-05-20');
    field(db, 't2', 'status', 'backlog');
    field(db, 't3', 'status', 'done');
    rel(db, 't1', 'Project', 'project', 'p1');
    rel(db, 't2', 'Project', 'project', 'p1');
    rel(db, 't3', 'Project', 'project', 'p1');
    rel(db, 'n1', 'Project', 'wiki-link', 'p1');
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project Wiki', 'wiki_parent', 'w1');

    const digest = buildProjectDigest(db, { project: 'Project', stale_days: 30 });
    expect(digest.project.id).toBe('p1');
    expect(digest.tasks.blocked.map(t => t.id)).toEqual(['t1']);
    expect(digest.tasks.overdue.map(t => t.id)).toEqual(['t1']);
    expect(digest.tasks.open.map(t => t.id)).toEqual(['t1']);
    expect(digest.tasks.backlog.map(t => t.id)).toEqual(['t2']);
    expect(digest.notes.map(n => n.id)).toEqual(['n1']);
    expect(digest.signals.stale.map(n => n.id)).toContain('n1');
    expect(digest.existing_wiki.home_id).toBe('w1');
    expect(digest.existing_wiki.subpages.map(s => s.id)).toEqual(['s1']);
    expect(digest.synthesis_hints.overdue_task_ids).toEqual(['t1']);
    // top_task_ids is actionable work only — the done task t3 is excluded here
    // and surfaced separately in recently_done_ids.
    expect(digest.tasks.done_recent.map(t => t.id)).toEqual(['t3']);
    expect(digest.synthesis_hints.top_task_ids).toEqual(['t1', 't2']);
    expect(digest.synthesis_hints.recently_done_ids).toEqual(['t3']);
    expect(digest.synthesis_hints.top_note_ids).toEqual(['n1']);
    expect(digest.synthesis_hints.suggested_reads).toEqual([
      { id: 'p1', title: 'Project', reason: 'Project root; read first for canonical project context.' },
      { id: 'w1', title: 'Project Wiki', reason: 'Existing wiki home; preserve useful human or managed narrative.' },
      { id: 's1', title: 'Project - Theme', reason: 'Existing wiki sub-page; check whether this theme belongs in the home narrative or should stay separate.' },
      { id: 't1', title: 'Task', reason: 'Overdue task; likely immediate risk or missed commitment.' },
      { id: 'n1', title: 'Note', reason: 'Recent associated note; likely current evidence for synthesis.' },
    ]);
  });
  it('leaves the root\'s own wiki pages out of the related neighbourhood, and keeps other wikis\' (#724)', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'dana', 'People/Dana Whitfield.md', 'Dana Whitfield', now, ['person']);
    seedNode(db, 'home', 'Wikis/Dana Whitfield Dossier.md', 'Dana Whitfield Dossier', now, ['wiki']);
    seedNode(db, 'sub', 'Wikis/Dana Whitfield - Deals.md', 'Dana Whitfield - Deals', now, ['wiki']);
    seedNode(db, 'other', 'Wikis/Northwind Dossier.md', 'Northwind Dossier', now, ['wiki']);
    seedNode(db, 'meet', 'Meetings/Kickoff call.md', 'Kickoff call', now, ['meeting']);
    rel(db, 'home', 'People/Dana Whitfield.md', 'wiki_for', 'dana');
    rel(db, 'home', 'Dana Whitfield', 'wiki-link', 'dana');
    rel(db, 'sub', 'People/Dana Whitfield.md', 'wiki_for', 'dana');
    rel(db, 'sub', 'Dana Whitfield', 'wiki-link', 'dana');
    rel(db, 'other', 'Dana Whitfield', 'wiki-link', 'dana');
    rel(db, 'meet', 'Dana Whitfield', 'people involved', 'dana');
    rel(db, 'dana', 'Dana Whitfield Dossier', 'wiki-link', 'home');

    const digest = buildProjectDigest(db, { project: 'dana' });
    const ids = (groups: Record<string, Array<{ id: string }>>) => Object.values(groups).flat().map(n => n.id).sort();
    expect(ids(digest.neighborhood.incoming)).toEqual(['meet', 'other']);
    expect(ids(digest.neighborhood.outgoing)).toEqual([]);
  });

  it('leaves wiki pages out of the hot and stale signals, so a wiki write is not project churn (#547)', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedNode(db, 'n1', 'Note.md', 'Note', now, ['note']);
    seedNode(db, 'n2', 'Old.md', 'Old', now - 40 * 86400000, ['note']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', now, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project - Theme.md', 'Project - Theme', now - 40 * 86400000, ['wiki']);
    for (const id of ['n1', 'n2']) rel(db, id, 'Project', 'wiki-link', 'p1');
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project Wiki', 'wiki_parent', 'w1');

    const digest = buildProjectDigest(db, { project: 'Project', stale_days: 30 });

    expect(digest.signals.hot.map(n => n.id)).toEqual(['n1']);
    expect(digest.signals.churn_rate).toBe(1);
    expect(digest.signals.stale.map(n => n.id)).toEqual(['n2']);
    expect(digest.existing_wiki.home_id).toBe('w1');
  });
  it('reads kinds, fields and status values from the vault map, and none turns them off', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['initiative']);
    seedNode(db, 't1', 'Task.md', 'Task', now, ['todo']);
    seedNode(db, 't2', 'Closed.md', 'Closed', now, ['todo']);
    seedNode(db, 'n1', 'Note.md', 'Note', now, ['note']);
    field(db, 't1', 'state', 'stuck');
    field(db, 't1', 'due', '2026-05-20');
    field(db, 't2', 'state', 'closed');
    for (const id of ['t1', 't2', 'n1']) rel(db, id, 'Project', 'project', 'p1');
    setStoredSettings(db, 'vault', {
      projectType: 'initiative', taskType: 'todo', taskStatusField: 'state',
      taskBlockedStatuses: ['stuck'], taskDoneStatuses: ['closed'],
    });
    const digest = buildProjectDigest(db, { project: 'Project' });
    expect(digest.tasks.blocked.map(t => t.id)).toEqual(['t1']);
    expect(digest.tasks.done_recent.map(t => t.id)).toEqual(['t2']);
    expect(digest.notes.map(n => n.id)).toEqual(['n1']);

    // No due field: no overdue tasks. No task kind: no tasks, and the former task
    // notes count as ordinary notes.
    setStoredSettings(db, 'vault', { projectType: 'initiative', taskType: 'todo', taskStatusField: 'state', dueField: null });
    expect(buildProjectDigest(db, { project: 'Project' }).tasks.overdue).toEqual([]);
    setStoredSettings(db, 'vault', { projectType: 'initiative', taskType: null });
    const off = buildProjectDigest(db, { project: 'Project' });
    expect(Object.values(off.tasks).flat()).toEqual([]);
    expect(off.notes.map(n => n.id).sort()).toEqual(['n1', 't1', 't2']);
  });

  it('counts the projects each note is filed under, as a project\'s memory set ranks them (#474)', () => {
    const db = createTestDb();
    const now = Date.now();
    seedNode(db, 'p1', 'Projects/Alpha.md', 'Project Alpha', now, ['project']);
    seedNode(db, 'p2', 'Projects/Beta.md', 'Project Beta', now, ['project']);
    seedNode(db, 'p3', 'Projects/Gamma.md', 'Project Gamma', now, ['project']);
    seedNode(db, 'acme', 'Companies/Acme.md', 'Acme', now, ['company']);
    seedNode(db, 'n1', 'Notes/Alpha kickoff.md', 'Alpha kickoff', now - 2000, ['note']);
    seedNode(db, 'n2', 'Notes/Weekly summary.md', 'Weekly summary', now - 1000, ['note']);
    // n1: Alpha by a field and again in its body (one project), plus a company (not a project).
    rel(db, 'n1', 'Project Alpha', 'project', 'p1');
    rel(db, 'n1', 'Project Alpha', 'wiki-link', 'p1');
    rel(db, 'n1', 'Acme', 'company', 'acme');
    // n2: a summary filed under all three, and an unresolved link that names no project.
    for (const [title, id] of [['Project Alpha', 'p1'], ['Project Beta', 'p2'], ['Project Gamma', 'p3']]) {
      rel(db, 'n2', title, 'project', id);
    }
    rel(db, 'n2', 'Missing note', 'wiki-link', null);

    const counts = () => Object.fromEntries(buildProjectDigest(db, { project: 'p1' }).notes.map(n => [n.id, n.project_count]));
    expect(counts()).toEqual({ n1: 1, n2: 3 });

    // No project kind (none): nothing is filed under a project, so every count is 0.
    setStoredSettings(db, 'vault', { projectType: null });
    expect(counts()).toEqual({ n1: 0, n2: 0 });
  });

  it('surfaces wiki_state on sub-pages and defaults legacy absence to active', () => {
    const db = createTestDb();
    seedNode(db, 'p1', 'Project.md', 'Project', 1, ['project']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', 1, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project — Retired.md', 'Project — Retired', 1, ['wiki']);
    seedNode(db, 's2', 'Wikis/Project — Live.md', 'Project — Live', 1, ['wiki']);
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project', 'wiki_for', 'p1');
    rel(db, 's1', 'Project Wiki', 'wiki_parent', 'w1');
    rel(db, 's2', 'Project', 'wiki_for', 'p1');
    rel(db, 's2', 'Project Wiki', 'wiki_parent', 'w1');
    field(db, 's1', 'wiki_state', 'retired');

    const digest = buildProjectDigest(db, { project: 'p1' });
    const byId = Object.fromEntries(digest.existing_wiki.subpages.map(s => [s.id, s.wiki_state]));
    expect(byId.s1).toBe('retired');
    expect(byId.s2).toBe('active');
  });

  it('projects the complete catalog without collapsing same-kind pages', () => {
    const db = createTestDb();
    seedNode(db, 'p1', 'Project.md', 'Project', 1, ['project']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', 1, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project — Alpha.md', 'Project — Alpha', 1, ['wiki']);
    seedNode(db, 's2', 'Wikis/Project — Beta.md', 'Project — Beta', 1, ['wiki']);
    seedNode(db, 's3', 'Wikis/Project — Legacy.md', 'Project — Legacy', 1, ['wiki']);
    db.prepare('UPDATE nodes SET version = 7 WHERE id = ?').run('w1');
    db.prepare('UPDATE nodes SET version = 3, body = ? WHERE id = ?').run([
      'Human introduction',
      '<!-- ve:managed:Status -->',
      'Dormant',
      '<!-- /ve:managed:Status -->',
      '<!-- ve:managed:Summary -->',
      'S'.repeat(1300),
      '<!-- /ve:managed:Summary -->',
      '<!-- ve:managed:Log -->',
      'private log',
      '<!-- /ve:managed:Log -->',
      'Human outro',
    ].join('\n'), 's1');
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    for (const id of ['s1', 's2', 's3']) {
      rel(db, id, 'Project', 'wiki_for', 'p1');
      rel(db, id, 'Project Wiki', 'wiki_parent', 'w1');
    }
    field(db, 'w1', 'wiki_evidence_hash', 'evidence-1');
    field(db, 'w1', 'wiki_topology_hash', 'topology-1');
    field(db, 'w1', 'wiki_curated_at', '2026-08-13T12:00:00.000Z');
    field(db, 'w1', 'wiki_reconcile_key', '{"v":1,"key":"run-1"}');
    for (const id of ['s1', 's2']) {
      field(db, id, 'wiki_kind', 'workstream');
      field(db, id, 'wiki_origin', 'requested');
    }
    field(db, 's1', 'wiki_state', 'dormant');
    field(db, 's1', 'wiki_scope', '{"v":1,"subject":" Project ","facet":" Alpha "}');
    fieldNumber(db, 's1', 'wiki_pinned', 1);
    field(db, 's1', 'wiki_replaced_by', 'Project — Beta');
    rel(db, 's1', 'Project — Beta', 'wiki_replaced_by', 's2');
    const invalidScope = '{"v":2,"subject":"Project","facet":"Beta"}';
    field(db, 's2', 'wiki_scope', invalidScope);
    field(db, 's2', 'wiki_replaced_by', 'Missing Page');
    rel(db, 's2', 'Missing Page', 'wiki_replaced_by', null);

    const catalog = buildProjectDigest(db, { project: 'p1' }).existing_wiki;

    expect(catalog.home).toEqual({
      id: 'w1',
      version: 7,
      wiki_evidence_hash: 'evidence-1',
      wiki_topology_hash: 'topology-1',
      wiki_curated_at: '2026-08-13T12:00:00.000Z',
      wiki_reconcile_key: '{"v":1,"key":"run-1"}',
    });
    expect(catalog.topology_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.subpages.filter(page => page.wiki_kind === 'workstream')).toHaveLength(2);
    const alpha = catalog.subpages.find(page => page.id === 's1');
    expect(alpha).toMatchObject({
      id: 's1',
      title: 'Project — Alpha',
      file_path: 'Wikis/Project — Alpha.md',
      version: 3,
      content_hash: 's1',
      wiki_state: 'dormant',
      wiki_kind: 'workstream',
      wiki_origin: 'requested',
      wiki_scope: { v: 1, subject: 'Project', facet: 'Alpha' },
      wiki_replaced_by: { id: 's2', title: 'Project — Beta' },
      wiki_pinned: true,
    });
    expect(alpha?.summary).toBe('S'.repeat(1200));
    expect(alpha?.summary).not.toContain('Dormant');
    expect(alpha?.summary).not.toContain('private log');
    expect(alpha?.summary).not.toContain('Human');
    const beta = catalog.subpages.find(page => page.id === 's2');
    expect(beta).toMatchObject({
      wiki_scope_raw: invalidScope,
      wiki_scope_error: 'UNSUPPORTED_VERSION',
      wiki_replaced_by: { title: 'Missing Page' },
      wiki_pinned: false,
    });
    expect(beta?.wiki_replaced_by?.id).toBeUndefined();
    expect(catalog.catalog_valid).toBe(false);
    expect(catalog.subpages.find(page => page.id === 's3')).toMatchObject({
      wiki_state: 'active',
      wiki_origin: 'automatic',
      wiki_pinned: false,
    });
  });

  it('reads wiki_pinned from value_json boolean storage (true)', () => {
    const db = createTestDb();
    // Minimal fixture: project, home wiki, and one subpage
    seedNode(db, 'p1', 'Project.md', 'Project', 1, ['project']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', 1, ['wiki']);
    seedNode(db, 's1', 'Wikis/Project — Alpha.md', 'Project — Alpha', 1, ['wiki']);
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    for (const id of ['s1']) {
      rel(db, id, 'Project', 'wiki_for', 'p1');
      rel(db, id, 'Project Wiki', 'wiki_parent', 'w1');
    }
    // Write wiki_pinned via value_json (true)
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, 'wiki_pinned', ?, 'frontmatter')").run('s1', JSON.stringify(true));

    const catalog = buildProjectDigest(db, { project: 'p1' }).existing_wiki;
    const alpha = catalog.subpages.find(page => page.id === 's1');
    expect(alpha).toBeDefined();
    expect(alpha?.wiki_pinned).toBe(true);
  });

  it('returns all 101 catalog rows without page-count truncation', () => {
    const db = createTestDb();
    seedNode(db, 'p1', 'Project.md', 'Project', 1, ['project']);
    seedNode(db, 'w1', 'Wikis/Project Wiki.md', 'Project Wiki', 1, ['wiki']);
    rel(db, 'w1', 'Project', 'wiki_for', 'p1');
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const id = `s-${suffix}`;
      seedNode(db, id, `Wikis/Page ${suffix}.md`, `Page ${suffix}`, index, ['wiki']);
      rel(db, id, 'Project', 'wiki_for', 'p1');
      rel(db, id, 'Project Wiki', 'wiki_parent', 'w1');
    }

    const pages = buildProjectDigest(db, { project: 'p1' }).existing_wiki.subpages;

    expect(pages).toHaveLength(101);
    expect(pages.at(-1)?.id).toBe('s-100');
  });
});

function seedNode(db: ReturnType<typeof createTestDb>, id: string, path: string, title: string, mtime: number, types: string[]): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, path, title, '', id, mtime, mtime);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

function field(db: ReturnType<typeof createTestDb>, nodeId: string, name: string, value: string): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function fieldNumber(db: ReturnType<typeof createTestDb>, nodeId: string, name: string, value: number): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_number, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function rel(db: ReturnType<typeof createTestDb>, source: string, target: string, type: string, resolved: string | null): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}
