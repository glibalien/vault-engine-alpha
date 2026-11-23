/**
 * M3 — inline cell edit + smart-confirm orchestration.
 *
 * Owns the dry-run → decide → commit/promote/stale/inline-error pipeline plus
 * the post-commit row patch, client-side undo, and STALE_NODE reload.
 *
 * This module mutates `UiState` in place and calls `Client`; `app.ts` awaits
 * these entry points and re-renders after each. Every write goes through the
 * real `update-node` tool (charter: DB is source of truth) —
 * including undo, which routes back through the same tools so disk stays in sync.
 *
 * Ported from the design prototype's attempt/commit/confirmPending/reload/undo
 * (.design-ref/project/app.jsx), adapted to real engine tool shapes + UiState.
 *
 * Flash keys (`${id}:${field}`) are recorded into `state.flash`; the 900ms clear
 * + re-render is scheduled by app.ts. This module only records the key.
 */
import type { Client } from "../client.js";
import type {
  UiState,
  CurrentNode,
  UpdateDryRunData,
  UpdateCommitData,
  StaleNodeDetails,
  Envelope,
} from "../types.js";
import { decideUpdate } from "../decide.js";
import { TITLE_FIELD } from "../types.js";

// ---- live overlay helpers (read post-commit overrides, fall back to row) ----
const liveVersion = (s: UiState, id: string, fallback: number): number =>
  s.versions[id] ?? fallback;

const liveTitle = (s: UiState, id: string, fallback: string | null): string =>
  s.titles[id] ?? fallback ?? "";

const liveField = (s: UiState, id: string, field: string, fallback: unknown): unknown =>
  s.values[id] && field in s.values[id] ? s.values[id]![field] : fallback;

// ---- flash key helper ----
const fkey = (id: string, field: string): string => `${id}:${field}`;

// ---- STALE capture: stash current_node for reloadRow, mark id stale ----
function handleStale(
  state: UiState,
  id: string,
  env: Extract<Envelope<unknown>, { ok: false }>,
): void {
  const details = env.error.details as StaleNodeDetails | undefined;
  if (details?.current_node) {
    state.staleNodes[id] = details.current_node;
  }
  state.staleSet.add(id);
  state.editing = null;
  state.pending = null;
  state.cellError = null;
}

/**
 * Begin an edit: for a normal field, dry-run → decide → commit/promote/stale/
 * inline-error; for the title, commit a rename directly (no dry-run first).
 */
export async function attemptEdit(
  state: UiState,
  client: Client,
  id: string,
  field: string,
  raw: unknown,
  row: { version: number; title: string | null; fields?: Record<string, unknown> },
): Promise<void> {
  const version = liveVersion(state, id, row.version);

  if (field === TITLE_FIELD) {
    await attemptTitle(state, client, id, raw, row, version);
    return;
  }

  const env = (await client.updateNode({
    node_id: id,
    set_fields: { [field]: raw === "" ? null : raw },
    expected_version: version,
    dry_run: true,
  })) as Envelope<UpdateDryRunData>;

  const d = decideUpdate(field, env);

  if (d.decision === "stale") {
    handleStale(state, id, env as Extract<Envelope<unknown>, { ok: false }>);
    return;
  }

  if (d.decision === "inline-error") {
    state.cellError = {
      id,
      field,
      code: d.error.code,
      message: d.error.message,
    };
    // editor stays open
    return;
  }

  if (d.decision === "promote") {
    // When the dry-run succeeded we have a coerced value + preview; when it
    // failed (uncorrelated error) there's no preview — guard both accesses.
    const coercedValue = env.ok
      ? env.data.preview.coerced_state[field]?.value ?? raw
      : raw;
    state.pending = {
      id,
      field,
      value: coercedValue,
      version,
      preview: env.ok ? env.data.preview : undefined,
      // Capture the row's ORIGINAL field value so confirmPending → commitField
      // can record a correct undo `prev` even on the first edit of this cell.
      prevValue: liveField(state, id, field, row.fields?.[field]),
      warnings: env.warnings,
      reasons: d.reasons,
    };
    state.editing = null;
    state.cellError = null;
    return;
  }

  // clean commit
  const coercedValue = env.ok
    ? env.data.preview.coerced_state[field]?.value ?? raw
    : raw;
  const title = liveTitle(state, id, row.title);
  const label = `set ${field} on "${title}"`;
  await commitField(state, client, id, field, coercedValue, version, label, row.fields?.[field]);
}

