/**
 * useVizBulk — selection + batch-mutate orchestration hook for the VizTable.
 *
 * Ports the engine's imperative flows/bulk.ts orchestration as a React hook,
 * REUSING the already-extracted pure logic from query-core:
 *   - buildBulkOps(plan, rows): BatchOp[]
 *   - decideBulkDry(env, ops): BulkDryDecision
 *
 * Safety invariants (pinned by tests):
 *  BULK-INV-1: runDry goes batchMutate(dry_run:true) → decideBulkDry → pending or failed.
 *              NEVER commit without the dry-run+decide.
 *  BULK-INV-2: decideBulkDry "confirm" → set pending (NOT committed). Commit only in confirm().
 *  BULK-INV-3: decideBulkDry "failed" → set failed, do NOT commit.
 *  BULK-INV-4: buildBulkOps carries expected_version from each row's version per op.
 *  BULK-INV-5: confirm() → batchMutate(dry_run:false) → parse BatchResult[] → outcome{applied,stale}
 *              → onAfterCommit (refetch) → clear() selection.
 *  BULK-INV-6: busy GUARDS re-entry — early return in runDry and confirm when busy.
 *  BULK-INV-7: an Add link / Remove link plan (#285) edits one member of each selected row's
 *              list-of-references field with update-node `reference_edit`, never set_fields,
 *              so no row loses its other links. A member edit owns its transaction, so it
 *              can't ride batch-mutate: runDry previews every row (any refusal → failed, no
 *              writes), and confirm() commits row by row, counting applied, unchanged, stale
 *              (changed elsewhere) and failed rows. A rejected request (the connection failed)
 *              stops the commit: its row is uncertain, the rest are not attempted, and the
 *              partial outcome is still published and the board refreshed.
 */
import { useCallback, useReducer, useRef } from "react";
import { buildBulkOps, decideBulkDry } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type {
  BatchCommitData,
  BatchDryRunData,
  BatchOp,
  BatchResult,
  BulkPlan,
  Issue,
  ReferenceMemberEdit,
} from "@vault/query-core";
import type { Envelope } from "@vault/query-core";
import type { VizRow } from "./viz-spec.js";

// ============================================================================
// Public API surface
// ============================================================================

/** Add or remove one link in a list-of-references field on every selected row (#285). */
export interface LinkPlan {
  kind: "addLink" | "removeLink";
  field: string;
  /** The note to add or remove; null until picked. */
  target: { id: string; title: string } | null;
}

export type VizBulkPlan = BulkPlan | LinkPlan;

export const isLinkPlan = (plan: VizBulkPlan | null): plan is LinkPlan =>
  plan?.kind === "addLink" || plan?.kind === "removeLink";

export type BulkPicking = "field" | "value" | "addType" | "removeType" | "linkField" | "linkTarget" | null;

export interface BulkPendingState {
  wouldApply: number;
  warnings: Issue[];
  skippedNoVersion?: number;
  /** Link plans: rows that already have (add) or lack (remove) the link. */
  unchanged?: number;
}

export interface BulkOutcomeState {
  applied: number;
  stale: number;
  /** Link plans: rows the commit left alone, and rows it couldn't change. */
  unchanged?: number;
  failed?: number;
  /** Link plans whose commit stopped on a failed request: that row may or may not have changed,
   *  the rows after it were not attempted, and `error` says why. */
  uncertain?: number;
  notAttempted?: number;
  error?: string;
}

export interface VizBulkAPI {
  selected: Set<string>;
  selectedCount: number;
  isSelected(id: string): boolean;
  allSelected(rows: VizRow[]): boolean;
  toggleRow(id: string): void;
  toggleAll(rows: VizRow[]): void;
  clear(): void;

  plan: VizBulkPlan | null;
  picking: BulkPicking;
  pending: BulkPendingState | null;
  failed: { nodeId: string | null; message: string } | null;
  busy: boolean;
  outcome: BulkOutcomeState | null;

  pick(op: "setField" | "addType" | "removeType" | "addLink" | "removeLink"): void;
  setPlanField(field: string): void;
  setPlanValue(value: unknown): void;
  setPlanType(type: string): void;
  /** Link plans: the list-of-references field, then the note to add or remove. */
  setLinkField(field: string): void;
  setLinkTarget(target: { id: string; title: string }): void;

