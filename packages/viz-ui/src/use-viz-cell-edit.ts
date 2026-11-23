/**
 * useVizCellEdit — mutation orchestration hook for the VizTable.
 *
 * Ports the engine's imperative flows/edit.ts orchestration as a React hook,
 * reusing the already-extracted, tested `decideUpdate` from query-core.
 *
 * Safety invariants (pinned by tests):
 *  INV-1: field edit goes updateNode(dry_run:true) → decideUpdate → only THEN
 *         commit (updateNode(dry_run:false)). NEVER commit without dry-run+decide.
 *  INV-2: promote → set pending, do NOT commit until confirmPending().
 *  INV-3: inline-error → set cellError, keep editing open (do not commit).
 *  INV-4: STALE → add to staleSet + capture current_node; never overwrite stale node.
 *  INV-5: every mutation sends expected_version; missing → getNode first; still absent
 *         → cellError + ABORT.
 *  INV-6: title (TITLE_FIELD) → renameNode (no dry-run); empty → cellError pre-flight.
 *          Optimistic: title overlay applied immediately (busy released), rename fires in
 *          the background, and rolls back on failure.
 *  INV-7: on commit success: overlay values/titles/versions, flash, 900ms clear, onAfterCommit.
 *  INV-8: a list-of-references member edit (#285) commits one add or remove through
 *         update-node `reference_edit`, never set_fields, so the other members stay
 *         exactly as stored. It skips the dry run: the engine refuses a member edit
 *         that would change anything else on the node. It sends expected_version
 *         (INV-5), plus the content hash for a removal; the editor stays open.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { decideUpdate } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type {
  CellError,
  CellRef,
  CurrentNode,
  PendingEdit,
  StaleNodeDetails,
  UpdateCommitData,
  UpdateDryRunData,
} from "@vault/query-core";
import { TITLE_FIELD } from "@vault/query-core";
import type { Envelope } from "@vault/query-core";
import type { VizRow } from "./viz-spec.js";

// ============================================================================
// Overlay state (exported for pure reducer tests)
// ============================================================================

export interface VizCellEditOverlay {
  /** Per-node field value overrides after commit. */
  values: Record<string, Record<string, unknown>>;
  /** Per-node title overrides after rename. */
  titles: Record<string, string>;
  /** Per-node version tracking (bumped on every successful commit/rename). */
  versions: Record<string, number>;
  /** Node ids blocked by STALE_NODE; cleared by reloadRow. */
  staleSet: Set<string>;
  /** current_node captured from STALE_NODE errors; consumed by reloadRow. */
  staleNodes: Record<string, CurrentNode>;
  /** Flash keys `"${id}:${field}"` for recently committed cells. */
  flash: Set<string>;
  /** Currently open cell editor. */
  editing: CellRef | null;
  /** Promote-confirm awaiting explicit user Confirm. */
  pending: PendingEdit | null;
  /** Field-scoped inline error; keeps editor open. */
  cellError: CellError | null;
  /** True while an async mutation is in flight. */
  busy: boolean;
}

// ============================================================================
// Public API surface
// ============================================================================

export interface VizCellEditAPI {
  /** Current cell value: overlay overrides row.fields. */
  cellValue(row: VizRow, field: string): unknown;
  /** Current cell title: overlay overrides row.title. */
  cellTitle(row: VizRow): string;
  editing: CellRef | null;
  pending: PendingEdit | null;
  cellError: CellError | null;
  isStale(id: string): boolean;
  isFlashing(id: string, field: string): boolean;
  /** True when editing !== null OR pending !== null (poll-pause signal). */
  isEditing: boolean;
  busy: boolean;
  beginEdit(id: string, field: string): void;
  /**
   * Commit this cell. `meta.via === "enter"` marks a deliberate Enter rather than a
   * mouse pick/blur; `useVizCellEdit` ignores it (a real row commits either way),
   * the draft adapter uses it to decide whether Enter should create the row.
   */
  submitEdit(row: VizRow, field: string, raw: unknown, meta?: { via?: "enter" }): Promise<void>;
  /**
   * Record a value WITHOUT committing it. Optional: present only on an API whose
   * cells can hold an uncommitted value — today that is the draft row's adapter,
   * where every cell is local until the single create goes out. `useVizCellEdit`
   * itself does NOT implement it: a real row has nowhere to stage to, so its cell
   * editors keep committing (Tab included).
   */
  stageEdit?(row: VizRow, field: string, raw: unknown): void;
  /**
   * Add or remove one member of a list-of-references cell (INV-8). Optional:
   * only `useVizCellEdit` has it. A row whose API lacks it (the draft row, whose
   * node doesn't exist yet) keeps the one-value editor.
   */
  editReferenceMember?(row: VizRow, field: string, edit: ReferenceMemberChange): Promise<void>;
  confirmPending(): Promise<void>;
  cancelEdit(): void;
  reloadRow(row: VizRow): Promise<void>;
}

