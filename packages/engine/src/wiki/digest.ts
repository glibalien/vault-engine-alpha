// allow: SIZE_OK — cohesive project-digest projection; splitting its SQL helpers would obscure one read contract.
import { notSuiteNoteSql } from '../notes/suite-notes.js';
import { createFieldMap } from '../fields/field-map.js';
import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import { resolveFieldValue, type FieldRow } from '../mcp/field-value.js';
import { getWikiConfig, type WikiConfig } from './config.js';
import { parseWikiScope, type WikiScopeErrorCode, type WikiScopeV1 } from './scope.js';
import { extractManagedSection } from './sections.js';
import { addCalendarDays, calendarDate, wikiTimeZone } from './today.js';
import { computeWikiTopologyHash } from './topology.js';

export const SUMMARY_EXTRACT_MAX_CHARS = 1200;

const DAY_MS = 86_400_000;

export type ThemedPageKind =
  | 'workstream'
  | 'decision-log'
  | 'risk-register'
  | 'timeline'
  | 'stakeholder-map'
  | 'spotlight'
  | 'freeform';

export type WikiState = 'active' | 'dormant' | 'retired';
export type WikiOrigin = 'automatic' | 'requested';

export interface WikiCatalogHome {
  readonly id: string;
  readonly version: number;
  readonly wiki_evidence_hash?: string;
  readonly wiki_topology_hash?: string;
  readonly wiki_curated_at?: string;
  readonly wiki_reconcile_key?: string;
}

export interface WikiCatalogPage {
  readonly id: string;
  readonly title: string;
  readonly file_path: string;
  readonly version: number;
  readonly content_hash: string;
  readonly wiki_state: WikiState;
  readonly wiki_kind?: ThemedPageKind;
  readonly wiki_origin: WikiOrigin;
  readonly wiki_scope?: WikiScopeV1;
  readonly wiki_scope_raw?: string;
  readonly wiki_scope_error?: WikiScopeErrorCode;
  readonly wiki_replaced_by?: { readonly id?: string; readonly title: string };
  readonly wiki_pinned: boolean;
  readonly summary?: string;
}

export interface DigestProject {
  id: string;
  title: string;
  file_path: string;
}

export type ProjectReferenceResult =
  | { readonly ok: true; readonly project: DigestProject }
  | {
      readonly ok: false;
      readonly code: 'PROJECT_NOT_FOUND' | 'PROJECT_ID_MISMATCH' | 'AMBIGUOUS_PROJECT';
    };

export interface DigestNode {
  id: string;
  title: string;
  file_path: string;
  file_mtime: number | null;
  content_hash: string | null;
}

/**
 * A note in the digest's `notes` list, with how many projects it is filed under (#474): the
 * distinct nodes of the wiki project kind it links to, from a field or its body, itself left out.
 * That is the count `list-memories project_of` ranks a project's memory set by (#414, #551), and
 * the projects `filedProjects` lists for an ordinary note. A note filed under one project is
 * about it; one filed under eight is a broad summary. 0 when the vault map has no project kind.
 * Not part of `evidence_hash`.
 */
export interface DigestNote extends DigestNode {
  project_count: number;
}

export interface DigestTask extends DigestNode {
  status: string | null;
  due: string | null;
}

export interface ProjectDigestOptions {
  project: string;
  include_neighborhood?: boolean;
  task_limit?: number;
  note_limit?: number;
  /** Overrides the `staleDays` wiki setting. */
  stale_days?: number;
  /** Overrides the `upcomingDays` wiki setting. */
  upcoming_days?: number;
  rel_type?: string;
}

/** The day and windows the task buckets and signals were cut with. */
export interface DigestWindows {
  /** Today's date (YYYY-MM-DD) in `time_zone`; overdue is due before it, upcoming due from it. */
  today: string;
  /** IANA zone `today` was taken in: Curator's `tz` setting, else the Engine host's zone. */
  time_zone: string;
  /** Linked notes and tasks unchanged for this many days are in `signals.stale`. */
  stale_days: number;
  /** Open tasks due from today through today + this many days are upcoming. */
  upcoming_days: number;
  /** Done tasks changed within this many days are recently done; linked nodes changed within it are `signals.hot`. */
  recent_days: number;
}

