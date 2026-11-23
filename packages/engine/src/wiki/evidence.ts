import type Database from 'better-sqlite3';
import { notSuiteNoteSql } from '../notes/suite-notes.js';
import { textHashes } from '../notes/text-hash.js';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { resolveFieldValue, type FieldRow } from '../mcp/field-value.js';
import {
  associatedNoteIds, buildProjectDigest, named, projectCounts, type ProjectDigest, type DigestProject, type DigestNote, type DigestTask, type DigestWindows,
} from './digest.js';
import { getWikiConfig, type WikiConfig } from './config.js';

export interface EvidenceMeeting {
  id: string;
  title: string;
  file_path: string;
  date: string | null; // YYYY-MM-DD resolved from the meeting's date daily-note ref
  file_mtime: number | null;
  content_hash: string | null;
  attendees: string[];
  /** How many projects the meeting is filed under, counted as for a digest note (#474). Not in evidence_hash. */
  project_count: number;
}

export interface EvidenceContact {
  id: string;
  title: string;
  file_path: string;
  companies: string[];
  direct: boolean; // listed in the project's "people involved"
  meeting_count: number; // distinct project meetings attended
  last_seen: number | null; // most recent mtime across their project meetings / own node
}

/**
 * Someone the project or its meetings name in the people field who has no note (#474 idea 4).
 * A wiki writer is told to write these names as plain text, never as links. Not in evidence_hash.
 */
export interface UnlinkedContact {
  name: string;
  direct: boolean; // named in the project's own people field
  meeting_count: number; // distinct project meetings that name them
}

export interface EvidenceContacts {
  people: EvidenceContact[];
  companies: Array<{ id: string; title: string; file_path: string }>;
  unlinked: UnlinkedContact[];
}

/** How names compare: NFC, Unicode lower case, as the resolver's case-insensitive tier does. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

const NAME_KEY_FN = 've_wiki_name_key';
const nameKeyRegistered = new WeakSet<Database.Database>();

/** Registers the SQL function that keys a note's file name (second argument 1) or a name. */
function ensureNameKeyFunction(db: Database.Database): void {
  if (nameKeyRegistered.has(db)) return;
  db.function(NAME_KEY_FN, { deterministic: true }, (value: unknown, isPath: unknown) =>
    typeof value === 'string' ? nameKey(isPath === 1 ? basename(value, '.md') : value) : null);
  nameKeyRegistered.add(db);
}

/** The name a people-field link points at: no `#` anchor or `|` alias, no folder, no `.md`. */
export function unlinkedContactName(target: string): string {
  const withoutAlias = target.split('|')[0] ?? '';
  const withoutAnchor = withoutAlias.split('#')[0] ?? '';
  return basename(withoutAnchor.trim().replace(/\\/g, '/')).replace(/\.md$/i, '').trim();
}

export interface ChangedNode {
  id: string;
  title: string;
  type: string; // the bucket key, echoed for convenience
  file_mtime: number; // epoch ms
  modified: string; // ISO 8601 of file_mtime — the "date"
}

export interface ChangedSinceCuration {
  since: string; // normalized ISO echo of the parsed input
  buckets: Record<string, ChangedNode[]>;
}

export interface RiskProxy {
  id: string;
  title: string;
  status: string | null;
  due: string | null; // YYYY-MM-DD
  priority: string | null; // task schema has no owner field — priority is the risk signal
  scheduled: string | null; // YYYY-MM-DD
  bucket: 'overdue' | 'blocked';
  blocked: boolean;
}

export interface TimelineItem {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  type: 'task' | 'meeting';
}

export interface SignalsDetail {
  risk_proxies: RiskProxy[];
  timeline: TimelineItem[];
}

export interface SalienceEntry {
  id: string;
  title: string;
  score: number; // 0..1
  components: { recency: number; degree: number; urgency: number };
}

export interface ClosedSinceEntry {
  id: string;
  title: string;
  status: string | null;
  due: string | null;
  closed_at: number; // content_changed_at (fallback file_mtime) of the done node
}

// Salience weights — recency / link-degree / task-urgency. Documented & tunable here.
const SALIENCE_WEIGHTS = { recency: 0.4, degree: 0.3, urgency: 0.3 } as const;
const SALIENCE_CAP = 20;

export interface ProjectEvidence {
  project: DigestProject & { status: string | null };
  /** The day (in the configured zone) and day-count windows the buckets were cut with. */
  windows: DigestWindows;
  tasks: ProjectDigest['tasks'];
  notes: DigestNote[];
  signals: ProjectDigest['signals'];
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] };
  contacts: EvidenceContacts;
  existing_wiki: ProjectDigest['existing_wiki'];
  synthesis_hints: ProjectDigest['synthesis_hints'] & { salience: SalienceEntry[] };
  signals_detail: SignalsDetail;
  evidence_hash: string;
  /** Component fingerprints of evidence_hash's inputs; additive. */
  evidence_components: EvidenceComponents;
  generated_at: string;
  changed_since_curation?: ChangedSinceCuration;
  closed_since?: ClosedSinceEntry[];
}

