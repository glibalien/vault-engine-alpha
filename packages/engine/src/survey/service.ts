import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { LIKE_ESCAPE, literalPrefixPattern } from '../db/like-pattern.js';
import { notSuiteNoteSql } from '../notes/suite-notes.js';
import { bodyFeatures, BODY_HEAD_CHARS, ShareCounter, titlePattern, type SharedCount } from './features.js';
import { assignToCentres, fitCentres, normalizeAt, sampleVectors, type VectorSet } from './kmeans.js';

/**
 * The note survey (#642): groups notes by the similarity of their stored embeddings, so a
 * caller can see the kinds hiding in notes that declare none. Read-only and deterministic.
 * Naming a group and typing its notes stay with the caller.
 */

export const SURVEY_LIMITS = {
  /** Most notes one survey reads; beyond it the survey takes the first by id and says so. */
  maxNotes: 50_000,
  /** Centres are fitted on at most this many notes; every note is then assigned to one. */
  fitSample: 3_000,
  defaultGroups: 12,
  maxGroups: 40,
  defaultSamples: 5,
  maxSamples: 10,
  /** Text and fields are read for at most this many notes per group. */
  featureSample: 500,
  /** Surveys kept in memory for `within` and `members_of`. */
  storedSurveys: 8,
  defaultMemberPage: 200,
  maxMemberPage: 500,
} as const;

export type SurveyErrorCode = 'INVALID_PARAMS' | 'NOT_FOUND' | 'UNKNOWN_TYPE';

