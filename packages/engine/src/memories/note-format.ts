import { createHash } from 'node:crypto';
import { stringify, parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { renderNode } from '../renderer/render.js';
import type { MemoryProjectionRow } from './types.js';
import { linkKey } from '../resolver/near-miss.js';
import { subjectName } from './subjects.js';

/**
 * Pure parser + deterministic renderer for the editable
 * `Settings/Memories.md` projection (Task 3 of the durable-memory
 * markdown-projection plan).
 *
 * The note is a DB-authoritative, human-edit-input view of the complete
 * durable-memory stock. SQLite remains authoritative; the file is parsed and
 * edits are ingested back into the `memories` tables (Task 4), and the
 * canonical note is rewritten only during an explicit refresh (Task 6). This
 * module is pure: it has no DB or filesystem dependencies, so it's trivially
 * testable and reusable from both the ingest and projection paths.
 *
 * Format contract (see the plan's "Projection format contract" section):
 *   - canonical frontmatter with `vault_engine_projection: memories`,
 *     `memory_log_version: 1`, a deterministic `snapshot_at`,
 *     `live_count`, `historical_count`.
 *   - canonical grouping/order: Live rules/corrections/preferences, Live other,
 *     Historical expired/superseded; within a section
 *     `source ASC, scope ASC, updated_at DESC, id DESC`.
 *   - each entry is marker-delimited with one tilde-fenced YAML payload whose
 *     fence length is dynamically chosen to exceed any all-tilde line in the
 *     serialized content (so arbitrary memory text can never close it).
 *   - the parser ignores headings/group placement and trusts only complete
 *     open/close markers plus their payload. `base` is
 *     `sha256(canonical JSON({content,category,status}))`. Read-only values
 *     must equal the canonical row snapshot; editing one is a validation
 *     error, not an ignored success.
 *   - `new:<uuid>` blocks create a live `source='owner'` memory (the engine
 *     fixes the source; the file cannot choose or spoof it).
 *   - a block carries a read-only `changed_by` line, right after `source`, only
 *     when a signed-in chat client last wrote the row (#532).
 *   - a block carries an editable `subjects` list, right after `category`, only when the
 *     memory has subjects (#554): the names they were given, which a rename of the note
 *     does not change. The owner may add the key to any block, and to a `new:` block.
 *     `base` covers them only when there are some, so a block without any hashes as before.
 */

const YAML_STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  defaultKeyType: 'PLAIN' as const,
  defaultStringType: 'PLAIN' as const,
  nullStr: '',
};

const YAML_PARSE_OPTIONS = { uniqueKeys: false as const };