export interface ProjectEvidenceOptions {
  project: string;
  meeting_recent_limit?: number;
  meeting_upcoming_limit?: number;
  contact_limit?: number;
  since?: string;
}

/** The parts of a project's evidence that its evidence hash is computed from. */
function evidenceCore(db: Database.Database, options: Omit<ProjectEvidenceOptions, 'since'>) {
  const config = getWikiConfig(db);
  const digest = buildProjectDigest(db, { project: options.project, include_neighborhood: false });
  const projectId = digest.project.id;
  // The digest's today, so meetings and tasks split on the same date in the configured zone.
  const today = digest.windows.today;
  const status = fetchProjectStatus(db, projectId, config.projectStatusField);
  const meetingCaps = {
    recent: clamp(options.meeting_recent_limit ?? 12),
    upcoming: clamp(options.meeting_upcoming_limit ?? 8),
  };
  const meetings = fetchMeetings(db, projectId, config, today, meetingCaps);
  const contacts = fetchContacts(db, projectId, config, clamp(options.contact_limit ?? 25));
  return { config, digest, projectId, status, meetings, contacts, today, meetingCaps };
}

/**
 * The notes and meetings the evidence hash keys on, each as `id|text hash` (#332). Notes are all
 * of the project's notes, not the newest 50 the evidence lists: those are picked by when a file
 * was last saved, so a link added to an older note would bring it into the list and push another
 * out, changing the hash although no text changed. Meetings are picked without the file time too
 * (`hashedMeetingIds`).
 */
export interface EvidenceTextKeys {
  readonly notes: readonly string[];
  readonly meetings: readonly string[];
}

function evidenceTextKeys(
  db: Database.Database,
  core: Pick<ReturnType<typeof evidenceCore>, 'config' | 'projectId' | 'today' | 'meetingCaps'>,
): EvidenceTextKeys {
  const noteIds = associatedNoteIds(db, core.projectId, core.config);
  const meetingIds = hashedMeetingIds(db, core.projectId, core.config, core.today, core.meetingCaps);
  const hashes = textHashes(db, [...noteIds, ...meetingIds]);
  return {
    notes: noteIds.map(id => `${id}|${hashes.get(id) ?? ''}`),
    meetings: meetingIds.map(id => `${id}|${hashes.get(id) ?? ''}`),
  };
}

/**
 * The project's evidence hash as `project-evidence` returns it for the same limits, without
 * assembling the rest of the evidence. The wiki status check compares it with the hash a
 * build stamped (#547).
 */
export function projectEvidenceHash(db: Database.Database, options: Omit<ProjectEvidenceOptions, 'since'>): string {
  const core = evidenceCore(db, options);
  const { digest, status, meetings, contacts } = core;
  return computeEvidenceHash(status, digest, meetings, contacts, evidenceTextKeys(db, core));
}

/**
 * The project's evidence hash by the formula builds stamped before text hashes (#332): the
 * content hashes of the newest 50 notes and of the meetings. Only the wiki status check reads it,
 * to recognize a stamp from before that change and stamp the current formula in its place.
 */
export function projectEvidenceHashBeforeTextHashes(db: Database.Database, options: Omit<ProjectEvidenceOptions, 'since'>): string {
  const { digest, status, meetings, contacts } = evidenceCore(db, options);
  return computeEvidenceHash(status, digest, meetings, contacts);
}