export class SurveyError extends Error {
  override readonly name = 'SurveyError';
  constructor(readonly code: SurveyErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface GroupRef {
  survey_id: string;
  group: number;
}

export interface SurveyRequest {
  types?: string[];
  path_prefix?: string;
  within?: GroupRef;
  max_groups?: number;
  samples?: number;
}

export interface SurveyNote {
  id: string;
  title: string;
  path: string;
}

export interface SurveyShared {
  folders: SharedCount[];
  title_patterns: SharedCount[];
  label_lines: SharedCount[];
  headings: SharedCount[];
  fields: SharedCount[];
}

export interface SurveyGroup {
  group: number;
  notes: number;
  /** Mean similarity of the group's notes to its centre, 0–1. Higher is more alike. */
  cohesion: number;
  /** The most similar other group, and how similar their centres are. Null with one group. */
  nearest: { group: number; similarity: number } | null;
  samples: SurveyNote[];
  shared: SurveyShared;
}

export interface SurveyResult {
  survey_id: string;
  surveyed_at: string;
  scope: {
    kind: 'untyped' | 'types' | 'group';
    types?: string[];
    path_prefix?: string;
    within?: GroupRef;
    /** Notes in scope. */
    notes: number;
    /** Notes grouped: those with an embedding. */
    surveyed: number;
    /** Notes the search index has not embedded yet; left out of every group. */
    not_indexed: number;
    truncated: boolean;
  };
  groups: SurveyGroup[];
  /** Group 0: notes in clusters too small to report. */
  ungrouped: { notes: number; samples: SurveyNote[] };
}

export interface SurveyMembersResult {
  survey_id: string;
  surveyed_at: string;
  group: number;
  /** Notes in the group when it was surveyed. */
  total: number;
  offset: number;
  /** Most typical first. Notes deleted since the survey are left out. */
  members: SurveyNote[];
}

interface StoredSurvey {
  id: string;
  surveyedAt: string;
  /** Member ids per group, most typical first. Index 0 is the ungrouped rest. */
  groups: string[][];
}

const stored = new WeakMap<Database.Database, Map<string, StoredSurvey>>();

function surveysOf(db: Database.Database): Map<string, StoredSurvey> {
  let surveys = stored.get(db);
  if (!surveys) {
    surveys = new Map();
    stored.set(db, surveys);
  }
  return surveys;
}

function remember(db: Database.Database, survey: StoredSurvey): void {
  const surveys = surveysOf(db);
  surveys.delete(survey.id);
  surveys.set(survey.id, survey);
  while (surveys.size > SURVEY_LIMITS.storedSurveys) {
    surveys.delete(surveys.keys().next().value!);
  }
}

function storedGroup(db: Database.Database, ref: GroupRef): { survey: StoredSurvey; ids: string[] } {
  const survey = surveysOf(db).get(ref.survey_id);
  if (!survey) {
    throw new SurveyError(
      'NOT_FOUND',
      `No survey "${ref.survey_id}" is held. Surveys are kept in memory (the last ${SURVEY_LIMITS.storedSurveys}) and are lost when the Engine restarts; run the survey again.`,
    );
  }
  const ids = survey.groups[ref.group];
  if (ids === undefined) {
    throw new SurveyError('NOT_FOUND', `Survey "${ref.survey_id}" has groups 0 through ${survey.groups.length - 1}; there is no group ${ref.group}.`);
  }
  return { survey, ids };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hydrate(db: Database.Database, ids: readonly string[]): SurveyNote[] {
  const read = db.prepare<[string], { id: string; title: string | null; file_path: string }>(
    'SELECT id, title, file_path FROM nodes WHERE id = ?',
  );
  const notes: SurveyNote[] = [];
  for (const id of ids) {
    const row = read.get(id);
    if (row) notes.push({ id: row.id, title: row.title ?? '', path: row.file_path });
  }
  return notes;
}

function unknownTypes(db: Database.Database, types: readonly string[]): string[] {
  const known = db.prepare<[string, string], { found: number }>(
    `SELECT EXISTS (SELECT 1 FROM schemas WHERE name = ?) OR EXISTS (SELECT 1 FROM node_types WHERE schema_type = ?) AS found`,
  );
  return types.filter(type => known.get(type, type)?.found !== 1);
}

/**
 * Conditions on `nodes n` for the notes an untyped survey covers: no type, not one of the
 * suite's own notes, and not in the settings folder (an untyped settings note is the suite's,
 * not one of the user's notes to sort). The clean-up report counts untyped notes with the same
 * conditions, so its number is the one a survey then covers.
 */
export function untypedNotesWhere(settingsDir: string | undefined): { where: string[]; params: string[] } {
  const where = [notSuiteNoteSql('n'), 'NOT EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id)'];
  const params: string[] = [];
  if (settingsDir) {
    where.push(`n.file_path NOT LIKE ? ${LIKE_ESCAPE}`);
    params.push(literalPrefixPattern(`${settingsDir}/`));
  }
  return { where, params };
}

function scopeNotes(db: Database.Database, request: SurveyRequest, settingsDir: string | undefined): SurveyNote[] {
  if (request.within) return hydrate(db, [...storedGroup(db, request.within).ids].sort(compareIds));

  let where: string[];
  let params: string[];
  if (request.types && request.types.length > 0) {
    const missing = unknownTypes(db, request.types);
    if (missing.length > 0) {
      throw new SurveyError('UNKNOWN_TYPE', `No such type: ${missing.join(', ')}. list-schemas shows the types in use.`, { unknown_types: missing });
    }
    where = [
      notSuiteNoteSql('n'),
      `EXISTS (SELECT 1 FROM node_types nt WHERE nt.node_id = n.id AND nt.schema_type IN (${request.types.map(() => '?').join(', ')}))`,
    ];
    params = [...request.types];
  } else {
    ({ where, params } = untypedNotesWhere(settingsDir));
  }
  // Literal: a `_` or `%` in a folder name must not match other folders, since the caller may
  // go on to type every note the survey returns.
  if (request.path_prefix) {
    where.push(`n.file_path LIKE ? ${LIKE_ESCAPE}`);
    params.push(literalPrefixPattern(request.path_prefix));
  }
  const rows = db.prepare<string[], { id: string; title: string | null; file_path: string }>(
    `SELECT n.id, n.title, n.file_path FROM nodes n WHERE ${where.join(' AND ')} ORDER BY n.id LIMIT ${SURVEY_LIMITS.maxNotes + 1}`,
  ).all(...params);
  return rows.map(row => ({ id: row.id, title: row.title ?? '', path: row.file_path }));
}

/**
 * One unit vector per note: the mean of the note's own chunk vectors (attachment extractions
 * are left out). Notes with no stored vector are returned in `missing`.
 */
function loadVectors(db: Database.Database, notes: readonly SurveyNote[]): { embedded: SurveyNote[]; vectors: VectorSet; missing: number } {
  const read = db.prepare<[string], { vector: Buffer }>(
    `SELECT v.vector AS vector FROM embedding_meta m JOIN embedding_vec v ON v.id = m.id
     WHERE m.node_id = ? AND m.source_type = 'node' ORDER BY m.chunk_index`,
  );
  let dims = 0;
  let data = new Float32Array(0);
  const embedded: SurveyNote[] = [];
  for (const note of notes) {
    const chunks = read.all(note.id);
    if (chunks.length === 0) continue;
    const first = chunks[0]!.vector;
    if (dims === 0) {
      dims = first.byteLength / 4;
      data = new Float32Array(notes.length * dims);
    }
    const offset = embedded.length * dims;
    let used = 0;
    for (const chunk of chunks) {
      if (chunk.vector.byteLength !== dims * 4) continue;
      const vector = new Float32Array(chunk.vector.buffer, chunk.vector.byteOffset, dims);
      for (let i = 0; i < dims; i++) data[offset + i] = data[offset + i]! + vector[i]!;
      used += 1;
    }
    if (used === 0 || !normalizeAt(data, offset, dims)) {
      data.fill(0, offset, offset + dims);
      continue;
    }
    embedded.push(note);
  }
  return {
    embedded,
    vectors: { data: data.subarray(0, embedded.length * dims), count: embedded.length, dims },
    missing: notes.length - embedded.length,
  };
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '/' : path.slice(0, slash);
}

/** Every `stride`-th member, at most `limit`, so a large group is read evenly. */
function spread<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * items.length) / limit)]!);
  return out;
}