const MARKER_OPEN_RE = /^<!-- ve:memory:(\S+) revision="([^"]*)" base="([^"]*)" -->\s*$/;
const MARKER_CLOSE_RE = /^<!-- \/ve:memory:(\S+) -->\s*$/;
// Opening tilde fence: tildes + optional info string (e.g. `~~~~yaml`).
const TILDE_FENCE_OPEN_RE = /^([~]+)([^\s~]*)\s*$/;
// Closing tilde fence: tildes only, no info string (markdown fence rule).
const TILDE_FENCE_CLOSE_RE = /^([~]+)\s*$/;

export const MEMORY_LOG_VERSION = 1;
const FILENAME = 'Memories.md';

// ---------------------------------------------------------------------------
// Paths + hashes
// ---------------------------------------------------------------------------

export function memoryNotePath(settingsDir: string): string {
  return `${settingsDir}/${FILENAME}`;
}

/**
 * The editable-fields hash: `sha256(canonical JSON({content,category,status}))`, plus the
 * subjects when there are some (#554), as their sorted keys, so their order and letter case
 * are no edit. Read-only fields are not part of the editable surface, so they don't ride
 * the hash. Canonical JSON = sorted keys, no whitespace, so two structurally
 * identical payloads hash the same regardless of YAML key order.
 */
export function editableMemoryHash(input: {
  content: string;
  category: string | null;
  status: 'live' | 'expired';
  subjects?: readonly string[] | undefined;
}): string {
  const subjects = subjectKeys(input.subjects ?? []);
  const canonical = JSON.stringify({
    content: input.content,
    category: input.category,
    status: input.status,
    ...(subjects.length > 0 ? { subjects } : {}),
  });
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/** Subject names as the keys they are compared by: each name once, sorted. */
export function subjectKeys(names: readonly string[]): string[] {
  return [...new Set(names.map(name => linkKey(subjectName(name))).filter(key => key !== ''))].sort();
}

/**
 * A block's `subjects` as typed: a list, one name, or nothing. An unquoted `[[Name]]` item is
 * read by YAML as a list holding a list; it is the link it was written as.
 */
export function subjectsFromYaml(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const one = (item: unknown): string | null => {
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'number') return String(item);
    if (Array.isArray(item) && item.length === 1 && Array.isArray(item[0]) && item[0].length === 1 && typeof item[0][0] === 'string') {
      return `[[${item[0][0]}]]`;
    }
    return null;
  };
  if (!Array.isArray(value)) {
    const name = one(value);
    return name === null ? null : name === '' ? [] : [name];
  }
  const names: string[] = [];
  for (const item of value) {
    const name = one(item);
    if (name === null) return null;
    if (name !== '') names.push(name);
  }
  return names;
}

function sameSubjects(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify(subjectKeys(a ?? [])) === JSON.stringify(subjectKeys(b ?? []));
}

// ---------------------------------------------------------------------------
// Row → block payload
// ---------------------------------------------------------------------------

/** Serialized payload for one canonical memory block (matches the plan's example). */
export interface MemoryBlockPayload {
  id: number;
  status: 'live' | 'expired';
  content: string;
  category: string | null;
  /** What the memory is about (#554): the names its subjects were given. Present only when it has some. */
  subjects?: string[];
  source: string;
  /**
   * The chat client that last wrote the row through the memory tools (#532). Present only
   * when there is one, so a block no chat client touched reads exactly as it did before.
   */
  changed_by?: string;
  scope: 'vault' | 'node';
  node_id: string | null;
  created_at: string;
  updated_at: string;
  valid_at: string | null;
  invalid_at: string | null;
  expired_at: string | null;
  expire_reason: string | null;
  superseded_by: number | null;
  predecessors: number[];
  evidence: {
    kind: string;
    node_id: string | null;
    ref: string | null;
    hash: string | null;
  };
  metadata: Record<string, unknown> | null;
  embedded: boolean;
}

/** Owner-draft payload (a `new:<uuid>` block). */
export interface NewMemoryBlockPayload {
  id: string; // "new:<uuid>"
  status: 'live';
  content: string;
  category: string | null;
  /** What the memory is about (#554), as typed. */
  subjects?: string[];
  scope: 'vault' | 'node';
  node_id: string | null;
}

export type ParsedBlockPayload = MemoryBlockPayload | NewMemoryBlockPayload;

function isOwnerDraft(p: ParsedBlockPayload): p is NewMemoryBlockPayload {
  return typeof p.id === 'string' && p.id.startsWith('new:');
}

export function rowToPayload(row: MemoryProjectionRow): MemoryBlockPayload {
  return {
    id: row.id,
    status: row.expired_at === null ? 'live' : 'expired',
    content: row.content,
    category: row.category,
    ...(row.subjects.length > 0 ? { subjects: row.subjects } : {}),
    source: row.source,
    ...(row.changed_by !== null ? { changed_by: row.changed_by } : {}),
    scope: row.scope,
    node_id: row.node_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    valid_at: row.valid_at,
    invalid_at: row.invalid_at,
    expired_at: row.expired_at,
    expire_reason: row.expire_reason,
    superseded_by: row.superseded_by,
    predecessors: row.predecessors,
    evidence: {
      kind: row.evidence_kind,
      node_id: row.evidence_node_id,
      ref: row.evidence_ref,
      hash: row.evidence_hash,
    },
    metadata: row.metadata,
    embedded: row.embedded,
  };
}

// ---------------------------------------------------------------------------
// Issue model (for the refresh warning callout)
// ---------------------------------------------------------------------------

export interface MemoryNoteIssue {
  block_key: string;
  outcome: 'rejected' | 'conflict' | 'duplicate';
  message: string;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface RenderedMemoryNote {
  /** Canonical bytes as emitted by the shared mutation-pipeline renderer. */
  bytes: string;
  /** sha256 of `bytes` (so callers can CAS without re-hashing). */
  hash: string;
  /** Raw SHA-256, matching `nodes.content_hash`. */
  content_hash: string;
  /** Body to pass to executeMutation (never includes frontmatter). */
  body: string;
  /** Projection fields to pass to executeMutation. */
  fields: Record<string, unknown>;
  live_count: number;
  historical_count: number;
  snapshot_at: string;
}

function sectionTitle(group: 'live-corrections' | 'live-other' | 'historical'): string {
  if (group === 'live-corrections') return 'Live — Rules, corrections and preferences';
  if (group === 'live-other') return 'Live — Other memories';
  return 'Historical — Expired and superseded';
}

function sectionFor(row: MemoryProjectionRow): 'live-corrections' | 'live-other' | 'historical' {
  if (row.expired_at !== null) return 'historical';
  const cat = row.category;
  if (cat === 'rule' || cat === 'correction' || cat === 'preference') return 'live-corrections';
  return 'live-other';
}

function sortRows(rows: MemoryProjectionRow[]): MemoryProjectionRow[] {
  return [...rows].sort((a, b) => {
    // source ASC, scope ASC, updated_at DESC, id DESC
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return b.id - a.id;
  });
}

/**
 * Choose a tilde-fence length strictly longer than any all-tilde line in the
 * serialized content. This guarantees arbitrary memory text (which could
 * itself contain `~~~~` lines) cannot close the fence.
 */
function chooseTildeFence(serializedPayload: string): string {
  let maxTildes = 3;
  for (const line of serializedPayload.split('\n')) {
    // YAML block scalars indent content, so strip leading whitespace before
    // checking for an all-tilde line (a line that is ONLY tildes after indent).
    const stripped = line.replace(/^\s+/, '');
    const m = stripped.match(/^([~]+)\s*$/);
    if (m) {
      const len = m[1]!.length;
      if (len >= maxTildes) maxTildes = len + 1;
    }
  }
  return '~'.repeat(maxTildes + 1);
}

function blockKey(id: number | string): string {
  return `mem:${id}`;
}

function renderBlock(payload: MemoryBlockPayload): string {
  const yaml = stringify(payload, YAML_STRINGIFY_OPTIONS);
  const fence = chooseTildeFence(yaml);
  const base = editableMemoryHash({
    content: payload.content,
    category: payload.category,
    status: payload.status,
    subjects: payload.subjects,
  });
  const open = `<!-- ve:memory:${payload.id} revision="${payload.updated_at}" base="${base}" -->`;
  const close = `<!-- /ve:memory:${payload.id} -->`;
  return `### Memory ${payload.id} — ${payload.category ?? 'uncategorized'}\n\n${open}\n${fence}yaml\n${yaml.trimEnd()}\n${fence}\n${close}`;
}

const DOCS_FOOTER = [
  '',
  '---',
  '',
  '## How this stays current',
  '',
  'The database is the source of truth; this note is an editable projection.',
  'Edits to `content`, `category`, `subjects` or `status` inside a block are ingested once',
  '(watcher or scheduled sweep). Removing a block is a no-op; to retire a memory',
  'set `status: expired`. Stale edits (a block whose `revision` no longer matches',
  'the row) are rejected — the newer database value wins and is rendered here on',
  'the next daily refresh. New blocks with `id: new:<uuid>` create live',
  '`source: owner` memories. See `docs/memory-markdown-log.md` in the repo for',
  'the complete format, scheduling, and recovery notes.',
  '',
].join('\n');

export function renderMemoryNote(
  snapshot: MemoryProjectionRow[],
  issues: MemoryNoteIssue[],
  opts: { snapshotAt?: string | undefined } = {},
): RenderedMemoryNote {
  const live = snapshot.filter((r) => r.expired_at === null);
  const historical = snapshot.filter((r) => r.expired_at !== null);
  const liveCorrections = sortRows(live.filter((r) => sectionFor(r) === 'live-corrections'));
  const liveOther = sortRows(live.filter((r) => sectionFor(r) === 'live-other'));
  const historicalSorted = sortRows(historical);

  // Deterministic snapshot_at: max(memory.updated_at) across the whole stock.
  // When the stock is empty, fall back to the caller-supplied value (or a
  // fixed epoch) so an empty note is still byte-stable across renders that
  // share the same input. Never wall-clock render time.
  const allTimestamps = snapshot.map((r) => r.updated_at).filter((t) => t !== null && t !== '');
  const snapshotAt = allTimestamps.length > 0
    ? allTimestamps.sort().at(-1)!
    : (opts.snapshotAt ?? '1970-01-01T00:00:00.000Z');

  const fields: Record<string, unknown> = {
    vault_engine_projection: 'memories',
    memory_log_version: MEMORY_LOG_VERSION,
    snapshot_at: snapshotAt,
    live_count: live.length,
    historical_count: historical.length,
  };
  const lines: string[] = [];

  if (issues.length > 0) {
    lines.push('> [!warning] Memory note ingest issues', '> Recent edits that were rejected, conflicted, or duplicate:');
    for (const i of issues) {
      lines.push(`> - \`${i.block_key}\` (${i.outcome}) — ${i.message}`);
    }
    lines.push('');
  }

  const sections: Array<[string, MemoryProjectionRow[]]> = [
    [sectionTitle('live-corrections'), liveCorrections],
    [sectionTitle('live-other'), liveOther],
    [sectionTitle('historical'), historicalSorted],
  ];
  for (const [title, rows] of sections) {
    lines.push(`## ${title}`, '');
    if (rows.length === 0) {
      lines.push('_None._', '');
      continue;
    }
    for (const row of rows) {
      lines.push(renderBlock(rowToPayload(row)), '');
    }
  }
  lines.push(DOCS_FOOTER);

  const body = lines.join('\n');
  // The projection must be a normal mutation-pipeline node: pass its body and
  // fields separately, then use the same pure renderer here for preview/hash
  // parity. All fields are intentionally schema-less orphan fields, so the
  // pipeline orders them by key exactly as this input does.
  const bytes = renderNode({
    types: [],
    fields,
    body,
    fieldOrdering: Object.keys(fields).sort().map((field) => ({ field, category: 'orphan' as const })),
    referenceFields: new Set(),
    listReferenceFields: new Set(),
    orphanRawValues: {},
    explicitNullFields: new Set(),
  });
  const content_hash = createHash('sha256').update(bytes).digest('hex');
  const hash = 'sha256:' + content_hash;
  return { bytes, hash, content_hash, body, fields, live_count: live.length, historical_count: historical.length, snapshot_at: snapshotAt };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParsedMemoryBlock {
  block_key: string;
  /** Numeric id for existing rows, or `new:<uuid>` string for owner drafts. */
  id: number | string;
  revision: string; // marker revision (updated_at for existing, "new" for drafts)
  base: string; // marker base hash
  payload: ParsedBlockPayload;
  /** 1-based line where the open marker sits (for error messages). */
  openLine: number;
}

export interface ParsedMemoryNote {
  ok: true;
  frontmatter: {
    memory_log_version?: number | undefined;
    snapshot_at?: string | undefined;
    live_count?: number | undefined;
    historical_count?: number | undefined;
  };
  blocks: ParsedMemoryBlock[];
}

export interface ParseFailure {
  ok: false;
  errors: Array<{ line: number; message: string }>;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const NEW_MEMORY_ID_RE = /^new:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const nullableString = z.string().nullable();
/** `subjects` as typed in a block: a list, one name, or nothing (#554). */
const subjectsField = z.unknown().transform((value, ctx) => {
  const names = subjectsFromYaml(value);
  if (names === null) {
    ctx.addIssue({ code: 'custom', message: 'subjects must be a list of names' });
    return z.NEVER;
  }
  return names;
}).optional();
const existingPayloadSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['live', 'expired']),
  content: z.string(),
  category: nullableString,
  subjects: subjectsField,
  source: z.string(),
  changed_by: z.string().optional(),
  scope: z.enum(['vault', 'node']),
  node_id: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  valid_at: nullableString,
  invalid_at: nullableString,
  expired_at: nullableString,
  expire_reason: nullableString,
  superseded_by: z.number().int().positive().nullable(),
  predecessors: z.array(z.number().int().positive()),
  evidence: z.object({ kind: z.string(), node_id: nullableString, ref: nullableString, hash: nullableString }).strict(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  embedded: z.boolean(),
}).strict();

const newPayloadSchema = z.object({
  id: z.string().regex(NEW_MEMORY_ID_RE, 'id must be new:<uuid>'),
  status: z.literal('live'),
  content: z.string().min(1),
  category: nullableString.optional().default(null),
  subjects: subjectsField,
  scope: z.enum(['vault', 'node']),
  node_id: nullableString.optional().default(null),
}).strict();

export function parseMemoryNote(raw: string): ParsedMemoryNote | ParseFailure {
  const lines = raw.split('\n');
  const errors: Array<{ line: number; message: string }> = [];
  let i = 0;

  // Frontmatter: optional `---`-delimited YAML at the very top.
  let frontmatter: ParsedMemoryNote['frontmatter'] = {};
  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j]?.trim() === '---') { end = j; break; }
    }
    if (end === -1) {
      return { ok: false, errors: [{ line: 1, message: 'frontmatter opened with --- but never closed' }] };
    }
    const fmYaml = lines.slice(1, end).join('\n');
    try {
      const parsed = parseYaml(fmYaml, YAML_PARSE_OPTIONS) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        frontmatter = {
          memory_log_version: typeof parsed['memory_log_version'] === 'number' ? parsed['memory_log_version'] : undefined,
          snapshot_at: typeof parsed['snapshot_at'] === 'string' ? parsed['snapshot_at'] : undefined,
          live_count: typeof parsed['live_count'] === 'number' ? parsed['live_count'] : undefined,
          historical_count: typeof parsed['historical_count'] === 'number' ? parsed['historical_count'] : undefined,
        };
        // `types` is intentionally empty in the canonical projection; the
        // projection marker is a normal frontmatter field.
        if (frontmatter.memory_log_version !== undefined && frontmatter.memory_log_version !== MEMORY_LOG_VERSION) {
          return { ok: false, errors: [{ line: 1, message: `unsupported memory_log_version ${frontmatter.memory_log_version}` }] };
        }
      }
    } catch (e) {
      return { ok: false, errors: [{ line: 1, message: `frontmatter YAML parse error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    i = end + 1;
  }

  const blocks: ParsedMemoryBlock[] = [];
  const seenIds = new Set<string>();
  const seenBlockKeys = new Set<string>();

  while (i < lines.length) {
    const line = lines[i]!;
    const openMatch = line.match(MARKER_OPEN_RE);
    if (!openMatch) { i++; continue; }

    const openLine = i + 1;
    const rawId = openMatch[1]!;
    const revision = openMatch[2]!;
    const base = openMatch[3]!;

    // Find the opening fence (tildes + optional info string) after the open marker.
    let fenceLine = -1;
    let fenceStr = '';
    for (let j = i + 1; j < lines.length; j++) {
      const fm = lines[j]!.match(TILDE_FENCE_OPEN_RE);
      if (fm) { fenceLine = j; fenceStr = fm[1]!; break; }
      // If we hit a close marker before a fence, this block is malformed.
      if (MARKER_CLOSE_RE.test(lines[j]!.trim())) break;
    }
    if (fenceLine === -1) {
      errors.push({ line: openLine, message: `memory ${rawId}: open marker has no tilde-fenced payload` });
      i++; continue;
    }
    // Find the closing fence (tildes only, same length) after the opening fence.
    let closeFenceLine = -1;
    for (let j = fenceLine + 1; j < lines.length; j++) {
      const fm = lines[j]!.match(TILDE_FENCE_CLOSE_RE);
      if (fm && fm[1] === fenceStr) { closeFenceLine = j; break; }
    }
    if (closeFenceLine === -1) {
      errors.push({ line: openLine, message: `memory ${rawId}: fenced payload is not closed` });
      i = fenceLine + 1; continue;
    }
    // Find the close marker after the closing fence.
    let closeMarkerLine = -1;
    for (let j = closeFenceLine + 1; j < lines.length; j++) {
      const cm = lines[j]!.match(MARKER_CLOSE_RE);
      if (cm && cm[1] === rawId) { closeMarkerLine = j; break; }
      // If a different close marker or another open marker intervenes, it's an overlap error.
      if (MARKER_OPEN_RE.test(lines[j]!.trim()) || (cm && cm[1] !== rawId)) break;
    }
    if (closeMarkerLine === -1) {
      errors.push({ line: openLine, message: `memory ${rawId}: open marker has no matching close marker` });
      i = closeFenceLine + 1; continue;
    }

    const yamlText = lines.slice(fenceLine + 1, closeFenceLine).join('\n');
    let payload: ParsedBlockPayload | null = null;
    try {
      payload = parseYaml(yamlText, YAML_PARSE_OPTIONS) as ParsedBlockPayload;
    } catch (e) {
      errors.push({ line: openLine, message: `memory ${rawId}: payload YAML parse error: ${e instanceof Error ? e.message : String(e)}` });
      i = closeMarkerLine + 1; continue;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      errors.push({ line: openLine, message: `memory ${rawId}: payload is not a YAML mapping` });
      i = closeMarkerLine + 1; continue;
    }

    const isDraftMarker = rawId.startsWith('new:');
    const schemaResult = isDraftMarker
      ? newPayloadSchema.safeParse(payload)
      : existingPayloadSchema.safeParse(payload);
    if (!schemaResult.success) {
      errors.push({ line: openLine, message: `memory ${rawId}: invalid payload (${schemaResult.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')})` });
      i = closeMarkerLine + 1; continue;
    }
    payload = schemaResult.data as ParsedBlockPayload;

    if (isDraftMarker ? revision !== 'new' : !ISO_TIMESTAMP_RE.test(revision)) {
      errors.push({ line: openLine, message: `memory ${rawId}: ${isDraftMarker ? 'owner drafts require revision="new"' : 'revision must be an ISO timestamp'}` });
      i = closeMarkerLine + 1; continue;
    }
    if (!isDraftMarker && !SHA256_RE.test(base)) {
      errors.push({ line: openLine, message: `memory ${rawId}: base must be a sha256 hash` });
      i = closeMarkerLine + 1; continue;
    }

    // Validate id consistency and dedupe.
    const payloadId = (payload as { id?: unknown }).id;
    if (payloadId === undefined || (typeof payloadId !== 'number' && typeof payloadId !== 'string')) {
      errors.push({ line: openLine, message: `memory ${rawId}: payload is missing an id` });
      i = closeMarkerLine + 1; continue;
    }
    const idKey = String(payloadId);
    if (idKey !== rawId) {
      errors.push({ line: openLine, message: `memory ${rawId}: marker id does not match payload id ${idKey}` });
      i = closeMarkerLine + 1; continue;
    }
    if (seenIds.has(idKey)) {
      errors.push({ line: openLine, message: `memory ${rawId}: duplicate id (already seen earlier in the note)` });
      i = closeMarkerLine + 1; continue;
    }
    const bk = blockKey(payloadId);
    if (seenBlockKeys.has(bk)) {
      errors.push({ line: openLine, message: `memory ${rawId}: duplicate block key ${bk}` });
      i = closeMarkerLine + 1; continue;
    }
    seenIds.add(idKey);
    seenBlockKeys.add(bk);

    blocks.push({ block_key: bk, id: payloadId as number | string, revision, base, payload: payload as ParsedBlockPayload, openLine });
    i = closeMarkerLine + 1;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, frontmatter, blocks };
}

// ---------------------------------------------------------------------------
// Validate: compare parsed blocks against the current snapshot
// ---------------------------------------------------------------------------

export type EditOp =
  | { kind: 'noop'; block_key: string; id: number | string; revision: string }
  /** A content, category or subjects edit (the name predates subjects, #554). */
  | { kind: 'content-or-category'; block_key: string; id: number; revision: string; before: MemoryBlockPayload; after: MemoryBlockPayload }
  | { kind: 'expire'; block_key: string; id: number; revision: string; before: MemoryBlockPayload; after: MemoryBlockPayload }
  | { kind: 'reactivate'; block_key: string; id: number; revision: string; before: MemoryBlockPayload; after: MemoryBlockPayload }
  | { kind: 'create-owner'; block_key: string; revision: string; draft: NewMemoryBlockPayload }
  | { kind: 'absent'; block_key: string; id: number }; // canonical block missing from note -> no-op (deletion-by-omission)

export interface NoteEditPlan {
  ok: true;
  ops: EditOp[];
}

export interface ValidationFailure {
  ok: false;
  errors: Array<{ block_key: string; message: string }>;
}

const READ_ONLY_FIELDS: Array<keyof MemoryBlockPayload> = [
  'source',
  'changed_by',
  'scope',
  'node_id',
  'created_at',
  'valid_at',
  'invalid_at',
  'expired_at',
  'expire_reason',
  'superseded_by',
  'predecessors',
  'evidence',
  'metadata',
  'embedded',
];

function readOnlyMismatch(before: MemoryBlockPayload, after: MemoryBlockPayload): string | null {
  for (const key of READ_ONLY_FIELDS) {
    const a = before[key];
    const b = after[key];
    // Deep-equal for objects/arrays, strict for scalars.
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      return `read-only field "${String(key)}" was changed (marker is a snapshot, not an edit surface for this field)`;
    }
  }
  return null;
}

/**
 * Compare parsed blocks against the current snapshot and produce an edit plan.
 * - Absent canonical blocks are no-ops (deletion-by-omission).
 * - Unchanged editable hash → no-op.
 * - Changed content/category/subjects → content-or-category op.
 * - Status-only change live→expired → expire op; expired→live → reactivate.
 * - A status transition combined with a content change is REJECTED (compound-edit rule).
 * - Read-only field changes are REJECTED.
 * - `new:<uuid>` blocks → create-owner ops.
 */
export function validateParsedMemoryNote(
  parsed: ParsedMemoryNote,
  snapshot: MemoryProjectionRow[],
): NoteEditPlan | ValidationFailure {
  const errors: Array<{ block_key: string; message: string }> = [];
  const ops: EditOp[] = [];
  const byId = new Map<number, MemoryProjectionRow>();
  for (const r of snapshot) byId.set(r.id, r);

  for (const block of parsed.blocks) {
    if (typeof block.id === 'string' && block.id.startsWith('new:')) {
      const draft = block.payload as NewMemoryBlockPayload;
      // Draft validation is light here — the ingest path (Task 5) does the
      // full node-scope/source-spoof checks. Surface structural problems.
      if (draft.content === undefined || (typeof draft.content === 'string' && draft.content.trim() === '')) {
        errors.push({ block_key: block.block_key, message: 'owner draft content is empty' });
        continue;
      }
      ops.push({ kind: 'create-owner', block_key: block.block_key, revision: block.revision, draft });
      continue;
    }

    const id = block.id as number;
    const row = byId.get(id);
    if (!row) {
      ops.push({ kind: 'noop', block_key: block.block_key, id, revision: block.revision });
      continue;
    }

    const before = rowToPayload(row);
    const after = block.payload as MemoryBlockPayload;
    const staleRevision = block.revision !== before.updated_at;

    // `updated_at` is immutable, but compare it with the marker revision
    // rather than the current row: a legitimately stale note still contains
    // the old timestamp and must reach the optimistic-concurrency conflict
    // path, not be rejected as a read-only-field edit.
    if (after.updated_at !== block.revision) {
      errors.push({ block_key: block.block_key, message: 'read-only field "updated_at" was changed' });
      continue;
    }

    const beforeHash = editableMemoryHash({ content: before.content, category: before.category, status: before.status, subjects: before.subjects });
    const afterHash = editableMemoryHash({ content: after.content, category: after.category, status: after.status, subjects: after.subjects });

    if (!staleRevision && block.base !== beforeHash) {
      errors.push({ block_key: block.block_key, message: 'marker base does not match the canonical editable snapshot' });
      continue;
    }

    // When the database has advanced, its read-only lineage/status fields may
    // naturally differ from the old block. A changed editable payload must be
    // classified then conflict at apply time; only a current revision can be
    // judged as a user edit to read-only values.
    if (!staleRevision) {
      const roError = readOnlyMismatch(before, after);
      if (roError) {
        errors.push({ block_key: block.block_key, message: roError });
        continue;
      }
    }

    // A block that still has its original editable fields is an echo/no-op,
    // even if the DB has advanced since its marker was rendered.
    if (afterHash === block.base) {
      ops.push({ kind: 'noop', block_key: block.block_key, id, revision: block.revision });
      continue;
    }

    if (beforeHash === afterHash) {
      ops.push({ kind: 'noop', block_key: block.block_key, id, revision: block.revision });
      continue;
    }

    const contentChanged = before.content !== after.content;
    const categoryChanged = before.category !== after.category;
    const subjectsChanged = !sameSubjects(before.subjects, after.subjects);
    const statusChanged = before.status !== after.status;

    if (!staleRevision && statusChanged && (contentChanged || categoryChanged || subjectsChanged)) {
      errors.push({
        block_key: block.block_key,
        message: 'a status transition may not be combined with a content, category or subjects change — split into two daily cycles',
      });
      continue;
    }

    if (statusChanged) {
      if (before.status === 'live' && after.status === 'expired') {
        ops.push({ kind: 'expire', block_key: block.block_key, id, revision: block.revision, before, after });
      } else if (before.status === 'expired' && after.status === 'live') {
        ops.push({ kind: 'reactivate', block_key: block.block_key, id, revision: block.revision, before, after });
      } else {
        errors.push({ block_key: block.block_key, message: `unsupported status transition ${before.status} → ${after.status}` });
      }
      continue;
    }

    if (contentChanged || categoryChanged || subjectsChanged) {
      ops.push({ kind: 'content-or-category', block_key: block.block_key, id, revision: block.revision, before, after });
      continue;
    }

    ops.push({ kind: 'noop', block_key: block.block_key, id, revision: block.revision });
  }

  // Deletion-by-omission: canonical rows whose blocks are absent from the note.
  const parsedIds = new Set(parsed.blocks.filter((b) => typeof b.id === 'number').map((b) => b.id as number));
  for (const row of snapshot) {
    if (!parsedIds.has(row.id)) {
      ops.push({ kind: 'absent', block_key: blockKey(row.id), id: row.id });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, ops };
}

export { blockKey, isOwnerDraft };
