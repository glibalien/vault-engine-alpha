/**
 * New-node draft lifecycle + the "+ New <type>" create pipeline.
 *
 * Sibling of flows/edit.ts, but for creation: a draft has no node_id, so its
 * cells collect values locally into UiState.draft until commit. Commit runs the
 * real create-node tool dry-run → decideCreate → (inline-error | promote | create),
 * mirroring the inline-edit smart-confirm. On success the caller re-queries (the
 * new node lands via refresh, not optimistic insert — create-node returns no
 * version) and records a client-side undo whose inverse is delete-node.
 *
 * Guided (eager) fill: the draft walks title → each required-without-default
 * field via auto-advance (mountEditor is one-shot, so one editor is open at a
 * time). Optional fields can be opened by clicking their cell. The commit trigger
 * is the "✓ Create" affordance / Enter when no editor is open (wired in app.ts).
 */
import type { Client } from "../client.js";
import type {
  UiState, DraftState, Schema, Envelope, CreateDryRunData, CreateCommitData, RecentOp,
} from "../types.js";
import { decideCreate } from "../decide-create.js";
import { TITLE_FIELD } from "../types.js";
import { seedFieldsFromFilters } from "./seed.js";

export type DraftCommitResult = { kind: "created"; title: string } | { kind: "stay" };

// ---- pure guided-sequence helpers -----------------------------------------

/** Required fields the schema can't auto-default — the cells the user MUST fill. */
export function requiredDraftCells(schema: Schema): string[] {
  return schema.fields
    .filter(f => f.required && (f.default_value === null || f.default_value === undefined))
    .map(f => f.name);
}

/** Full guided order: title first, then each required-without-default field. */
export function draftSequence(schema: Schema): string[] {
  return [TITLE_FIELD, ...requiredDraftCells(schema)];
}

function filled(draft: DraftState, cell: string): boolean {
  const v = cell === TITLE_FIELD ? draft.title : draft.fields[cell];
  return v !== undefined && v !== null && String(v).trim() !== "";
}

/** Next guided cell after `from`: the first later sequence cell still unfilled. */
export function nextDraftCell(schema: Schema, draft: DraftState, from: string): string | null {
  const seq = draftSequence(schema);
  const start = seq.indexOf(from);
  for (let i = start + 1; i < seq.length; i++) {
    if (!filled(draft, seq[i]!)) return seq[i]!;
  }
  return null;
}

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === "" || v == null) continue;
    out[k] = v;
  }
  return out;
}

// ---- lifecycle -------------------------------------------------------------

export function startDraft(state: UiState): void {
  // Abandon any in-progress normal-cell edit / pending pill / cell error so the
  // draft row and a normal-cell editor never coexist (they'd both grab Enter).
  state.editing = null;
  state.pending = null;
  state.cellError = null;
  state.draft = { title: "", fields: seedDraftFields(state), editing: TITLE_FIELD, error: null, pending: null, busy: false };
}

/** Seed the new draft's fields from the active filters for the locked type, so
 *  a node created in a filtered view defaults to satisfying those filters.
 *  Defensive against a partially-built state (no lock / schema / filters yet):
 *  returns {} so the draft simply opens empty. */
function seedDraftFields(state: UiState): Record<string, unknown> {
  const type = state.lockedType;
  if (!type) return {};
  const schema = state.schemaCache?.get(type);
  if (!schema) return {};
  return seedFieldsFromFilters(schema, state.filtersByType?.[type] ?? [], state.callerFragments ?? []);
}

export function cancelDraft(state: UiState): void {
  state.draft = null;
}

/** Open a specific draft cell for editing (click-to-edit, incl. optional fields). */
export function editDraftCell(state: UiState, field: string): void {
  if (state.draft) { state.draft.editing = field; state.draft.pending = null; }
}

/**
 * Store a draft cell's value, clear any error on it, then auto-advance the open
 * editor to the next required-unfilled cell (or close it when the guided
 * sequence is done).
 */
export function setDraftField(state: UiState, schema: Schema, field: string, raw: unknown): void {
  const d = state.draft;
  if (!d) return;
  if (field === TITLE_FIELD) {
    d.title = typeof raw === "string" ? raw : String(raw ?? "");
  } else if (raw === "" || raw == null) {
    delete d.fields[field];
  } else {
    d.fields[field] = raw;
  }
  if (d.error && d.error.field === field) d.error = null;
  d.editing = nextDraftCell(schema, d, field);
}

// ---- commit ----------------------------------------------------------------

export async function commitDraft(state: UiState, client: Client): Promise<DraftCommitResult> {
  const d = state.draft;
  if (!d || d.busy) return { kind: "stay" };

  const title = d.title.trim();
  if (!title) {
    d.error = { field: TITLE_FIELD, code: "REQUIRED_MISSING", message: "Title is required." };
    d.editing = TITLE_FIELD;
    d.pending = null;
    return { kind: "stay" };
  }

  const type = state.lockedType;
  if (!type) return { kind: "stay" }; // add-row only renders when locked; defensive

  const fields = cleanFields(d.fields);
  d.busy = true;
  try {
    const env = (await client.createNode({ title, types: [type], fields, dry_run: true })) as Envelope<CreateDryRunData>;
    const dec = decideCreate(env);

    if (dec.decision === "inline-error") {
      d.error = dec.error;
      d.editing = dec.error.field;
      d.pending = null;
      return { kind: "stay" };
    }
    if (dec.decision === "promote") {
      d.pending = { reasons: dec.reasons };
      d.editing = null;
      d.error = null;
      return { kind: "stay" };
    }
    return await finalizeCreate(state, client, title, type, fields);
  } finally {
    // Reset the in-flight flag. finalizeCreate nulls state.draft on success, so
    // only reset when the draft is still present (a "stay" outcome).
    if (state.draft) state.draft.busy = false;
  }
}

export async function confirmCreate(state: UiState, client: Client): Promise<DraftCommitResult> {
  const d = state.draft;
  if (!d || d.busy || !d.pending) return { kind: "stay" };
  const title = d.title.trim();
  const type = state.lockedType;
  if (!title || !type) return { kind: "stay" };
  d.busy = true;
  try {
    return await finalizeCreate(state, client, title, type, cleanFields(d.fields));
  } finally {
    if (state.draft) state.draft.busy = false;
  }
}

async function finalizeCreate(
  state: UiState,
  client: Client,
  title: string,
  type: string,
  fields: Record<string, unknown>,
): Promise<DraftCommitResult> {
  const env = (await client.createNode({ title, types: [type], fields, dry_run: false })) as Envelope<CreateCommitData>;
  if (!env.ok) {
    const field = (env.error.details as { field?: string } | undefined)?.field ?? TITLE_FIELD;
    if (state.draft) {
      state.draft.error = { field, code: env.error.code, message: env.error.message };
      state.draft.editing = field;
      state.draft.pending = null;
    }
    return { kind: "stay" };
  }
  const op: RecentOp = { kind: "create", nodeId: env.data.node_id, label: `create "${title}"` };
  state.recentOps.unshift(op);
  state.draft = null;
  return { kind: "created", title };
}