  runDry(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): void;
}

// ============================================================================
// Reducer state + actions (exported for direct unit testing)
// ============================================================================

export interface BulkReducerState {
  selected: Set<string>;
  plan: VizBulkPlan | null;
  picking: BulkPicking;
  pending: BulkPendingState | null;
  failed: { nodeId: string | null; message: string } | null;
  busy: boolean;
  outcome: BulkOutcomeState | null;
}

export type BulkAction =
  | { type: "TOGGLE_ROW"; id: string }
  | { type: "SELECT_ALL"; ids: string[] }
  | { type: "CLEAR_SELECTION" }
  | { type: "PICK"; mode: "field" | "value" | "addType" | "removeType" | "setField" | "addLink" | "removeLink" }
  | { type: "SET_PLAN_FIELD"; field: string }
  | { type: "SET_PLAN_VALUE"; value: unknown }
  | { type: "SET_PLAN_TYPE"; planKind: "addType" | "removeType"; typeName: string }
  | { type: "SET_LINK_FIELD"; field: string }
  | { type: "SET_LINK_TARGET"; target: { id: string; title: string } }
  | { type: "SET_BUSY"; busy: boolean }
  | { type: "SET_PENDING"; pending: BulkPendingState }
  | { type: "SET_FAILED"; failed: { nodeId: string | null; message: string } }
  | { type: "SET_OUTCOME"; outcome: BulkOutcomeState }
  | { type: "CANCEL" };

function initialState(): BulkReducerState {
  return {
    selected: new Set<string>(),
    plan: null,
    picking: null,
    pending: null,
    failed: null,
    busy: false,
    outcome: null,
  };
}

/**
 * reduceBulk — pure state machine for bulk selection + plan orchestration.
 * Exported so the state machine can be unit-tested without a renderer.
 */
export function reduceBulk(state: BulkReducerState, action: BulkAction): BulkReducerState {
  switch (action.type) {
    case "TOGGLE_ROW": {
      const next = new Set(state.selected);
      if (next.has(action.id)) {
        next.delete(action.id);
      } else {
        next.add(action.id);
      }
      return { ...state, selected: next };
    }

    case "SELECT_ALL":
      return { ...state, selected: new Set(action.ids) };

    case "CLEAR_SELECTION":
      return {
        ...state,
        selected: new Set<string>(),
        plan: null,
        picking: null,
        pending: null,
        failed: null,
        // outcome is intentionally preserved here — the confirm() flow sets outcome
        // BEFORE calling CLEAR_SELECTION, and the UI needs to read it after clear.
        // outcome is only reset by a new PICK action or explicit reset.
      };

    case "PICK": {
      if (action.mode === "addLink" || action.mode === "removeLink") {
        return { ...state, plan: { kind: action.mode, field: "", target: null }, picking: "linkField" };
      }
      const pickingMode =
        action.mode === "setField"
          ? ("field" as const)
          : action.mode === "addType"
          ? ("addType" as const)
          : ("removeType" as const);
      return { ...state, picking: pickingMode };
    }

    case "SET_PLAN_FIELD":
      return {
        ...state,
        plan: { kind: "setField", field: action.field, value: null },
        picking: "value",
      };

    case "SET_PLAN_VALUE": {
      if (!state.plan || state.plan.kind !== "setField") return state;
      return {
        ...state,
        plan: { kind: "setField", field: state.plan.field, value: action.value },
        picking: null,
      };
    }

    case "SET_PLAN_TYPE":
      return {
        ...state,
        plan: { kind: action.planKind, type: action.typeName },
        picking: null,
      };

    case "SET_LINK_FIELD":
      if (!isLinkPlan(state.plan)) return state;
      return { ...state, plan: { ...state.plan, field: action.field, target: null }, picking: "linkTarget" };

    case "SET_LINK_TARGET":
      if (!isLinkPlan(state.plan) || state.plan.field === "") return state;
      return { ...state, plan: { ...state.plan, target: action.target }, picking: null };

    case "SET_BUSY":
      return { ...state, busy: action.busy };

    case "SET_PENDING":
      return { ...state, pending: action.pending, failed: null };

    case "SET_FAILED":
      return { ...state, failed: action.failed, pending: null };

    case "SET_OUTCOME":
      return { ...state, outcome: action.outcome, pending: null, failed: null };

    case "CANCEL":
      return {
        ...state,
        plan: null,
        picking: null,
        pending: null,
        failed: null,
        // selection preserved; outcome preserved so caller can dismiss banner separately
      };
  }
}