export function buildProjectEvidence(db: Database.Database, options: ProjectEvidenceOptions): ProjectEvidence {
  const core = evidenceCore(db, options);
  const { config, digest, projectId, status, meetings, contacts } = core;
  const now = Date.now();
  const keys = evidenceTextKeys(db, core);
  const evidence_hash = computeEvidenceHash(status, digest, meetings, contacts, keys);
  const evidence_components = computeEvidenceComponents(status, digest, meetings, contacts, keys);

  const sinceMs = options.since === 'auto'
    ? resolveAutoSinceMs(db, digest.existing_wiki.home_id)
    : parseSinceMs(options.since);
  const changed = sinceMs === null ? undefined : buildChangedSinceCuration(db, projectId, config, sinceMs);
  const closed_since = sinceMs === null ? undefined : buildClosedSince(db, projectId, config, sinceMs);
  const signals_detail = buildSignalsDetail(db, digest, meetings, config);
  const salience = buildSalience(db, projectId, config, digest);

  return {
    project: { ...digest.project, status },
    windows: digest.windows,
    tasks: digest.tasks,
    notes: digest.notes,
    signals: digest.signals,
    meetings,
    // Only the evidence a build reads lists them; the hash and the live Contacts section don't.
    contacts: { ...contacts, unlinked: fetchUnlinkedContacts(db, projectId, config, clamp(options.contact_limit ?? 25)) },
    existing_wiki: digest.existing_wiki,
    synthesis_hints: { ...digest.synthesis_hints, salience },
    signals_detail,
    evidence_hash,
    evidence_components,
    generated_at: new Date(now).toISOString(),
    ...(changed ? { changed_since_curation: changed } : {}),
    ...(closed_since ? { closed_since } : {}),
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 12;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function fetchProjectStatus(db: Database.Database, projectId: string, statusField: string | null): string | null {
  if (statusField === null) return null;
  const row = db.prepare(`
    SELECT field_name, value_text, value_number, value_date, value_json, source
    FROM node_fields WHERE node_id = ? AND field_name = ?
  `).get(projectId, statusField) as FieldRow | undefined;
  if (!row) return null;
  const value = resolveFieldValue(row);
  return value === null || value === undefined ? null : String(value);
}

interface MeetingRow {
  id: string;
  title: string | null;
  file_path: string;
  file_mtime: number | null;
  created_at: number | null;
  content_hash: string | null;
  meeting_date: string | null;
  field_date: string | null;
}

/** Every meeting filed under the project, each once, with when the Engine first saw it. */
function projectMeetings(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
): Array<{ meeting: EvidenceMeeting; createdAt: number | null }> {
  // A meeting is dated by its date field (the vault map's `dateField`): a link to a note titled
  // with the date (a daily note), else a plain value. No date field (none): meetings are undated.
  const dateField = config.dateField;
  const rows = db.prepare(`
    SELECT DISTINCT m.id, m.title, m.file_path, m.file_mtime, m.created_at, m.content_hash, ${dateField === null
      ? 'NULL AS meeting_date, NULL AS field_date'
      : 'dn.title AS meeting_date, COALESCE(df.value_date, df.value_text) AS field_date'}
    FROM relationships r
    JOIN nodes m ON m.id = r.source_id
    JOIN node_types nt ON nt.node_id = m.id AND nt.schema_type = ?
    ${dateField === null ? '' : `LEFT JOIN relationships rd ON rd.source_id = m.id AND rd.rel_type = ?
    LEFT JOIN nodes dn ON dn.id = rd.resolved_target_id
    LEFT JOIN node_fields df ON df.node_id = m.id AND df.field_name = ?`}
    WHERE r.resolved_target_id = ? AND m.id != ?
  `).all(config.meetingType, ...(dateField === null ? [] : [dateField, dateField]), projectId, projectId) as MeetingRow[];

  const attendees = fetchMeetingAttendees(db, projectId, config);
  const seen = new Map<string, { meeting: EvidenceMeeting; createdAt: number | null }>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.set(row.id, { createdAt: row.created_at, meeting: {
      id: row.id,
      title: row.title ?? basename(row.file_path, '.md'),
      file_path: row.file_path,
      date: normalizeDate(row.meeting_date) ?? normalizeDate(row.field_date),
      file_mtime: row.file_mtime,
      content_hash: row.content_hash,
      attendees: attendees.get(row.id) ?? [],
      project_count: 0,
    } });
  }
  return [...seen.values()];
}

/**
 * The meetings the evidence hash keys on (#332): the ones `fetchMeetings` lists for the same caps,
 * except that meetings on one date, and undated ones, are told apart by when the Engine first saw
 * each, then by id, rather than by the file's last save. A link the sweep adds to a meeting saves
 * its file, and with the file time it could bring that meeting into the recent list and push
 * another out while no meeting's text changed.
 */
function hashedMeetingIds(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  today: string,
  caps: { recent: number; upcoming: number },
): string[] {
  const all = projectMeetings(db, projectId, config);
  const upcoming = all
    .filter(({ meeting }) => meeting.date !== null && meeting.date > today)
    .sort((a, b) => (a.meeting.date ?? '').localeCompare(b.meeting.date ?? '') || a.meeting.id.localeCompare(b.meeting.id))
    .slice(0, caps.upcoming);
  const recent = all
    .filter(({ meeting }) => meeting.date === null || meeting.date <= today)
    .sort((a, b) => (b.meeting.date ?? '').localeCompare(a.meeting.date ?? '')
      || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.meeting.id.localeCompare(b.meeting.id))
    .slice(0, caps.recent);
  return [...recent, ...upcoming].map(({ meeting }) => meeting.id);
}

export function fetchMeetings(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  today: string,
  caps: { recent: number; upcoming: number },
): { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] } {
  const all = projectMeetings(db, projectId, config).map(({ meeting }) => meeting);
  const upcoming = all
    .filter(m => m.date !== null && m.date > today)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .slice(0, caps.upcoming);
  const recent = all
    .filter(m => m.date === null || m.date <= today)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.file_mtime ?? 0) - (a.file_mtime ?? 0))
    .slice(0, caps.recent);
  const counts = projectCounts(db, [...recent, ...upcoming].map(m => m.id), config.projectType);
  for (const m of [...recent, ...upcoming]) m.project_count = counts.get(m.id) ?? 0;
  return { recent, upcoming };
}