/**
 * Commit a field edit (dry_run:false). Records undo, patches live overlays +
 * version, records a flash key. Handles STALE / generic error on commit.
 */
async function commitField(
  state: UiState,
  client: Client,
  id: string,
  field: string,
  value: unknown,
  version: number,
  label: string,
  fallbackPrev: unknown,
): Promise<void> {
  // On the first edit of a cell there's no overlay in state.values; fall back
  // to the row's ORIGINAL field value so undo restores it (not null).
  const prev = liveField(state, id, field, fallbackPrev);

  const env2 = await client.updateNode({
    node_id: id,
    set_fields: { [field]: value === "" ? null : value },
    expected_version: version,
    dry_run: false,
  });

  if (!env2.ok) {
    if (env2.error.code === "STALE_NODE") {
      handleStale(state, id, env2);
    } else {
      state.cellError = {
        id,
        field,
        code: env2.error.code,
        message: env2.error.message,
      };
    }
    return;
  }

  const data = env2.data as UpdateCommitData;
  const committed = data.coerced_state[field]?.value ?? value;

  // record undo (prev = the live field value before this commit)
  state.recentOps.unshift({
    kind: "edit",
    nodeId: id,
    field,
    isTitle: false,
    prev,
    label,
  });

  if (!state.values[id]) state.values[id] = {};
  state.values[id]![field] = committed;
  state.versions[id] = data.version ?? version + 1;
  state.flash.add(fkey(id, field));

  state.editing = null;
  state.pending = null;
  state.cellError = null;
  state.selected = { id, field };
}

/** Title edit: direct update-node set_title commit (no engine dry-run). */
async function attemptTitle(
  state: UiState,
  client: Client,
  id: string,
  raw: unknown,
  row: { version: number; title: string | null },
  version: number,
): Promise<void> {
  const newTitle = String(raw).trim();
  if (newTitle === "") {
    state.cellError = {
      id,
      field: TITLE_FIELD,
      code: "REQUIRED_MISSING",
      message: "Title cannot be empty.",
    };
    // keep editing open
    return;
  }

  const env = await client.renameNode({
    node_id: id,
    new_title: newTitle,
    expected_version: version,
  });

  if (!env.ok) {
    if (env.error.code === "STALE_NODE") {
      handleStale(state, id, env);
    } else {
      state.cellError = {
        id,
        field: TITLE_FIELD,
        code: env.error.code,
        message: env.error.message,
      };
    }
    return;
  }

  const data = env.data;
  const prev = liveTitle(state, id, row.title);
  const refs = data.references_updated ?? 0;

  state.recentOps.unshift({
    kind: "edit",
    nodeId: id,
    field: TITLE_FIELD,
    isTitle: true,
    prev,
    label: `rename → "${data.title}"${refs ? ` (${refs} refs)` : ""}`,
  });

  state.titles[id] = data.title;
  state.versions[id] = data.version ?? version + 1;
  state.flash.add(fkey(id, TITLE_FIELD));

  state.editing = null;
  state.pending = null;
  state.cellError = null;
  state.selected = { id, field: TITLE_FIELD };
}

/** Confirm the promoted pending edit (field commit, or title rename). */
export async function confirmPending(state: UiState, client: Client): Promise<void> {
  const pending = state.pending;
  if (!pending) return;

  const { id, field, value, prevValue } = pending;
  // Use the live overlay version if a commit landed since promote; otherwise the
  // version captured on the pending edit at promote time (row may never have been
  // committed, so state.versions[id] can be absent — never fabricate 0).
  const version = liveVersion(state, id, pending.version);

  if (field === TITLE_FIELD) {
    state.pending = null;
    // Fall back to the original title captured at promote time so the rename's
    // undo `prev` restores it (not "") on a never-renamed row.
    const fallbackTitle =
      typeof prevValue === "string" ? prevValue : prevValue == null ? null : String(prevValue);
    await attemptTitle(state, client, id, value, { version, title: liveTitle(state, id, fallbackTitle) }, version);
    return;
  }

  const title = liveTitle(state, id, null);
  const label = `set ${field} on "${title}"`;
  state.pending = null;
  await commitField(state, client, id, field, value, version, label, prevValue);
}