/** One change to a list-of-references cell: add a picked note, or remove a member
 *  by its stored text. */
export type ReferenceMemberChange =
  | { action: "add"; nodeId: string }
  | { action: "remove"; storedValue: string };

// ============================================================================
// Pure reducer helpers (exported for direct unit testing)
// ============================================================================

const fkey = (id: string, field: string): string => `${id}:${field}`;

/**
 * applyCommit — pure state transition for a successful field commit.
 * Overlays the committed value, bumps version, records flash key, clears editor.
 */
export function applyCommit(
  state: VizCellEditOverlay,
  id: string,
  field: string,
  value: unknown,
  version: number,
): VizCellEditOverlay {
  const prevValues = state.values[id] ?? {};
  return {
    ...state,
    values: {
      ...state.values,
      [id]: { ...prevValues, [field]: value },
    },
    versions: { ...state.versions, [id]: version },
    flash: new Set([...state.flash, fkey(id, field)]),
    editing: null,
    pending: null,
    cellError: null,
  };
}

/**
 * applyMemberCommit — like applyCommit, for a list-of-references member edit:
 * the list editor stays open so several links can be changed in a row.
 */
export function applyMemberCommit(
  state: VizCellEditOverlay,
  id: string,
  field: string,
  value: unknown,
  version: number,
): VizCellEditOverlay {
  return { ...applyCommit(state, id, field, value, version), editing: state.editing };
}

/**
 * applyTitleCommit — pure state transition for a successful rename.
 * Overlays the new title, bumps version, records flash key for TITLE_FIELD.
 */
export function applyTitleCommit(
  state: VizCellEditOverlay,
  id: string,
  newTitle: string,
  version: number,
): VizCellEditOverlay {
  return {
    ...state,
    titles: { ...state.titles, [id]: newTitle },
    versions: { ...state.versions, [id]: version },
    flash: new Set([...state.flash, fkey(id, TITLE_FIELD)]),
    editing: null,
    pending: null,
    cellError: null,
  };
}

/**
 * applyStale — pure state transition for a STALE_NODE response.
 * Adds id to staleSet, captures current_node (if any), clears editor/pending/error.
 */
export function applyStale(
  state: VizCellEditOverlay,
  id: string,
  currentNode: CurrentNode | undefined,
): VizCellEditOverlay {
  const nextStaleSet = new Set(state.staleSet);
  nextStaleSet.add(id);
  const nextStaleNodes = currentNode
    ? { ...state.staleNodes, [id]: currentNode }
    : { ...state.staleNodes };
  return {
    ...state,
    staleSet: nextStaleSet,
    staleNodes: nextStaleNodes,
    editing: null,
    pending: null,
    cellError: null,
  };
}

// ============================================================================
// Reducer for overlay state
// ============================================================================

type OverlayAction =
  | { type: "BEGIN_EDIT"; ref: CellRef }
  | { type: "CANCEL" }
  | { type: "SET_BUSY"; busy: boolean }
  | { type: "SET_CELL_ERROR"; error: CellError }
  | { type: "SET_PENDING"; pending: PendingEdit }
  | { type: "APPLY_COMMIT"; id: string; field: string; value: unknown; version: number }
  | { type: "APPLY_MEMBER_COMMIT"; id: string; field: string; value: unknown; version: number }
  | { type: "APPLY_TITLE_COMMIT"; id: string; newTitle: string; version: number }
  | { type: "ROLLBACK_TITLE"; id: string; prevTitle: string; prevVersion: number }
  | { type: "APPLY_STALE"; id: string; currentNode: CurrentNode | undefined }
  | { type: "CLEAR_FLASH"; key: string }
  | { type: "CLEAR_STALE"; id: string; node: CurrentNode | undefined }
  | { type: "PATCH_NODE"; id: string; node: CurrentNode };