function fetchMeetingAttendees(db: Database.Database, projectId: string, config: WikiConfig): Map<string, string[]> {
  const rows = db.prepare(`
    SELECT r.source_id AS meeting_id, p.title AS person_title, p.file_path AS person_path
    FROM relationships r
    JOIN node_types nt ON nt.node_id = r.source_id AND nt.schema_type = ?
    JOIN relationships rp ON rp.source_id = r.source_id AND rp.rel_type = ?
    JOIN nodes p ON p.id = rp.resolved_target_id
    JOIN node_types pt ON pt.node_id = p.id AND pt.schema_type = ?
    WHERE r.resolved_target_id = ? AND r.source_id != ?
  `).all(config.meetingType, config.peopleField, config.personType, projectId, projectId) as Array<{
    meeting_id: string; person_title: string | null; person_path: string;
  }>;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const name = row.person_title ?? basename(row.person_path, '.md');
    const list = out.get(row.meeting_id) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(row.meeting_id, list);
  }
  return out;
}

export function fetchContacts(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  limit: number,
): { people: EvidenceContact[]; companies: Array<{ id: string; title: string; file_path: string }> } {
  const directRows = db.prepare(`
    SELECT p.id, p.title, p.file_path, p.file_mtime
    FROM relationships r
    JOIN nodes p ON p.id = r.resolved_target_id
    JOIN node_types pt ON pt.node_id = p.id AND pt.schema_type = ?
    WHERE r.source_id = ? AND r.rel_type = ?
  `).all(config.personType, projectId, config.peopleField) as Array<{
    id: string; title: string | null; file_path: string; file_mtime: number | null;
  }>;

  const meetingRows = db.prepare(`
    SELECT p.id, p.title, p.file_path, p.file_mtime,
           COUNT(DISTINCT r.source_id) AS meeting_count,
           MAX(m.file_mtime) AS last_meeting
    FROM relationships r
    JOIN nodes m ON m.id = r.source_id
    JOIN node_types nt ON nt.node_id = m.id AND nt.schema_type = ?
    JOIN relationships rp ON rp.source_id = m.id AND rp.rel_type = ?
    JOIN nodes p ON p.id = rp.resolved_target_id
    JOIN node_types pt ON pt.node_id = p.id AND pt.schema_type = ?
    WHERE r.resolved_target_id = ? AND m.id != ?
    GROUP BY p.id
  `).all(config.meetingType, config.peopleField, config.personType, projectId, projectId) as Array<{
    id: string; title: string | null; file_path: string; file_mtime: number | null;
    meeting_count: number; last_meeting: number | null;
  }>;

  const byId = new Map<string, EvidenceContact>();
  const directIds = new Set(directRows.map(r => r.id));
  for (const r of directRows) {
    byId.set(r.id, {
      id: r.id,
      title: r.title ?? basename(r.file_path, '.md'),
      file_path: r.file_path,
      companies: [],
      direct: true,
      meeting_count: 0,
      last_seen: r.file_mtime,
    });
  }
  for (const r of meetingRows) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.meeting_count = r.meeting_count;
      existing.last_seen = Math.max(existing.last_seen ?? 0, r.last_meeting ?? 0) || null;
    } else {
      byId.set(r.id, {
        id: r.id,
        title: r.title ?? basename(r.file_path, '.md'),
        file_path: r.file_path,
        companies: [],
        direct: directIds.has(r.id),
        meeting_count: r.meeting_count,
        last_seen: r.last_meeting,
      });
    }
  }

  attachCompanies(db, config, byId);

  const people = [...byId.values()]
    .sort((a, b) =>
      Number(b.direct) - Number(a.direct) ||
      b.meeting_count - a.meeting_count ||
      (b.last_seen ?? 0) - (a.last_seen ?? 0) ||
      a.title.localeCompare(b.title))
    .slice(0, limit);

  const companyRows = db.prepare(`
    SELECT c.id, c.title, c.file_path
    FROM relationships r
    JOIN nodes c ON c.id = r.resolved_target_id
    JOIN node_types ct ON ct.node_id = c.id AND ct.schema_type = ?
    WHERE r.source_id = ? AND r.rel_type = ?
  `).all(config.companyType, projectId, config.companyField) as Array<{ id: string; title: string | null; file_path: string }>;
  const companies = companyRows.map(c => ({ id: c.id, title: c.title ?? basename(c.file_path, '.md'), file_path: c.file_path }));

  return { people, companies };
}

/**
 * People-field links on the project and its meetings that reach no note (#474 idea 4), most
 * involved first: named on the project, then by how many meetings name them. Spellings that
 * differ only in case, anchor, alias or folder are one person, counted once per meeting.
 * A link left unresolved although a note has that name (a note of another type, or two notes
 * sharing it, under the typed reference policy) is not listed: the note exists.
 */