function sharedBy(db: Database.Database, members: readonly SurveyNote[]): SurveyShared {
  const folders = new ShareCounter();
  const patterns = new ShareCounter();
  for (const note of members) {
    const folder = folderOf(note.path);
    folders.add(folder, folder);
    const pattern = titlePattern(note.title);
    if (pattern !== '' && pattern !== '…') patterns.add(pattern, pattern);
  }

  const readBody = db.prepare<[string], { head: string | null }>(`SELECT substr(body, 1, ${BODY_HEAD_CHARS}) AS head FROM nodes WHERE id = ?`);
  const readFields = db.prepare<[string], { field_name: string }>('SELECT DISTINCT field_name FROM node_fields WHERE node_id = ?');
  const labels = new ShareCounter();
  const headings = new ShareCounter();
  const fields = new ShareCounter();
  const read = spread(members, SURVEY_LIMITS.featureSample);
  for (const note of read) {
    const features = bodyFeatures(readBody.get(note.id)?.head ?? '');
    for (const [key, name] of features.labels) labels.add(key, name);
    for (const [key, name] of features.headings) headings.add(key, name);
    for (const row of readFields.all(note.id)) fields.add(row.field_name, row.field_name);
  }
  return {
    folders: folders.top(members.length, 0.1, 3),
    title_patterns: patterns.top(members.length, 0.15, 3),
    label_lines: labels.top(read.length, 0.25, 6),
    headings: headings.top(read.length, 0.25, 6),
    fields: fields.top(read.length, 0.25, 6),
  };
}

/** Clusters smaller than this are folded into the ungrouped rest. */
function minimumGroupSize(surveyed: number): number {
  return Math.min(25, Math.max(3, Math.round(surveyed / 200)));
}

/** A small scope gets fewer groups: about ten notes a group at least. */
const NOTES_PER_GROUP = 10;

function dotAt(a: Float32Array, aOffset: number, b: Float32Array, bOffset: number, dims: number): number {
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += a[aOffset + i]! * b[bOffset + i]!;
  return sum;
}