export interface ProjectDigest {
  project: DigestProject;
  config_used: WikiConfig;
  windows: DigestWindows;
  tasks: {
    open: DigestTask[];
    blocked: DigestTask[];
    overdue: DigestTask[];
    upcoming: DigestTask[];
    done_recent: DigestTask[];
    backlog: DigestTask[];
  };
  notes: DigestNote[];
  signals: {
    overdue_count: number;
    blocked_count: number;
    stale: DigestNode[];
    hot: DigestNode[];
    churn_rate: number;
  };
  neighborhood: {
    outgoing: Record<string, DigestNode[]>;
    incoming: Record<string, DigestNode[]>;
  };
  existing_wiki: {
    home_id: string | null;
    home: WikiCatalogHome | null;
    topology_hash: string;
    catalog_valid: boolean;
    subpages: WikiCatalogPage[];
  };
  synthesis_hints: {
    top_task_ids: string[];
    top_note_ids: string[];
    stale_task_ids: string[];
    overdue_task_ids: string[];
    recently_done_ids: string[];
    suggested_reads: Array<{ id: string; title: string; reason: string }>;
  };
  generated_at: string;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  file_mtime: number | null;
  content_hash: string | null;
}

interface WikiHomeRow {
  id: string;
  version: number;
  wiki_evidence_hash: string | null;
  wiki_topology_hash: string | null;
  wiki_curated_at: string | null;
  wiki_reconcile_key: string | null;
}

interface WikiCatalogRow {
  id: string;
  file_path: string;
  title: string | null;
  version: number;
  content_hash: string | null;
  body: string | null;
  wiki_state: WikiState | null;
  wiki_kind: ThemedPageKind | null;
  wiki_origin: WikiOrigin | null;
  wiki_scope_raw: string | null;
  wiki_replaced_by_title: string | null;
  wiki_replaced_by_id: string | null;
  // wiki_pinned storage representations (JSON, numeric, text, date)
  wiki_pinned_json: string | null;
  wiki_pinned_number: number | null;
  wiki_pinned_text: string | null;
  wiki_pinned_date: string | null;
}

export function resolveProject(db: Database.Database, project: string): DigestProject | null {
  const result = resolveProjectReference(db, project);
  return result.ok ? result.project : null;
}

export function resolveProjectReference(
  db: Database.Database,
  project: string,
  projectId?: string,
): ProjectReferenceResult {
  if (projectId !== undefined) {
    const row = findProjectBy(db, 'id', projectId);
    if (row === undefined) return { ok: false, code: 'PROJECT_NOT_FOUND' };
    const resolved = toDigestProject(row);
    if (project !== resolved.id && project !== resolved.file_path && project !== resolved.title) {
      return { ok: false, code: 'PROJECT_ID_MISMATCH' };
    }
    return { ok: true, project: resolved };
  }

  const byId = findProjectBy(db, 'id', project);
  if (byId !== undefined) return { ok: true, project: toDigestProject(byId) };
  const byPath = findProjectBy(db, 'file_path', project);
  if (byPath !== undefined) return { ok: true, project: toDigestProject(byPath) };
  const byTitle = db.prepare('SELECT id, file_path, title FROM nodes WHERE title = ? ORDER BY id')
    .all(project) as ProjectRow[];
  if (byTitle.length === 1) return { ok: true, project: toDigestProject(byTitle[0]) };
  if (byTitle.length > 1) return { ok: false, code: 'AMBIGUOUS_PROJECT' };
  return { ok: false, code: 'PROJECT_NOT_FOUND' };
}

type ProjectRow = { readonly id: string; readonly file_path: string; readonly title: string | null };

function findProjectBy(
  db: Database.Database,
  column: 'id' | 'file_path',
  value: string,
): ProjectRow | undefined {
  return db.prepare(`SELECT id, file_path, title FROM nodes WHERE ${column} = ?`).get(value) as ProjectRow | undefined;
}

function toDigestProject(row: ProjectRow): DigestProject {
  return { id: row.id, file_path: row.file_path, title: row.title ?? basename(row.file_path, '.md') };
}