export function fetchUnlinkedContacts(db: Database.Database, projectId: string, config: WikiConfig, limit: number): UnlinkedContact[] {
  const directRows = db.prepare(`
    SELECT r.target
    FROM relationships r
    WHERE r.source_id = ? AND r.rel_type = ? AND r.resolved_target_id IS NULL
  `).all(projectId, config.peopleField) as Array<{ target: string }>;
  const meetingRows = db.prepare(`
    SELECT DISTINCT rp.target, m.id AS meeting_id
    FROM relationships r
    JOIN nodes m ON m.id = r.source_id
    JOIN node_types nt ON nt.node_id = m.id AND nt.schema_type = ?
    JOIN relationships rp ON rp.source_id = m.id AND rp.rel_type = ? AND rp.resolved_target_id IS NULL
    WHERE r.resolved_target_id = ? AND m.id != ?
  `).all(config.meetingType, config.peopleField, projectId, projectId) as Array<{ target: string; meeting_id: string }>;

  const byKey = new Map<string, { contact: UnlinkedContact; meetings: Set<string> }>();
  const entry = (target: string) => {
    const name = unlinkedContactName(target);
    const key = nameKey(name);
    // An empty list item (`- `) is stored as the target "null": no one is named.
    if (name === '' || key === 'null') return undefined;
    let found = byKey.get(key);
    if (!found) {
      found = { contact: { name, direct: false, meeting_count: 0 }, meetings: new Set() };
      byKey.set(key, found);
    }
    return found;
  };
  for (const row of directRows) {
    const found = entry(row.target);
    if (found) found.contact.direct = true;
  }
  for (const row of meetingRows) entry(row.target)?.meetings.add(row.meeting_id);
  if (byKey.size === 0) return [];

  // A note "has" a name when its file name matches it as the resolver compares names: NFC,
  // Unicode lower case (SQLite's lower() folds ASCII only).
  ensureNameKeyFunction(db);
  const keys = [...byKey.keys()];
  const named = new Set((db.prepare(`
    SELECT DISTINCT ${NAME_KEY_FN}(file_path, 1) AS name_key FROM nodes WHERE ${NAME_KEY_FN}(file_path, 1) IN (${keys.map(() => '?').join(',')})
  `).all(...keys) as Array<{ name_key: string }>).map(row => row.name_key));
  return [...byKey.entries()]
    .filter(([key]) => !named.has(key))
    .map(([, found]) => ({ ...found.contact, meeting_count: found.meetings.size }))
    .sort((a, b) => Number(b.direct) - Number(a.direct) || b.meeting_count - a.meeting_count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function attachCompanies(db: Database.Database, config: WikiConfig, byId: Map<string, EvidenceContact>): void {
  const ids = [...byId.keys()];
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT r.source_id AS person_id, c.title AS company_title, c.file_path AS company_path
    FROM relationships r
    JOIN nodes c ON c.id = r.resolved_target_id
    JOIN node_types ct ON ct.node_id = c.id AND ct.schema_type = ?
    WHERE r.rel_type = ? AND r.source_id IN (${placeholders})
  `).all(config.companyType, config.companyField, ...ids) as Array<{
    person_id: string; company_title: string | null; company_path: string;
  }>;
  for (const row of rows) {
    const contact = byId.get(row.person_id);
    if (!contact) continue;
    const name = row.company_title ?? basename(row.company_path, '.md');
    if (!contact.companies.includes(name)) contact.companies.push(name);
  }
}

/**
 * Risk proxies (the blocked + overdue task nodes themselves) and a chronological
 * timeline (due-dated tasks + dated meetings). Pure re-projection of digest task
 * buckets + evidence meetings; no new node types, no semantic work.
 */
export function buildSignalsDetail(
  db: Database.Database,
  digest: ProjectDigest,
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] },
  config: Pick<WikiConfig, 'priorityField' | 'scheduledField'>,
): SignalsDetail {
  const overdueIds = new Set(digest.tasks.overdue.map(t => t.id));
  const blockedIds = new Set(digest.tasks.blocked.map(t => t.id));
  const proxyIds = [...new Set([...overdueIds, ...blockedIds])];
  const extra = fetchTaskExtraFields(db, proxyIds, config);

  const byId = new Map<string, DigestTask>();
  for (const t of [...digest.tasks.overdue, ...digest.tasks.blocked]) byId.set(t.id, t);

  const risk_proxies: RiskProxy[] = proxyIds.map(id => {
    const t = byId.get(id)!;
    const isOverdue = overdueIds.has(id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      due: t.due,
      priority: extra.get(id)?.priority ?? null,
      scheduled: extra.get(id)?.scheduled ?? null,
      bucket: (isOverdue ? 'overdue' : 'blocked') as RiskProxy['bucket'],
      blocked: blockedIds.has(id),
    };
  }).sort((a, b) => (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99') || a.id.localeCompare(b.id));

  // Timeline: union of every task bucket with a due date + dated meetings.
  // Includes done_recent — completed tasks with a due date surface as past milestones.
  const taskById = new Map<string, DigestTask>();
  for (const bucket of Object.values(digest.tasks)) {
    for (const t of bucket) taskById.set(t.id, t);
  }
  const taskItems: TimelineItem[] = [...taskById.values()]
    .filter(t => t.due !== null)
    .map(t => ({ id: t.id, title: t.title, date: t.due as string, type: 'task' as const }));
  const meetingItems: TimelineItem[] = [...meetings.recent, ...meetings.upcoming]
    .filter(m => m.date !== null)
    .map(m => ({ id: m.id, title: m.title, date: m.date as string, type: 'meeting' as const }));

  const timeline = [...taskItems, ...meetingItems]
    .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  return { risk_proxies, timeline };
}

/** A risk proxy's priority and scheduled date, from the vault map's `priorityField` and
 *  `scheduledField`; a field that is none is not read. */
function fetchTaskExtraFields(
  db: Database.Database,
  ids: string[],
  config: Pick<WikiConfig, 'priorityField' | 'scheduledField'>,
): Map<string, { priority: string | null; scheduled: string | null }> {
  const out = new Map<string, { priority: string | null; scheduled: string | null }>();
  const { priorityField, scheduledField } = config;
  const fields = named([priorityField, scheduledField]);
  if (ids.length === 0 || fields.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT node_id, field_name, value_text, value_number, value_date, value_json, source
    FROM node_fields
    WHERE field_name IN (${fields.map(() => '?').join(', ')}) AND node_id IN (${placeholders})
  `).all(...fields, ...ids) as Array<FieldRow & { node_id: string }>;
  for (const row of rows) {
    const entry = out.get(row.node_id) ?? { priority: null, scheduled: null };
    const value = resolveFieldValue(row);
    const str = value === null || value === undefined ? null : String(value);
    if (row.field_name === priorityField) entry.priority = str;
    else if (row.field_name === scheduledField) entry.scheduled = str === null ? null : str.slice(0, 10);
    out.set(row.node_id, entry);
  }
  return out;
}

/**
 * Project-associated nodes modified after `sinceMs`, bucketed by type. Excludes
 * the project root and curator-authored wiki nodes (self-referential noise in a
 * change delta). A multi-type node appears under each of its remaining types.
 * Deterministic order: newest first, ties by id.
 */
export function buildChangedSinceCuration(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  sinceMs: number,
): ChangedSinceCuration {
  const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.file_path, n.file_mtime, nt.schema_type AS type
    FROM relationships r
    JOIN nodes n ON n.id = r.source_id
    JOIN node_types nt ON nt.node_id = n.id
    WHERE r.resolved_target_id = ?
      AND n.id != ?
      AND COALESCE(n.file_mtime, 0) > ?
      AND NOT EXISTS (
        SELECT 1 FROM node_types x
        WHERE x.node_id = n.id AND x.schema_type IN (?, ?)
      )
      AND ${notSuiteNoteSql('n')}
    ORDER BY n.file_mtime DESC, n.id ASC, nt.schema_type ASC
  `).all(projectId, projectId, sinceMs, config.projectType, config.wikiType) as Array<{
    id: string; title: string | null; file_path: string; file_mtime: number | null; type: string;
  }>;

  const buckets: Record<string, ChangedNode[]> = {};
  for (const row of rows) {
    const mtime = row.file_mtime ?? 0;
    (buckets[row.type] ??= []).push({
      id: row.id,
      title: row.title ?? basename(row.file_path, '.md'),
      type: row.type,
      file_mtime: mtime,
      modified: new Date(mtime).toISOString(),
    });
  }
  return { since: new Date(sinceMs).toISOString(), buckets };
}

const CLOSED_SINCE_CAP = 25;

export function buildClosedSince(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  sinceMs: number,
): ClosedSinceEntry[] {
  // No task status field (none): nothing reads as closed.
  if (config.taskStatusField === null || config.taskDoneStatuses.length === 0) return [];
  const donePlaceholders = config.taskDoneStatuses.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.file_path,
           COALESCE(n.content_changed_at, n.file_mtime, 0) AS closed_at,
           sf.value_text AS status,
           COALESCE(df.value_date, df.value_text) AS due
    FROM relationships r
    JOIN nodes n ON n.id = r.source_id
    JOIN node_fields sf ON sf.node_id = n.id AND sf.field_name = ?
    LEFT JOIN node_fields df ON df.node_id = n.id AND df.field_name = ?
    WHERE r.resolved_target_id = ?
      AND n.id != ?
      AND NOT EXISTS (
        SELECT 1 FROM node_types x
        WHERE x.node_id = n.id AND x.schema_type IN (?, ?)
      )
      AND ${notSuiteNoteSql('n')}
      AND sf.value_text IN (${donePlaceholders})
      AND COALESCE(n.content_changed_at, n.file_mtime, 0) >= ?
  `).all(config.taskStatusField, config.dueField, projectId, projectId, config.projectType, config.wikiType, ...config.taskDoneStatuses, sinceMs) as Array<{
    id: string; title: string | null; file_path: string; closed_at: number; status: string | null; due: string | null;
  }>;

  return rows
    .map(r => ({
      id: r.id,
      title: r.title ?? basename(r.file_path, '.md'),
      status: r.status,
      due: r.due,
      closed_at: r.closed_at,
    }))
    .sort((a, b) => b.closed_at - a.closed_at || a.id.localeCompare(b.id))
    .slice(0, CLOSED_SINCE_CAP);
}