// ============================================================================
// Pure helpers (exported for direct unit testing)
// ============================================================================

/**
 * parseDryDecision — thin wrapper around decideBulkDry for use in the hook.
 * Accepts any Envelope shape (ok or error) and the ops used.
 */
export function parseDryDecision(
  env: Envelope<BatchDryRunData>,
  ops: BatchOp[],
): ReturnType<typeof decideBulkDry> {
  return decideBulkDry(env as Envelope<BatchDryRunData>, ops);
}

/**
 * parseCommitOutcome — parse BatchResult[] into {applied, stale} counts.
 * applied = rows with status "applied"; stale = rows with status "stale".
 */
export function parseCommitOutcome(results: BatchResult[]): { applied: number; stale: number } {
  let applied = 0;
  let stale = 0;
  for (const r of results) {
    if (r.status === "applied") applied++;
    else if (r.status === "stale") stale++;
  }
  return { applied, stale };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The member edit a link plan makes on each row. */
export function linkEdit(plan: LinkPlan): ReferenceMemberEdit {
  return {
    field: plan.field,
    action: plan.kind === "addLink" ? "add" : "remove",
    target: { node_id: plan.target!.id },
  };
}

// ============================================================================
// useVizBulk hook
// ============================================================================

export function useVizBulk(
  client: Client,
  rows: Array<VizRow & { version?: number }>,
  onAfterCommit?: () => void,
): VizBulkAPI {
  const [state, dispatch] = useReducer(reduceBulk, undefined, initialState);

  // Stable refs so async closures see the latest state/callbacks
  const stateRef = useRef(state);
  stateRef.current = state;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const onAfterCommitRef = useRef(onAfterCommit);
  onAfterCommitRef.current = onAfterCommit;

  // Synchronous in-flight guard: blocks same-tick double-calls before React
  // flushes the SET_BUSY re-render (Fix 2 — BULK-INV-6 hardening).
  const inFlightRef = useRef(false);

  // ---- Selection ----

  const toggleRow = useCallback((id: string) => {
    dispatch({ type: "TOGGLE_ROW", id });
  }, []);

  const toggleAll = useCallback((vizRows: VizRow[]) => {
    const ids = vizRows.map((r) => r.id);
    const { selected } = stateRef.current;
    const allSel = ids.length > 0 && ids.every((id) => selected.has(id));
    if (allSel) {
      dispatch({ type: "CLEAR_SELECTION" });
    } else {
      dispatch({ type: "SELECT_ALL", ids });
    }
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: "CLEAR_SELECTION" });
  }, []);

  // ---- Plan building ----

  const pick = useCallback((op: "setField" | "addType" | "removeType" | "addLink" | "removeLink") => {
    dispatch({ type: "PICK", mode: op });
  }, []);

  const setLinkField = useCallback((field: string) => {
    dispatch({ type: "SET_LINK_FIELD", field });
  }, []);

  const setLinkTarget = useCallback((target: { id: string; title: string }) => {
    dispatch({ type: "SET_LINK_TARGET", target });
  }, []);

  const setPlanField = useCallback((field: string) => {
    dispatch({ type: "SET_PLAN_FIELD", field });
  }, []);

  const setPlanValue = useCallback((value: unknown) => {
    dispatch({ type: "SET_PLAN_VALUE", value });
  }, []);

  const setPlanType = useCallback((type: string) => {
    const { picking } = stateRef.current;
    const planKind: "addType" | "removeType" =
      picking === "addType" ? "addType" : "removeType";
    dispatch({ type: "SET_PLAN_TYPE", planKind, typeName: type });
  }, []);

  // ---- runDry (BULK-INV-1, BULK-INV-2, BULK-INV-3, BULK-INV-4) ----

  const runDry = useCallback(async (): Promise<void> => {
    // BULK-INV-6: busy guard — early return
    if (stateRef.current.busy) return;
    // Fix 2: same-tick re-entry guard (before React flushes SET_BUSY)
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const { plan, selected } = stateRef.current;
    if (!plan) {
      inFlightRef.current = false;
      return;
    }

    // Fix 1: PARTITION selected rows into versioned and version-less.
    // The engine's batch-mutate schema requires expected_version >= 1, so rows
    // without a numeric version would produce expected_version: 0 and fail Zod
    // validation — poisoning the ENTIRE batch (BATCH_FAILED for all).
    const allSelected = rowsRef.current.filter((r) => selected.has(r.id));
    const versionedRows = allSelected.filter((r) => typeof r.version === "number");
    const skippedNoVersion = allSelected.length - versionedRows.length;

    // All selected rows are version-less — surface as failed, do not send empty batch.
    if (versionedRows.length === 0) {
      dispatch({
        type: "SET_FAILED",
        failed: {
          nodeId: null,
          message: `All ${allSelected.length} selected row(s) have no version and cannot be mutated.`,
        },
      });
      inFlightRef.current = false;
      return;
    }

    // BULK-INV-7: a link plan previews each row's member edit; nothing is written.
    if (isLinkPlan(plan)) {
      if (plan.field === "" || plan.target === null) {
        inFlightRef.current = false;
        return;
      }
      const edit = linkEdit(plan);
      dispatch({ type: "SET_BUSY", busy: true });
      try {
        let wouldApply = 0;
        let unchanged = 0;
        const warnings: Issue[] = [];
        for (const r of versionedRows) {
          let env: Awaited<ReturnType<Client["previewReferenceMember"]>>;
          try {
            env = await client.previewReferenceMember({ node_id: r.id, reference_edit: edit, expected_version: r.version as number });
          } catch (err) {
            dispatch({ type: "SET_FAILED", failed: { nodeId: r.id, message: `${r.title}: ${errorText(err)}` } });
            return;
          }
          if (!env.ok) {
            dispatch({ type: "SET_FAILED", failed: { nodeId: r.id, message: `${r.title}: ${env.error.message}` } });
            return;
          }
          if (env.data.reference_edit.would_change) wouldApply++;
          else unchanged++;
          for (const w of env.warnings) {
            if (w.severity === "error" && !warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push(w);
          }
        }
        dispatch({
          type: "SET_PENDING",
          pending: {
            wouldApply,
            warnings,
            unchanged,
            ...(skippedNoVersion > 0 ? { skippedNoVersion } : {}),
          },
        });
      } finally {
        dispatch({ type: "SET_BUSY", busy: false });
        inFlightRef.current = false;
      }
      return;
    }

    // Build ops only from versioned rows (BULK-INV-4: each op carries expected_version)
    const ops = buildBulkOps(
      plan,
      versionedRows.map((r) => ({ id: r.id, version: r.version as number })),
    );

    dispatch({ type: "SET_BUSY", busy: true });

    try {
      // BULK-INV-1: dry-run FIRST
      const env = await client.batchMutate({ operations: ops, dry_run: true });
      const decision = parseDryDecision(env as Envelope<BatchDryRunData>, ops);

      if (decision.kind === "confirm") {
        // BULK-INV-2: set pending, NOT committed
        dispatch({
          type: "SET_PENDING",
          pending: {
            wouldApply: decision.wouldApply,
            warnings: decision.warnings,
            ...(skippedNoVersion > 0 ? { skippedNoVersion } : {}),
          },
        });
      } else {
        // BULK-INV-3: set failed, do NOT commit
        dispatch({
          type: "SET_FAILED",
          failed: { nodeId: decision.nodeId, message: decision.message },
        });
      }
    } finally {
      dispatch({ type: "SET_BUSY", busy: false });
      inFlightRef.current = false;
    }
  }, [client]);

  // ---- confirm (BULK-INV-5) ----

  const confirm = useCallback(async (): Promise<void> => {
    // BULK-INV-6: busy guard — early return
    if (stateRef.current.busy) return;
    // Fix 2: same-tick re-entry guard (before React flushes SET_BUSY)
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const { plan, pending, selected } = stateRef.current;
    if (!plan || !pending) {
      inFlightRef.current = false;
      return;
    }

    // Mirror runDry's partition: only send versioned rows (version-less were
    // already skipped at dry-run time, so this just keeps parity).
    const selectedRows = rowsRef.current
      .filter((r) => selected.has(r.id) && typeof r.version === "number")
      .map((r) => ({ id: r.id, version: r.version as number }));

    if (selectedRows.length === 0) {
      inFlightRef.current = false;
      return;
    }

    // BULK-INV-7: commit each row's member edit; one row's refusal doesn't stop the rest.
    if (isLinkPlan(plan)) {
      if (plan.target === null) {
        inFlightRef.current = false;
        return;
      }
      const edit = linkEdit(plan);
      dispatch({ type: "SET_BUSY", busy: true });
      try {
        const outcome: BulkOutcomeState = { applied: 0, stale: 0, unchanged: 0, failed: 0 };
        for (let i = 0; i < selectedRows.length; i++) {
          const r = selectedRows[i]!;
          let env: Awaited<ReturnType<Client["editReferenceMember"]>>;
          try {
            env = await client.editReferenceMember({ node_id: r.id, reference_edit: edit, expected_version: r.version });
          } catch (err) {
            // The request may have been applied before the connection failed.
            outcome.uncertain = 1;
            outcome.notAttempted = selectedRows.length - i - 1;
            outcome.error = errorText(err);
            break;
          }
          if (!env.ok) {
            if (env.error.code === "STALE_NODE") outcome.stale++;
            else outcome.failed = (outcome.failed ?? 0) + 1;
          } else if (env.data.reference_edit.changed) {
            outcome.applied++;
          } else {
            outcome.unchanged = (outcome.unchanged ?? 0) + 1;
          }
        }
        dispatch({ type: "SET_OUTCOME", outcome });
        if (outcome.applied > 0 || outcome.uncertain) onAfterCommitRef.current?.();
        dispatch({ type: "CLEAR_SELECTION" });
      } finally {
        dispatch({ type: "SET_BUSY", busy: false });
        inFlightRef.current = false;
      }
      return;
    }

    const ops = buildBulkOps(plan, selectedRows);

    dispatch({ type: "SET_BUSY", busy: true });

    try {
      // BULK-INV-5: commit
      const env = await client.batchMutate({ operations: ops, dry_run: false });

      if (!env.ok) {
        dispatch({
          type: "SET_FAILED",
          failed: {
            nodeId:
              (env.error.details?.failed_at != null
                ? ops[(env.error.details.failed_at as number)]?.params.node_id ?? null
                : null),
            message: env.error.message,
          },
        });
        return;
      }

      const results = (env.data as BatchCommitData).results;
      const outcome = parseCommitOutcome(results);

      // BULK-INV-5: set outcome
      dispatch({ type: "SET_OUTCOME", outcome });

      // BULK-INV-5: call onAfterCommit so the table refetches
      onAfterCommitRef.current?.();

      // BULK-INV-5: clear selection
      dispatch({ type: "CLEAR_SELECTION" });
    } finally {
      dispatch({ type: "SET_BUSY", busy: false });
      inFlightRef.current = false;
    }
  }, [client]);

  // ---- cancel ----

  const cancel = useCallback(() => {
    dispatch({ type: "CANCEL" });
  }, []);

  // ---- Return API ----

  return {
    selected: state.selected,
    selectedCount: state.selected.size,
    isSelected: (id: string) => state.selected.has(id),
    allSelected: (vizRows: VizRow[]) => {
      const rowIds = vizRows.map((r) => r.id);
      return rowIds.length > 0 && rowIds.every((id) => state.selected.has(id));
    },
    toggleRow,
    toggleAll,
    clear,

    plan: state.plan,
    picking: state.picking,
    pending: state.pending,
    failed: state.failed,
    busy: state.busy,
    outcome: state.outcome,

    pick,
    setPlanField,
    setPlanValue,
    setPlanType,
    setLinkField,
    setLinkTarget,
    runDry,
    confirm,
    cancel,
  };
}