export function buildProjectDigest(db: Database.Database, options: ProjectDigestOptions): ProjectDigest {
  const config = getWikiConfig(db);
  const project = resolveProject(db, options.project);
  if (!project) throw new Error('Project not found');

  const taskLimit = clampLimit(options.task_limit ?? 50);
  const noteLimit = clampLimit(options.note_limit ?? 50);
  const staleDays = options.stale_days ?? config.staleDays;
  const upcomingDays = options.upcoming_days ?? config.upcomingDays;
  const recentDays = config.recentDays;
  const now = Date.now();
  // Due dates are calendar dates, so "today" is the owner's date, not UTC's (#448).
  const timeZone = wikiTimeZone(db);
  const today = calendarDate(now, timeZone);
  const upcomingEnd = addCalendarDays(today, upcomingDays);
  const staleCutoff = now - staleDays * DAY_MS;
  const hotCutoff = now - recentDays * DAY_MS;

  const associatedTasks = fetchAssociatedTasks(db, project.id, config, taskLimit, options.rel_type);
  const notes = fetchAssociatedNotes(db, project.id, config, noteLimit, options.rel_type);
  const stale = fetchAssociatedNodesByMtime(db, project.id, config, staleCutoff, '<', noteLimit, options.rel_type);
  const hot = fetchAssociatedNodesByMtime(db, project.id, config, hotCutoff, '>=', noteLimit, options.rel_type);
  const neighborhood = options.include_neighborhood === false
    ? { outgoing: {}, incoming: {} }
    : fetchNeighborhood(db, project.id);
  const existing_wiki = fetchExistingWiki(db, project.id, config);

  const doneSet = new Set(config.taskDoneStatuses);
  const blockedSet = new Set(config.taskBlockedStatuses);
  const ignoredSet = new Set(config.taskIgnoredStatuses);
  const backlogSet = new Set(config.taskBacklogStatuses);
  const isVisibleTask = (task: DigestTask): boolean => !isDone(task.status, doneSet) && !isIgnored(task.status, ignoredSet);
  const isBacklogTask = (task: DigestTask): boolean => task.status !== null && backlogSet.has(task.status);
  const tasks = {
    open: associatedTasks.filter(t => isVisibleTask(t) && !isBacklogTask(t)).slice(0, taskLimit),
    blocked: associatedTasks.filter(t => t.status !== null && blockedSet.has(t.status) && !isIgnored(t.status, ignoredSet)).slice(0, taskLimit),
    overdue: associatedTasks.filter(t => t.due !== null && t.due < today && isVisibleTask(t)).slice(0, taskLimit),
    upcoming: associatedTasks.filter(t => t.due !== null && t.due >= today && t.due <= upcomingEnd && isVisibleTask(t)).slice(0, taskLimit),
    done_recent: associatedTasks.filter(t => isDone(t.status, doneSet) && (t.file_mtime ?? 0) >= hotCutoff).slice(0, taskLimit),
    backlog: associatedTasks.filter(t => isBacklogTask(t) && !isDone(t.status, doneSet) && !isIgnored(t.status, ignoredSet)).slice(0, taskLimit),
  };
  const synthesis_hints = buildSynthesisHints(db, project, tasks, notes, stale, existing_wiki);

  return {
    project,
    config_used: config,
    windows: {
      today,
      time_zone: timeZone,
      stale_days: staleDays,
      upcoming_days: upcomingDays,
      recent_days: recentDays,
    },
    tasks,
    notes,
    signals: {
      overdue_count: tasks.overdue.length,
      blocked_count: tasks.blocked.length,
      stale,
      hot,
      churn_rate: hot.length,
    },
    neighborhood,
    existing_wiki,
    synthesis_hints,
    generated_at: new Date(now).toISOString(),
  };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function isDone(status: string | null, doneSet: Set<string>): boolean {
  return status !== null && doneSet.has(status);
}

function isIgnored(status: string | null, ignoredSet: Set<string>): boolean {
  return status !== null && ignoredSet.has(status);
}

function fetchAssociatedTasks(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  limit: number,
  relType?: string,
): DigestTask[] {
  // No task kind (none): no tasks. No status or due field: tasks without them.
  if (config.taskType === null) return [];
  const { taskStatusField: statusField, dueField } = config;
  const rows = fetchAssociatedRows(db, projectId, {
    includeType: config.taskType,
    limit: limit * 4,
    relType,
  });
  return rows.map(row => {
    const fields = fetchFields(db, row.id, named([statusField, dueField]));
    return {
      id: row.id,
      file_path: row.file_path,
      title: row.title ?? basename(row.file_path, '.md'),
      file_mtime: row.file_mtime,
      content_hash: row.content_hash,
      status: statusField === null ? null : valueToString(fields[statusField]),
      due: dueField === null ? null : valueToDateString(fields[dueField]),
    };
  }).sort(compareTasks).slice(0, limit * 2);
}

function fetchAssociatedNotes(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  limit: number,
  relType?: string,
): DigestNote[] {
  const rows = fetchAssociatedRows(db, projectId, {
    excludeTypes: named([config.taskType, config.projectType, config.wikiType]),
    limit,
    relType,
  });
  const counts = projectCounts(db, rows.map(row => row.id), config.projectType);
  return rows.map(row => ({ ...toDigestNode(row), project_count: counts.get(row.id) ?? 0 }));
}

/**
 * Every note filed under the project that the digest's notes list draws from (the same rule, no
 * cap and no order), for the evidence hash (#332).
 */
export function associatedNoteIds(db: Database.Database, projectId: string, config: WikiConfig): string[] {
  return fetchAssociatedRows(db, projectId, {
    excludeTypes: named([config.taskType, config.projectType, config.wikiType]),
    limit: -1,
  }).map(row => row.id);
}

/**
 * How many projects each of `ids` is filed under (#474), in one query: the distinct nodes of
 * `projectType` it links to, from a field or its body, itself left out, as `list-memories
 * project_of` counts them. A node filed under none is missing from the map, and so is every node
 * when the vault map has no project kind (none).
 */
export function projectCounts(
  db: Database.Database,
  ids: readonly string[],
  projectType: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (projectType === null || ids.length === 0) return out;
  const rows = db.prepare(`
    SELECT r.source_id AS id, COUNT(DISTINCT r.resolved_target_id) AS project_count
    FROM relationships r
    JOIN node_types t ON t.node_id = r.resolved_target_id AND t.schema_type = ?
    WHERE r.source_id IN (${ids.map(() => '?').join(',')}) AND r.resolved_target_id != r.source_id
    GROUP BY r.source_id
  `).all(projectType, ...ids) as Array<{ id: string; project_count: number }>;
  for (const row of rows) out.set(row.id, row.project_count);
  return out;
}

/** The project's linked notes and tasks changed before or since `cutoff`. Wiki pages are left
 *  out: the wiki's own writes, a status stamp among them (#547), are not project activity. */
function fetchAssociatedNodesByMtime(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  cutoff: number,
  op: '<' | '>=',
  limit: number,
  relType?: string,
): DigestNode[] {
  return fetchAssociatedRows(db, projectId, {
    excludeTypes: named([config.projectType, config.wikiType]),
    mtimeOp: op,
    mtimeCutoff: cutoff,
    limit,
    relType,
  }).map(toDigestNode);
}

function fetchAssociatedRows(
  db: Database.Database,
  projectId: string,
  opts: {
    includeType?: string;
    excludeTypes?: string[];
    mtimeOp?: '<' | '>=';
    mtimeCutoff?: number;
    limit: number;
    relType?: string;
  },
): NodeRow[] {
  const params: unknown[] = [projectId];
  // The suite's own notes (the Curator Journal, the memory note) are never project evidence (#600).
  let sql = `
    SELECT DISTINCT n.id, n.file_path, n.title, n.file_mtime, n.content_hash
    FROM relationships r
    JOIN nodes n ON n.id = r.source_id
    WHERE r.resolved_target_id = ?
      AND n.id != ?
      AND ${notSuiteNoteSql('n')}
  `;
  params.push(projectId);
  if (opts.relType) {
    sql += ' AND r.rel_type = ?';
    params.push(opts.relType);
  }
  if (opts.includeType) {
    sql += ' AND EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type = ?)';
    params.push(opts.includeType);
  }
  if (opts.excludeTypes && opts.excludeTypes.length > 0) {
    const placeholders = opts.excludeTypes.map(() => '?').join(',');
    sql += ` AND NOT EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type IN (${placeholders}))`;
    params.push(...opts.excludeTypes);
  }
  if (opts.mtimeOp && opts.mtimeCutoff !== undefined) {
    sql += ` AND COALESCE(n.file_mtime, 0) ${opts.mtimeOp} ?`;
    params.push(opts.mtimeCutoff);
  }
  sql += ' ORDER BY n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC LIMIT ?';
  params.push(opts.limit);
  return db.prepare(sql).all(...params) as NodeRow[];
}

/** The names that are set: a kind or field that is none (null) names nothing. */
export function named(names: ReadonlyArray<string | null>): string[] {
  return names.filter((name): name is string => name !== null);
}

function fetchFields(db: Database.Database, nodeId: string, fields: string[]): Record<string, unknown> {
  if (fields.length === 0) return {};
  const placeholders = fields.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT field_name, value_text, value_number, value_date, value_json, source
    FROM node_fields
    WHERE node_id = ? AND field_name IN (${placeholders})
  `).all(nodeId, ...fields) as Array<FieldRow>;
  const out = createFieldMap<unknown>();
  for (const row of rows) out[row.field_name] = resolveFieldValue(row);
  return out;
}

/**
 * The notes a root links to and that link to it, for a home's live "related" section. The root's
 * own wiki pages (the home and its sub-pages, which carry `wiki_for` to it) are left out: a home
 * listed itself there, as a dossier did once its lines linked its root note (#724).
 */
function fetchNeighborhood(db: Database.Database, projectId: string): ProjectDigest['neighborhood'] {
  const notOwnWikiPage = `NOT EXISTS (
      SELECT 1 FROM relationships own WHERE own.source_id = n.id AND own.rel_type = 'wiki_for' AND own.resolved_target_id = ?
    )`;
  const outgoingRows = db.prepare(`
    SELECT r.rel_type, n.id, n.file_path, n.title, n.file_mtime, n.content_hash
    FROM relationships r
    JOIN nodes n ON n.id = r.resolved_target_id
    WHERE r.source_id = ? AND r.resolved_target_id IS NOT NULL AND r.resolved_target_id != ? AND ${notOwnWikiPage}
    ORDER BY r.rel_type ASC, n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
    LIMIT 25
  `).all(projectId, projectId, projectId) as Array<NodeRow & { rel_type: string }>;
  const incomingRows = db.prepare(`
    SELECT r.rel_type, n.id, n.file_path, n.title, n.file_mtime, n.content_hash
    FROM relationships r
    JOIN nodes n ON n.id = r.source_id
    WHERE r.resolved_target_id = ? AND r.source_id != ? AND ${notOwnWikiPage}
    ORDER BY r.rel_type ASC, n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
    LIMIT 25
  `).all(projectId, projectId, projectId) as Array<NodeRow & { rel_type: string }>;
  return {
    outgoing: groupByRel(outgoingRows),
    incoming: groupByRel(incomingRows),
  };
}

export function fetchExistingWiki(db: Database.Database, projectId: string, config: WikiConfig): ProjectDigest['existing_wiki'] {
  const home = db.prepare(`
    SELECT n.id, n.version,
      evidence.value_text AS wiki_evidence_hash,
      topology.value_text AS wiki_topology_hash,
      COALESCE(curated.value_date, curated.value_text) AS wiki_curated_at,
      reconcile.value_text AS wiki_reconcile_key
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?
    JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_for' AND r.resolved_target_id = ?
    LEFT JOIN node_fields evidence ON evidence.node_id = n.id AND evidence.field_name = 'wiki_evidence_hash'
    LEFT JOIN node_fields topology ON topology.node_id = n.id AND topology.field_name = 'wiki_topology_hash'
    LEFT JOIN node_fields curated ON curated.node_id = n.id AND curated.field_name = 'wiki_curated_at'
    LEFT JOIN node_fields reconcile ON reconcile.node_id = n.id AND reconcile.field_name = 'wiki_reconcile_key'
    WHERE NOT EXISTS (
      SELECT 1 FROM relationships rp WHERE rp.source_id = n.id AND rp.rel_type = 'wiki_parent'
    )
    ORDER BY n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
  `).get(config.wikiType, projectId) as WikiHomeRow | undefined;
  const subpages = home ? db.prepare(`
    SELECT n.id, n.file_path, n.title, n.version, n.content_hash, n.body,
      state.value_text AS wiki_state,
      kind.value_text AS wiki_kind,
      origin.value_text AS wiki_origin,
      scope.value_text AS wiki_scope_raw,
      COALESCE(replacement.target, replaced.value_text) AS wiki_replaced_by_title,
      replacement.resolved_target_id AS wiki_replaced_by_id,
      -- Read all representations for wiki_pinned to reconstruct a boolean in JS
      pin.value_json AS wiki_pinned_json,
      pin.value_number AS wiki_pinned_number,
      pin.value_text AS wiki_pinned_text,
      pin.value_date AS wiki_pinned_date
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?
    JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_parent' AND r.resolved_target_id = ?
    LEFT JOIN node_fields state ON state.node_id = n.id AND state.field_name = 'wiki_state'
    LEFT JOIN node_fields kind ON kind.node_id = n.id AND kind.field_name = 'wiki_kind'
    LEFT JOIN node_fields origin ON origin.node_id = n.id AND origin.field_name = 'wiki_origin'
    LEFT JOIN node_fields scope ON scope.node_id = n.id AND scope.field_name = 'wiki_scope'
    LEFT JOIN node_fields replaced ON replaced.node_id = n.id AND replaced.field_name = 'wiki_replaced_by'
    LEFT JOIN relationships replacement ON replacement.source_id = n.id
      AND replacement.rel_type = 'wiki_replaced_by'
      AND replacement.target = replaced.value_text
    LEFT JOIN node_fields pin ON pin.node_id = n.id AND pin.field_name = 'wiki_pinned'
    ORDER BY n.title ASC, n.file_path ASC, n.id ASC
  `).all(config.wikiType, home.id) as WikiCatalogRow[] : [];
  const pages = subpages.map(toWikiCatalogPage);
  return {
    home_id: home?.id ?? null,
    home: home === undefined ? null : {
      id: home.id,
      version: home.version,
      ...(home.wiki_evidence_hash === null ? {} : { wiki_evidence_hash: home.wiki_evidence_hash }),
      ...(home.wiki_topology_hash === null ? {} : { wiki_topology_hash: home.wiki_topology_hash }),
      ...(home.wiki_curated_at === null ? {} : { wiki_curated_at: home.wiki_curated_at }),
      ...(home.wiki_reconcile_key === null ? {} : { wiki_reconcile_key: home.wiki_reconcile_key }),
    },
    topology_hash: computeWikiTopologyHash(pages),
    catalog_valid: pages.every(page => page.wiki_scope_error === undefined),
    subpages: pages,
  };
}

function toWikiCatalogPage(row: WikiCatalogRow): WikiCatalogPage {
  const parsedScope = row.wiki_scope_raw === null ? null : parseWikiScope(row.wiki_scope_raw);
  const summary = extractManagedSection(row.body ?? '', 'Summary', SUMMARY_EXTRACT_MAX_CHARS);
  return {
    id: row.id,
    title: row.title ?? basename(row.file_path, '.md'),
    file_path: row.file_path,
    version: row.version,
    content_hash: row.content_hash ?? '',
    wiki_state: row.wiki_state ?? 'active',
    ...(row.wiki_kind === null ? {} : { wiki_kind: row.wiki_kind }),
    wiki_origin: row.wiki_origin ?? 'automatic',
    ...(parsedScope === null
      ? {}
      : parsedScope.ok
        ? { wiki_scope: parsedScope.scope }
        : { wiki_scope_raw: row.wiki_scope_raw ?? '', wiki_scope_error: parsedScope.code }),
    ...(row.wiki_replaced_by_title === null ? {} : {
      wiki_replaced_by: {
        ...(row.wiki_replaced_by_id === null ? {} : { id: row.wiki_replaced_by_id }),
        title: row.wiki_replaced_by_title,
      },
    }),
    // Compute boolean wiki_pinned from the prioritized storage forms.
    // value_json > value_number > value_date > value_text
    wiki_pinned: (() => {
      const j = row.wiki_pinned_json;
      if (j != null) {
        try {
          return JSON.parse(j) === true;
        } catch {
          // Fallback: treat non-JSON text as falsy
          return Boolean(j);
        }
      }
      const num = row.wiki_pinned_number;
      if (num != null) return num !== 0;
      const t = row.wiki_pinned_text;
      if (t != null) return String(t).toLowerCase() === 'true';
      // date is not a semantic source for booleans; default to false
      return false;
    })(),
    ...(summary === undefined ? {} : { summary }),
  };
}

function groupByRel(rows: Array<NodeRow & { rel_type: string }>): Record<string, DigestNode[]> {
  const out = createFieldMap<DigestNode[]>();
  for (const row of rows) {
    out[row.rel_type] ??= [];
    out[row.rel_type].push(toDigestNode(row));
  }
  return out;
}

function toDigestNode(row: NodeRow): DigestNode {
  return {
    id: row.id,
    file_path: row.file_path,
    title: row.title ?? basename(row.file_path, '.md'),
    file_mtime: row.file_mtime,
    content_hash: row.content_hash,
  };
}

function buildSynthesisHints(
  db: Database.Database,
  project: DigestProject,
  tasks: ProjectDigest['tasks'],
  notes: DigestNode[],
  stale: DigestNode[],
  existingWiki: ProjectDigest['existing_wiki'],
): ProjectDigest['synthesis_hints'] {
  // top_task_ids is a focus hint: actionable work only, in priority order.
  // Completed tasks belong in recently_done_ids, not here — including them let
  // done work crowd out open work when a project has little active work.
  const topTasks = uniqueNodes([
    ...tasks.overdue,
    ...tasks.blocked,
    ...tasks.upcoming,
    ...tasks.open,
    ...tasks.backlog,
  ]).slice(0, 10);
  const topNotes = notes.slice(0, 10);
  const suggested: Array<{ id: string; title: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (node: { id: string; title: string } | null, reason: string): void => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    suggested.push({ id: node.id, title: node.title, reason });
  };

  add(project, 'Project root; read first for canonical project context.');
  if (existingWiki.home_id) {
    add(fetchNodeById(db, existingWiki.home_id), 'Existing wiki home; preserve useful human or managed narrative.');
  }
  for (const page of existingWiki.subpages.slice(0, 3)) {
    add(page, 'Existing wiki sub-page; check whether this theme belongs in the home narrative or should stay separate.');
  }
  for (const task of tasks.overdue.slice(0, 3)) add(task, 'Overdue task; likely immediate risk or missed commitment.');
  for (const task of tasks.blocked.slice(0, 3)) add(task, 'Blocked task; likely dependency or unresolved decision.');
  for (const task of tasks.upcoming.slice(0, 3)) add(task, 'Upcoming task; useful for near-term focus.');
  for (const note of topNotes.slice(0, 5)) add(note, 'Recent associated note; likely current evidence for synthesis.');

  return {
    top_task_ids: topTasks.map(t => t.id),
    top_note_ids: topNotes.map(n => n.id),
    stale_task_ids: tasks.open.filter(t => stale.some(s => s.id === t.id)).map(t => t.id).slice(0, 10),
    overdue_task_ids: tasks.overdue.map(t => t.id).slice(0, 10),
    recently_done_ids: tasks.done_recent.map(t => t.id).slice(0, 10),
    suggested_reads: suggested.slice(0, 12),
  };
}

function uniqueNodes<T extends { id: string }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function fetchNodeById(db: Database.Database, id: string): DigestNode | null {
  const row = db.prepare('SELECT id, file_path, title, file_mtime, content_hash FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return row ? toDigestNode(row) : null;
}

function valueToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function valueToDateString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.slice(0, 10);
}

function compareTasks(a: DigestTask, b: DigestTask): number {
  const dueA = a.due ?? '9999-99-99';
  const dueB = b.due ?? '9999-99-99';
  if (dueA !== dueB) return dueA.localeCompare(dueB);
  return (b.file_mtime ?? 0) - (a.file_mtime ?? 0) || a.title.localeCompare(b.title);
}