interface SalienceCandidate {
  id: string;
  title: string;
  recency_basis: number;
}

/**
 * Deterministic salience ranking: each candidate (project-associated node, minus
 * project + wiki nodes) is scored by min-max-normalized recency and link-degree
 * plus an absolute task-urgency component, combined as a weighted sum. A weighted
 * sum — not a product — so a zero on any axis does not annihilate the score.
 * recency and degree are min-max normalized across the candidate set; urgency is
 * constructed directly in [0,1] (absolute, not normalized — min-maxing it would
 * zero out a project where every task is equally urgent).
 */
export function buildSalience(
  db: Database.Database,
  projectId: string,
  config: WikiConfig,
  digest: ProjectDigest,
): SalienceEntry[] {
  const candidates = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.file_path, n.file_mtime, n.content_changed_at
    FROM relationships r
    JOIN nodes n ON n.id = r.source_id
    WHERE r.resolved_target_id = ?
      AND n.id != ?
      AND NOT EXISTS (
        SELECT 1 FROM node_types x
        WHERE x.node_id = n.id AND x.schema_type IN (?, ?)
      )
      AND ${notSuiteNoteSql('n')}
  `).all(projectId, projectId, config.projectType, config.wikiType) as Array<{
    id: string; title: string | null; file_path: string; file_mtime: number | null; content_changed_at: number | null;
  }>;
  if (candidates.length === 0) return [];

  const cands: SalienceCandidate[] = candidates.map(c => ({
    id: c.id,
    title: c.title ?? basename(c.file_path, '.md'),
    recency_basis: c.content_changed_at ?? c.file_mtime ?? 0,
  }));
  const ids = cands.map(c => c.id);

  const degreeById = fetchDegrees(db, ids);
  const urgentIds = new Set([...digest.tasks.overdue, ...digest.tasks.blocked].map(t => t.id));
  const openTaskIds = new Set(
    [...digest.tasks.open, ...digest.tasks.upcoming, ...digest.tasks.backlog].map(t => t.id),
  );
  const adjById = urgentIds.size > 0 ? fetchAdjacency(db, ids, [...urgentIds]) : new Map<string, number>();

  const recencyVals = cands.map(c => c.recency_basis);
  const degreeVals = cands.map(c => degreeById.get(c.id) ?? 0);
  const normRecency = minMax(recencyVals);
  const normDegree = minMax(degreeVals);

  const entries = cands.map((c) => {
    const recency = normRecency(c.recency_basis);
    const degree = normDegree(degreeById.get(c.id) ?? 0);
    let urgency = urgentIds.has(c.id) ? 1.0 : openTaskIds.has(c.id) ? 0.5 : 0;
    const adj = adjById.get(c.id) ?? 0;
    urgency = Math.min(1.0, urgency + Math.min(0.5, 0.25 * adj));
    const score =
      SALIENCE_WEIGHTS.recency * recency +
      SALIENCE_WEIGHTS.degree * degree +
      SALIENCE_WEIGHTS.urgency * urgency;
    return { id: c.id, title: c.title, score, components: { recency, degree, urgency } };
  });

  return entries
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, SALIENCE_CAP);
}

/**
 * Inbound + outbound relationship count per node id. This is raw total degree
 * (every candidate's edge to the project counts too), but since all candidates
 * share that edge it normalizes out under min-max — what survives is the spread
 * in additional links.
 */
function fetchDegrees(db: Database.Database, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, COUNT(*) AS degree FROM (
      SELECT source_id AS id FROM relationships WHERE source_id IN (${ph})
      UNION ALL
      SELECT resolved_target_id AS id FROM relationships
        WHERE resolved_target_id IN (${ph}) AND resolved_target_id IS NOT NULL
    ) GROUP BY id
  `).all(...ids, ...ids) as Array<{ id: string; degree: number }>;
  for (const row of rows) out.set(row.id, row.degree);
  return out;
}