function initialOverlay(): VizCellEditOverlay {
  return {
    values: {},
    titles: {},
    versions: {},
    staleSet: new Set(),
    staleNodes: {},
    flash: new Set(),
    editing: null,
    pending: null,
    cellError: null,
    busy: false,
  };
}

function overlayReducer(state: VizCellEditOverlay, action: OverlayAction): VizCellEditOverlay {
  switch (action.type) {
    case "BEGIN_EDIT":
      return { ...state, editing: action.ref, cellError: null };

    case "CANCEL":
      return { ...state, editing: null, pending: null, cellError: null };

    case "SET_BUSY":
      return { ...state, busy: action.busy };

    case "SET_CELL_ERROR":
      return { ...state, cellError: action.error };

    case "SET_PENDING":
      return { ...state, pending: action.pending, editing: null, cellError: null };

    case "APPLY_COMMIT":
      return applyCommit(state, action.id, action.field, action.value, action.version);

    case "APPLY_MEMBER_COMMIT":
      return applyMemberCommit(state, action.id, action.field, action.value, action.version);

    case "APPLY_TITLE_COMMIT":
      return applyTitleCommit(state, action.id, action.newTitle, action.version);

    case "ROLLBACK_TITLE":
      return {
        ...state,
        titles: { ...state.titles, [action.id]: action.prevTitle },
        versions: { ...state.versions, [action.id]: action.prevVersion },
      };

    case "APPLY_STALE":
      return applyStale(state, action.id, action.currentNode);

    case "CLEAR_FLASH": {
      const next = new Set(state.flash);
      next.delete(action.key);
      return { ...state, flash: next };
    }

    case "PATCH_NODE": {
      const n = action.node;
      return {
        ...state,
        values: { ...state.values, [action.id]: { ...n.fields } },
        titles: { ...state.titles, [action.id]: n.title ?? "" },
        versions: { ...state.versions, [action.id]: n.version },
      };
    }

    case "CLEAR_STALE": {
      const nextStaleSet = new Set(state.staleSet);
      nextStaleSet.delete(action.id);
      const nextStaleNodes = { ...state.staleNodes };
      delete nextStaleNodes[action.id];
      return {
        ...state,
        staleSet: nextStaleSet,
        staleNodes: nextStaleNodes,
        editing: null,
        pending: null,
        cellError: null,
      };
    }
  }
}

// ============================================================================
// Helper: resolve version from overlay or row; getNode if absent
// ============================================================================

async function resolveVersion(
  overlay: VizCellEditOverlay,
  id: string,
  rowVersion: number | undefined,
  client: Client,
): Promise<{ version: number } | { error: CellError }> {
  // Check overlay first, then row
  const tracked = overlay.versions[id] ?? rowVersion;
  if (typeof tracked === "number") return { version: tracked };

  // Version absent — fetch via getNode (INV-5)
  const env = await client.getNode({ node_id: id });
  if (!env.ok) {
    return {
      error: {
        id,
        field: "version",
        code: "VERSION_UNKNOWN",
        message: `Cannot determine version for node ${id}: ${env.error.message}`,
      },
    };
  }
  const v = env.data.version;
  if (typeof v !== "number") {
    return {
      error: {
        id,
        field: "version",
        code: "VERSION_UNKNOWN",
        message: `Node ${id} has no version in get-node response.`,
      },
    };
  }
  return { version: v };
}

// ============================================================================
// Helper: extract current_node from a STALE_NODE error envelope
// ============================================================================

function extractCurrentNode(
  env: Extract<Envelope<unknown>, { ok: false }>,
): CurrentNode | undefined {
  const details = env.error.details as StaleNodeDetails | undefined;
  return details?.current_node;
}

// ============================================================================
// useVizCellEdit hook
// ============================================================================