export function surveyNodes(db: Database.Database, request: SurveyRequest, options: { settingsDir?: string } = {}): SurveyResult {
  if (request.within && (request.types?.length || request.path_prefix)) {
    throw new SurveyError('INVALID_PARAMS', 'within surveys one earlier group; it cannot be combined with types or path_prefix.');
  }
  const maxGroups = request.max_groups ?? SURVEY_LIMITS.defaultGroups;
  const sampleCount = request.samples ?? SURVEY_LIMITS.defaultSamples;

  const inScope = scopeNotes(db, request, options.settingsDir);
  const truncated = inScope.length > SURVEY_LIMITS.maxNotes;
  const notes = truncated ? inScope.slice(0, SURVEY_LIMITS.maxNotes) : inScope;
  const { embedded, vectors, missing } = loadVectors(db, notes);

  // Members per cluster, most typical first.
  const clusters: Array<{ members: SurveyNote[]; similarity: number; centre: number }> = [];
  const rest: SurveyNote[] = [];
  let centres: Float32Array = new Float32Array(0);
  if (embedded.length > 0) {
    const minimum = minimumGroupSize(embedded.length);
    const k = Math.min(maxGroups, Math.max(1, Math.floor(embedded.length / NOTES_PER_GROUP)));
    centres = fitCentres(sampleVectors(vectors, SURVEY_LIMITS.fitSample), k);
    const assignment = assignToCentres(vectors, centres);
    const byCentre = new Map<number, number[]>();
    for (let i = 0; i < embedded.length; i++) {
      const centre = assignment.centre[i]!;
      const list = byCentre.get(centre);
      if (list) list.push(i);
      else byCentre.set(centre, [i]);
    }
    for (const [centre, indexes] of byCentre) {
      indexes.sort((a, b) => assignment.similarity[b]! - assignment.similarity[a]! || compareIds(embedded[a]!.id, embedded[b]!.id));
      const members = indexes.map(i => embedded[i]!);
      if (members.length < minimum) {
        rest.push(...members);
        continue;
      }
      let total = 0;
      for (const i of indexes) total += assignment.similarity[i]!;
      clusters.push({ members, similarity: total / indexes.length, centre });
    }
  }
  clusters.sort((a, b) => b.members.length - a.members.length || compareIds(a.members[0]!.id, b.members[0]!.id));
  rest.sort((a, b) => compareIds(a.id, b.id));

  const scope: SurveyResult['scope'] = {
    kind: request.within ? 'group' : request.types?.length ? 'types' : 'untyped',
    ...(request.types?.length ? { types: request.types } : {}),
    ...(request.path_prefix ? { path_prefix: request.path_prefix } : {}),
    ...(request.within ? { within: request.within } : {}),
    notes: notes.length,
    surveyed: embedded.length,
    not_indexed: missing,
    truncated,
  };
  const memberIds = [rest.map(note => note.id), ...clusters.map(cluster => cluster.members.map(note => note.id))];
  const surveyId = createHash('sha256')
    .update(JSON.stringify({ kind: scope.kind, types: scope.types, path_prefix: scope.path_prefix, within: scope.within, maxGroups, memberIds }))
    .digest('hex')
    .slice(0, 12);
  const surveyedAt = new Date().toISOString();
  remember(db, { id: surveyId, surveyedAt, groups: memberIds });

  // k-means always forms as many clusters as it was asked for, so one kind of note can come back
  // as several groups. Naming each group's nearest neighbour lets the caller see which belong
  // together; joining them here by a similarity cut-off mixed distinct kinds in testing.
  const nearest = (index: number): SurveyGroup['nearest'] => {
    let best: SurveyGroup['nearest'] = null;
    for (let other = 0; other < clusters.length; other++) {
      if (other === index) continue;
      const similarity = dotAt(centres, clusters[index]!.centre * vectors.dims, centres, clusters[other]!.centre * vectors.dims, vectors.dims);
      if (best === null || similarity > best.similarity) best = { group: other + 1, similarity };
    }
    return best === null ? null : { group: best.group, similarity: Math.round(best.similarity * 100) / 100 };
  };

  return {
    survey_id: surveyId,
    surveyed_at: surveyedAt,
    scope,
    groups: clusters.map((cluster, index) => ({
      group: index + 1,
      notes: cluster.members.length,
      cohesion: Math.round(cluster.similarity * 100) / 100,
      nearest: nearest(index),
      samples: cluster.members.slice(0, sampleCount),
      shared: sharedBy(db, cluster.members),
    })),
    ungrouped: { notes: rest.length, samples: rest.slice(0, sampleCount) },
  };
}

export function surveyMembers(db: Database.Database, ref: GroupRef, page: { limit?: number; offset?: number } = {}): SurveyMembersResult {
  const { survey, ids } = storedGroup(db, ref);
  const offset = page.offset ?? 0;
  const limit = page.limit ?? SURVEY_LIMITS.defaultMemberPage;
  return {
    survey_id: survey.id,
    surveyed_at: survey.surveyedAt,
    group: ref.group,
    total: ids.length,
    offset,
    members: hydrate(db, ids.slice(offset, offset + limit)),
  };
}