/** Count of overdue/blocked tasks adjacent (either direction) to each candidate. */
function fetchAdjacency(db: Database.Database, candidateIds: string[], urgentIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (candidateIds.length === 0 || urgentIds.length === 0) return out;
  const cph = candidateIds.map(() => '?').join(',');
  const uph = urgentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT n_id, COUNT(*) AS adj FROM (
      SELECT source_id AS n_id FROM relationships
        WHERE source_id IN (${cph}) AND resolved_target_id IN (${uph})
      UNION ALL
      SELECT resolved_target_id AS n_id FROM relationships
        WHERE resolved_target_id IN (${cph}) AND source_id IN (${uph})
    ) GROUP BY n_id
  `).all(...candidateIds, ...urgentIds, ...candidateIds, ...urgentIds) as Array<{ n_id: string; adj: number }>;
  for (const row of rows) out.set(row.n_id, row.adj);
  return out;
}

/** Returns a min-max normalizer over the given values; all-equal sets map to 0. */
function minMax(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return (v: number) => (span === 0 ? 0 : (v - min) / span);
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(raw.trim());
  return match ? match[0] : null;
}

/**
 * Lenient timestamp parse for the curator's `since` (wiki_curated_at). Accepts
 * ISO 8601 or an epoch-ms numeric string. Returns null for undefined/empty/
 * unparseable input — callers treat null as "no since supplied".
 */
export function parseSinceMs(since: string | undefined): number | null {
  if (since === undefined) return null;
  const trimmed = since.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `since: 'auto'` support: read the project wiki home's `wiki_curated_at` field.
 * Null when the project has no wiki home, the field is absent, or it doesn't
 * parse — callers treat null exactly like "no since supplied" (uncurated is a
 * normal state, never an error).
 */
export function resolveAutoSinceMs(db: Database.Database, homeId: string | null): number | null {
  if (!homeId) return null;
  const row = db.prepare(
    "SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = 'wiki_curated_at'",
  ).get(homeId) as { value_text: string | null } | undefined;
  return parseSinceMs(row?.value_text ?? undefined);
}

/**
 * Deterministic fingerprint over the typed evidence. Content-stable: keyed on
 * status, actionable task state (id|status|due), and note/meeting text hashes
 * (`keys`, #332) — NOT file_mtime, NOT the time-windowed done_recent bucket,
 * NOT any wiki state, and NOT links added or removed around words already in a
 * note. So the curator's own writes, the link sweep, no-op re-renders, and the
 * clock advancing cannot change it; only genuine evidence changes do.
 * Becoming-done is still detected: a completed task leaves the actionable
 * buckets, shrinking the set. Without `keys` it is the formula from before text
 * hashes: the content hashes of the digest's notes and of the meetings.
 */
/** The canonical evidence parts, in hash order: status, tasks, notes, meetings, contacts, companies. */
function evidenceParts(
  status: string | null,
  digest: ProjectDigest,
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] },
  contacts: { people: EvidenceContact[]; companies: Array<{ id: string; title: string; file_path: string }> },
  keys?: EvidenceTextKeys,
) {
  // done_recent is windowed on file_mtime >= now - recentDays; excluding it stops a
  // completed task aging out of the window from flipping the fingerprint.
  // This list is the hand-maintained "all task buckets minus done_recent" set:
  // a new actionable bucket added to ProjectDigest['tasks'] must be added here too.
  const ACTIONABLE_BUCKETS = ['open', 'blocked', 'overdue', 'upcoming', 'backlog'] as const;
  const tasksById = new Map<string, string>();
  for (const bucket of ACTIONABLE_BUCKETS) {
    for (const t of digest.tasks[bucket]) {
      tasksById.set(t.id, `${t.id}|${t.status ?? ''}|${t.due ?? ''}`);
    }
  }
  return {
    status: status ?? null,
    tasks: [...tasksById.values()].sort(),
    notes: keys ? [...keys.notes].sort() : digest.notes.map(n => `${n.id}|${n.content_hash ?? ''}`).sort(),
    meetings: keys ? [...keys.meetings].sort()
      : [...meetings.recent, ...meetings.upcoming].map(m => `${m.id}|${m.content_hash ?? ''}`).sort(),
    contacts: contacts.people.map(c => `${c.id}|${c.meeting_count}`).sort(),
    companies: contacts.companies.map(c => c.id).sort(),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function computeEvidenceHash(
  status: string | null,
  digest: ProjectDigest,
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] },
  contacts: { people: EvidenceContact[]; companies: Array<{ id: string; title: string; file_path: string }> },
  keys?: EvidenceTextKeys,
): string {
  return sha256(JSON.stringify(evidenceParts(status, digest, meetings, contacts, keys)));
}

/** Per-component fingerprints of the same evidence, so callers can tell which part changed. */
export interface EvidenceComponents {
  status: string;
  tasks: string;
  notes: string;
  meetings: string;
  contacts: string;
}

export function computeEvidenceComponents(
  status: string | null,
  digest: ProjectDigest,
  meetings: { recent: EvidenceMeeting[]; upcoming: EvidenceMeeting[] },
  contacts: { people: EvidenceContact[]; companies: Array<{ id: string; title: string; file_path: string }> },
  keys?: EvidenceTextKeys,
): EvidenceComponents {
  const parts = evidenceParts(status, digest, meetings, contacts, keys);
  return {
    status: sha256(JSON.stringify(parts.status)),
    tasks: sha256(JSON.stringify(parts.tasks)),
    notes: sha256(JSON.stringify(parts.notes)),
    meetings: sha256(JSON.stringify(parts.meetings)),
    contacts: sha256(JSON.stringify({ people: parts.contacts, companies: parts.companies })),
  };
}