export function useVizCellEdit(
  client: Client,
  onAfterCommit?: () => void,
): VizCellEditAPI {
  const [overlay, dispatch] = useReducer(overlayReducer, undefined, initialOverlay);

  // Stable ref to the latest overlay so async closures read current state
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  // Stable ref to onAfterCommit to avoid stale closure issues
  const onAfterCommitRef = useRef(onAfterCommit);
  onAfterCommitRef.current = onAfterCommit;

  // Track pending flash timers so they can be cleared on unmount (Fix 2)
  const flashTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Clear all pending flash timers on unmount
  useEffect(() => () => {
    for (const t of flashTimers.current) clearTimeout(t);
  }, []);

  // ---- cellValue / cellTitle overlay reads ----
  const cellValue = useCallback((row: VizRow, field: string): unknown => {
    const ov = overlayRef.current;
    const nodeVals = ov.values[row.id];
    if (nodeVals && field in nodeVals) return nodeVals[field];
    return row.fields[field];
  }, []);

  const cellTitle = useCallback((row: VizRow): string => {
    const ov = overlayRef.current;
    return ov.titles[row.id] ?? row.title;
  }, []);

  // ---- beginEdit ----
  const beginEdit = useCallback((id: string, field: string) => {
    dispatch({ type: "BEGIN_EDIT", ref: { id, field } });
  }, []);

  // ---- cancelEdit ----
  const cancelEdit = useCallback(() => {
    dispatch({ type: "CANCEL" });
  }, []);

  // ---- Internal: commit a field (dry_run:false) ----
  const commitField = useCallback(async (
    id: string,
    field: string,
    value: unknown,
    version: number,
  ): Promise<void> => {
    // INVARIANT: `value === "" ? null : value` must stay identical here (commit) and
    // in the dry-run call below — both must coerce empty string to null the same way.
    const env2 = await client.updateNode({
      node_id: id,
      set_fields: { [field]: value === "" ? null : value },
      expected_version: version,
      dry_run: false,
    });

    if (!env2.ok) {
      if (env2.error.code === "STALE_NODE") {
        const currentNode = extractCurrentNode(env2);
        dispatch({ type: "APPLY_STALE", id, currentNode });
      } else {
        dispatch({
          type: "SET_CELL_ERROR",
          error: { id, field, code: env2.error.code, message: env2.error.message },
        });
      }
      return;
    }

    const data = env2.data as UpdateCommitData;
    const committed = data.coerced_state[field]?.value ?? value;
    const newVersion = data.version ?? version + 1;
    dispatch({ type: "APPLY_COMMIT", id, field, value: committed, version: newVersion });

    // Schedule flash clear after 900ms (INV-7); track for unmount cleanup
    const key = fkey(id, field);
    const tid = setTimeout(() => {
      flashTimers.current.delete(tid);
      dispatch({ type: "CLEAR_FLASH", key });
    }, 900);
    flashTimers.current.add(tid);

    onAfterCommitRef.current?.();
  }, [client]);

  // ---- Internal: commit a title rename (used by confirmPending) ----
  const commitTitle = useCallback(async (
    id: string,
    newTitle: string,
    version: number,
  ): Promise<void> => {
    const env = await client.renameNode({
      node_id: id,
      new_title: newTitle,
      expected_version: version,
    });

    if (!env.ok) {
      if (env.error.code === "STALE_NODE") {
        const currentNode = extractCurrentNode(env);
        dispatch({ type: "APPLY_STALE", id, currentNode });
      } else {
        dispatch({
          type: "SET_CELL_ERROR",
          error: { id, field: TITLE_FIELD, code: env.error.code, message: env.error.message },
        });
      }
      return;
    }

    const data = env.data;
    const newVersion = data.version ?? version + 1;
    dispatch({ type: "APPLY_TITLE_COMMIT", id, newTitle: data.title, version: newVersion });

    // Schedule flash clear for TITLE_FIELD after 900ms; track for unmount cleanup
    const key = fkey(id, TITLE_FIELD);
    const tid = setTimeout(() => {
      flashTimers.current.delete(tid);
      dispatch({ type: "CLEAR_FLASH", key });
    }, 900);
    flashTimers.current.add(tid);

    onAfterCommitRef.current?.();
  }, [client]);

  // ---- submitEdit ----
  const submitEdit = useCallback(async (
    row: VizRow,
    field: string,
    raw: unknown,
  ): Promise<void> => {
    // Re-entry guard (Fix 1): discard concurrent submits while a mutation is in flight
    if (overlayRef.current.busy) return;
    const id = row.id;
    dispatch({ type: "SET_BUSY", busy: true });

    // Flag: set to true when the title path releases busy early so the finally skips it.
    let busyReleasedByTitlePath = false;

    try {
      // Resolve version — ABORT if we can't obtain it (INV-5)
      const versionResult = await resolveVersion(overlayRef.current, id, row.version, client);
      if ("error" in versionResult) {
        dispatch({ type: "SET_CELL_ERROR", error: versionResult.error });
        return;
      }
      const version = versionResult.version;

      // ---- Title path: optimistic rename (INV-6) ----
      // Pre-flight empty-title check — abort before any optimistic change.
      if (field === TITLE_FIELD) {
        const newTitle = String(raw).trim();
        if (newTitle === "") {
          dispatch({
            type: "SET_CELL_ERROR",
            error: {
              id,
              field: TITLE_FIELD,
              code: "REQUIRED_MISSING",
              message: "Title cannot be empty.",
            },
          });
          return;
        }

        // Capture previous title for rollback.
        const prevTitle = overlayRef.current.titles[id] ?? row.title;

        // Apply optimistically: show new title immediately, close editor.
        dispatch({ type: "APPLY_TITLE_COMMIT", id, newTitle, version: version + 1 });

        // Release busy NOW so other edits are not blocked during the slow rename.
        busyReleasedByTitlePath = true;
        dispatch({ type: "SET_BUSY", busy: false });

        // Background commit + rollback (fire-and-forget from submitEdit).
        void (async () => {
          const env = await client.renameNode({
            node_id: id,
            new_title: newTitle,
            expected_version: version,
          });

          if (!env.ok) {
            // Roll back to previous title and version.
            dispatch({ type: "ROLLBACK_TITLE", id, prevTitle, prevVersion: version });
            if (env.error.code === "STALE_NODE") {
              const currentNode = extractCurrentNode(env);
              dispatch({ type: "APPLY_STALE", id, currentNode });
            } else {
              dispatch({
                type: "SET_CELL_ERROR",
                error: { id, field: TITLE_FIELD, code: env.error.code, message: env.error.message },
              });
            }
            return;
          }

          // Reconcile server title + version.
          const data = env.data;
          const newVersion = data.version ?? version + 1;
          dispatch({ type: "APPLY_TITLE_COMMIT", id, newTitle: data.title, version: newVersion });

          // Schedule flash clear for TITLE_FIELD after 900ms; track for unmount cleanup.
          const key = fkey(id, TITLE_FIELD);
          const tid = setTimeout(() => {
            flashTimers.current.delete(tid);
            dispatch({ type: "CLEAR_FLASH", key });
          }, 900);
          flashTimers.current.add(tid);

          onAfterCommitRef.current?.();
        })();

        return;
      }

      // ---- Field path: dry-run → decide → commit/promote/inline-error/stale (INV-1) ----
      const dryEnv = (await client.updateNode({
        node_id: id,
        set_fields: { [field]: raw === "" ? null : raw },
        expected_version: version,
        dry_run: true,
      })) as Envelope<UpdateDryRunData>;

      const decision = decideUpdate(field, dryEnv);

      if (decision.decision === "stale") {
        // INV-4
        const currentNode = extractCurrentNode(dryEnv as Extract<Envelope<unknown>, { ok: false }>);
        dispatch({ type: "APPLY_STALE", id, currentNode });
        return;
      }

      if (decision.decision === "inline-error") {
        // INV-3 — keep editing open
        dispatch({
          type: "SET_CELL_ERROR",
          error: { id, field, code: decision.error.code, message: decision.error.message },
        });
        return;
      }

      if (decision.decision === "promote") {
        // INV-2 — set pending, do NOT commit yet
        const coercedValue = dryEnv.ok
          ? dryEnv.data.preview.coerced_state[field]?.value ?? raw
          : raw;
        const pendingEdit: PendingEdit = {
          id,
          field,
          value: coercedValue,
          version,
          preview: dryEnv.ok ? dryEnv.data.preview : undefined,
          prevValue: row.fields[field],
          warnings: dryEnv.warnings,
          reasons: decision.reasons,
        };
        dispatch({ type: "SET_PENDING", pending: pendingEdit });
        return;
      }

      // "commit" decision — proceed to real commit (INV-1)
      const coercedValue = dryEnv.ok
        ? dryEnv.data.preview.coerced_state[field]?.value ?? raw
        : raw;
      await commitField(id, field, coercedValue, version);
    } finally {
      // The title path releases busy early (before the background rename); skip here.
      if (!busyReleasedByTitlePath) {
        dispatch({ type: "SET_BUSY", busy: false });
      }
    }
  }, [client, commitField, commitTitle]);

  // ---- editReferenceMember (INV-8) ----
  const editReferenceMember = useCallback(async (
    row: VizRow,
    field: string,
    change: ReferenceMemberChange,
  ): Promise<void> => {
    if (overlayRef.current.busy) return;
    const id = row.id;
    dispatch({ type: "SET_BUSY", busy: true });
    try {
      const versionResult = await resolveVersion(overlayRef.current, id, row.version, client);
      if ("error" in versionResult) {
        dispatch({ type: "SET_CELL_ERROR", error: versionResult.error });
        return;
      }
      const version = versionResult.version;

      // Removing by stored text needs the content hash as well as the version. Read
      // it fresh; the version we send still refuses a node that moved on.
      let contentHash: string | undefined;
      if (change.action === "remove") {
        const env = await client.getNode({ node_id: id });
        const hash = env.ok ? env.data.metadata?.content_hash : undefined;
        if (typeof hash !== "string" || hash === "") {
          dispatch({
            type: "SET_CELL_ERROR",
            error: {
              id, field, code: env.ok ? "VERSION_UNKNOWN" : env.error.code,
              message: env.ok ? `Node ${id} has no content hash in get-node response.` : env.error.message,
            },
          });
          return;
        }
        contentHash = hash;
      }

      const env = await client.editReferenceMember({
        node_id: id,
        reference_edit: {
          field,
          action: change.action,
          target: change.action === "add" ? { node_id: change.nodeId } : { stored_value: change.storedValue },
        },
        expected_version: version,
        ...(contentHash !== undefined ? { expected_content_hash: contentHash } : {}),
      });

      if (!env.ok) {
        if (env.error.code === "STALE_NODE") {
          dispatch({ type: "APPLY_STALE", id, currentNode: extractCurrentNode(env) });
        } else {
          dispatch({
            type: "SET_CELL_ERROR",
            error: { id, field, code: env.error.code, message: env.error.message },
          });
        }
        return;
      }

      // Already present / already absent: nothing was written.
      if (!env.data.reference_edit.changed) return;

      const value = env.data.coerced_state[field]?.value ?? [];
      dispatch({ type: "APPLY_MEMBER_COMMIT", id, field, value, version: env.data.version });

      const key = fkey(id, field);
      const tid = setTimeout(() => {
        flashTimers.current.delete(tid);
        dispatch({ type: "CLEAR_FLASH", key });
      }, 900);
      flashTimers.current.add(tid);

      onAfterCommitRef.current?.();
    } finally {
      dispatch({ type: "SET_BUSY", busy: false });
    }
  }, [client]);

  // ---- confirmPending ----
  const confirmPendingFn = useCallback(async (): Promise<void> => {
    // Re-entry guard (Fix 1): discard if already busy
    if (overlayRef.current.busy) return;
    const pending = overlayRef.current.pending;
    if (!pending) return;

    const { id, field, value, version: capturedVersion } = pending;
    // Use live overlay version if available (a commit may have landed since promote)
    const version = overlayRef.current.versions[id] ?? capturedVersion;

    dispatch({ type: "CANCEL" }); // clear pending before async work
    dispatch({ type: "SET_BUSY", busy: true });

    try {
      if (field === TITLE_FIELD) {
        await commitTitle(id, String(value), version);
      } else {
        await commitField(id, field, value, version);
      }
    } finally {
      dispatch({ type: "SET_BUSY", busy: false });
    }
  }, [commitField, commitTitle]);

  // ---- reloadRow ----
  const reloadRow = useCallback(async (row: VizRow): Promise<void> => {
    const id = row.id;
    dispatch({ type: "SET_BUSY", busy: true });

    try {
      let node: CurrentNode | undefined = overlayRef.current.staleNodes[id];

      if (!node) {
        const env = await client.getNode({ node_id: id });
        if (env.ok) node = env.data;
      }

      if (node) {
        dispatch({ type: "PATCH_NODE", id, node });
      }

      dispatch({ type: "CLEAR_STALE", id, node });
    } finally {
      dispatch({ type: "SET_BUSY", busy: false });
    }
  }, [client]);

  return {
    cellValue,
    cellTitle,
    editing: overlay.editing,
    pending: overlay.pending,
    cellError: overlay.cellError,
    isStale: (id: string) => overlay.staleSet.has(id),
    isFlashing: (id: string, field: string) => overlay.flash.has(fkey(id, field)),
    isEditing: overlay.editing !== null || overlay.pending !== null,
    busy: overlay.busy,
    beginEdit,
    submitEdit,
    editReferenceMember,
    confirmPending: confirmPendingFn,
    cancelEdit,
    reloadRow,
  };
}