/** Cancel the in-progress edit / pending preview / inline error. */
export function cancelEdit(state: UiState): void {
  state.editing = null;
  state.pending = null;
  state.cellError = null;
}

/**
 * Reload a stale row. Prefer the STALE-captured current_node; otherwise fetch
 * via get-node. Patch live overlays + version, drop the stale marker, clear edit.
 */
export async function reloadRow(state: UiState, client: Client, id: string): Promise<void> {
  let node: CurrentNode | undefined = state.staleNodes[id];

  if (!node) {
    const env = await client.getNode({ node_id: id });
    if (env.ok) node = env.data;
  }

  if (node) {
    state.values[id] = { ...node.fields };
    state.titles[id] = node.title ?? "";
    state.versions[id] = node.version;
  }

  delete state.staleNodes[id];
  state.staleSet.delete(id);
  state.editing = null;
  state.pending = null;
  state.cellError = null;
}

/**
 * Undo the most recent op. Edits/renames route the reverse write through the real
 * tool and patch the live overlays. A create is undone by deleting the node (the
 * inverse), which requires a re-query so the table reflects the deletion.
 * Best-effort: on failure the op is still popped (the prototype's optimistic behavior).
 *
 * Returns `{ refresh: true }` when the caller must re-run the query (create-undo),
 * `{ refresh: false }` when an in-place overlay patch is sufficient (edit/rename).
 */
export async function undoLast(state: UiState, client: Client): Promise<{ refresh: boolean }> {
  const op = state.recentOps.shift();
  if (!op) return { refresh: false };

  if (op.kind === "create") {
    // Inverse of create is delete. delete-node needs confirm:true to apply.
    // Best-effort; refresh regardless so the table reflects the truth.
    await client.deleteNode({ node_id: op.nodeId, confirm: true });
    return { refresh: true };
  }

  if (op.kind === "bulk") {
    const env = await client.batchMutate({ operations: op.inverse, dry_run: false });
    if (env.ok) return { refresh: true };
    return { refresh: false };
  }

  // `op` is now narrowed to the "edit" variant.
  const { nodeId: id, field, isTitle, prev } = op;
  // An undo op only exists after a successful commit/rename, both of which set
  // state.versions[id]. Guard anyway: if it's somehow absent, skip rather than
  // send a fabricated expected_version: 0.
  const version = state.versions[id];
  if (version === undefined) return { refresh: false };

  if (isTitle) {
    const prevTitle = String(prev ?? "").trim();
    if (prevTitle === "") return { refresh: false };
    const env = await client.renameNode({ node_id: id, new_title: prevTitle, expected_version: version });
    if (env.ok) {
      state.titles[id] = env.data.title;
      state.versions[id] = env.data.version ?? version + 1;
      state.flash.add(fkey(id, TITLE_FIELD));
    } else if (env.error.code === "STALE_NODE") {
      handleStale(state, id, env);
    }
    return { refresh: false };
  }

  const env = await client.updateNode({
    node_id: id,
    set_fields: { [field]: prev === "" || prev === undefined ? null : prev },
    expected_version: version,
    dry_run: false,
  });
  if (env.ok) {
    const data = env.data as UpdateCommitData;
    if (!state.values[id]) state.values[id] = {};
    state.values[id]![field] = data.coerced_state[field]?.value ?? prev;
    state.versions[id] = data.version ?? version + 1;
    state.flash.add(fkey(id, field));
  } else if (env.error.code === "STALE_NODE") {
    handleStale(state, id, env);
  }
  return { refresh: false };
}
