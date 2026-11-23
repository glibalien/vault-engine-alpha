/**
 * useVizDraft — new-node draft create orchestration hook for the VizTable.
 *
 * Rebuilds the engine's imperative flows/create.ts draft orchestration as a
 * React hook, REUSING the already-extracted pure logic from query-core:
 *   - requiredDraftCells(schema), draftSequence(schema), nextDraftCell(schema, draft, from)
 *   - decideCreate(env) → {decision:"create"|"promote"|"inline-error"; reasons; error?}
 *   - Client.createNode({title, types, fields?, dry_run?})
 *
 * Mutation-safety invariants (pinned by tests):
 *  DRAFT-INV-1: A draft create goes createNode(dry_run:true) → decideCreate(env)
 *               → ONLY THEN: create→commit(dry_run:false) / promote→set pending
 *               (NOT committed) / inline-error→set error (draft stays open, NO node).
 *               NEVER create without the dry-run+decide.
 *  DRAFT-INV-2: confirmCreate() is the ONLY other path to createNode(dry_run:false).
 *  DRAFT-INV-3: A non-empty title is REQUIRED: commit() with empty/blank title
 *               sets an inline-error on TITLE_FIELD and does NOT call createNode.
 *  DRAFT-INV-4: createNode is always called with types:[lockedType].
 *  DRAFT-INV-5: On real create (commit succeeded): call onAfterCreate (table
 *               refetches) + close the draft (cancel).
 *  DRAFT-INV-6: busy + synchronous inFlightRef GUARD re-entry at the START of
 *               commit, commitWithTitle and confirmCreate (the 5a lesson — guard
 *               before the dispatch flushes, so a dropped submit changes NOTHING,
 *               not even the displayed title).
 */
import { useCallback, useReducer, useRef } from "react";
import {
  nextDraftCell,
} from "@vault/query-core";
import { decideCreate } from "@vault/query-core";
import type { Client } from "@vault/query-core";
import type {
  DraftState,
  DraftError,
  Schema,
  Envelope,
  CreateDryRunData,
} from "@vault/query-core";
import { TITLE_FIELD } from "@vault/query-core";
import type { VizRow } from "./viz-spec.js";

// ============================================================================
// Public API surface
// ============================================================================

export interface VizDraftAPI {
  draft: DraftState | null;
  isDrafting: boolean;
  /** Successful creates so far this mount — a change means "a row was just created". */
  createdCount: number;
  start(seedFields?: Record<string, unknown>): void;
  editCell(field: string): void;
  setField(field: string, raw: unknown): void;
  /**
   * Stage the title. By default the guided sequence auto-advances `editing` to the
   * next unfilled required cell; pass `{ advance: false }` to leave the cursor where
   * it is — the Tab path does, because the TABLE's column-order Tab nav decides
   * where the cursor goes next and would otherwise be fighting the guided jump.
   */
  setTitle(raw: string, opts?: { advance?: boolean }): void;
  commit(): Promise<void>;
  /** Commit using `title` directly, without depending on a setTitle render. */
  commitWithTitle(title: string): Promise<void>;
  /** Stage `field` and commit in one step — Enter in a field cell of a titled draft. */
  commitWithField(field: string, raw: unknown): Promise<void>;
  confirmCreate(): Promise<void>;
  cancel(): void;
  /** Close the active field cell editor WITHOUT discarding the draft. */
  exitEdit(): void;
}

// ============================================================================
// Reducer state + actions (exported for direct unit testing)
// ============================================================================

export interface DraftReducerState {
  draft: DraftState | null;
  createdCount: number;
}

export type DraftAction =
  | { type: "START"; seedFields?: Record<string, unknown> }
  | { type: "CANCEL" }
  | { type: "CLOSE"; created?: boolean }
  | { type: "EDIT_CELL"; field: string }
  | { type: "EXIT_EDIT" }
  | { type: "SET_TITLE"; value: string; nextEditing: string | null }
  | { type: "SET_FIELD"; field: string; value: unknown; nextEditing: string | null }
  | { type: "SET_ERROR"; error: DraftError }
  | { type: "SET_PENDING"; reasons: string[] }
  | { type: "SET_BUSY"; busy: boolean };

/**
 * reduceDraft — pure state machine for the new-node draft create lifecycle.
 * Exported so the state machine can be unit-tested without a renderer.
 */
export function reduceDraft(state: DraftReducerState, action: DraftAction): DraftReducerState {
  switch (action.type) {
    case "START":
      return {
        ...state,
        draft: {
          title: "",
          fields: { ...(action.seedFields ?? {}) },
          editing: TITLE_FIELD,
          error: null,
          pending: null,
          busy: false,
        },
      };

    case "CANCEL":
      return { ...state, draft: null };

    case "CLOSE":
      return { ...state, draft: null, createdCount: state.createdCount + (action.created ? 1 : 0) };

    case "EDIT_CELL": {
      if (!state.draft) return state;
      return {
        ...state,
        draft: { ...state.draft, editing: action.field, pending: null },
      };
    }

    case "EXIT_EDIT": {
      if (!state.draft) return state;
      return {
        ...state,
        draft: { ...state.draft, editing: null },
      };
    }

    case "SET_TITLE": {
      if (!state.draft) return state;
      const clearError =
        state.draft.error?.field === TITLE_FIELD ? null : state.draft.error;
      return {
        ...state,
        draft: {
          ...state.draft,
          title: action.value,
          editing: action.nextEditing,
          error: clearError,
        },
      };
    }

    case "SET_FIELD": {
      if (!state.draft) return state;
      const fields = { ...state.draft.fields };
      if (action.value === "" || action.value == null) {
        delete fields[action.field];
      } else {
        fields[action.field] = action.value;
      }
      const clearError =
        state.draft.error?.field === action.field ? null : state.draft.error;
      return {
        ...state,
        draft: {
          ...state.draft,
          fields,
          editing: action.nextEditing,
          error: clearError,
        },
      };
    }

    case "SET_ERROR": {
      if (!state.draft) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          editing: action.error.field,
          error: action.error,
          pending: null,
        },
      };
    }

    case "SET_PENDING": {
      if (!state.draft) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          pending: { reasons: action.reasons },
          editing: null,
          error: null,
        },
      };
    }

    case "SET_BUSY": {
      if (!state.draft) return state;
      return {
        ...state,
        draft: { ...state.draft, busy: action.busy },
      };
    }
  }
}

// ============================================================================
// Pure helper (exported for direct unit testing)
// ============================================================================

/**
 * parseCreateDecision — thin wrapper around decideCreate for use in the hook.
 * Accepts any Envelope shape (ok or error envelope for CreateDryRunData).
 */
export function parseCreateDecision(
  env: Envelope<CreateDryRunData>,
): ReturnType<typeof decideCreate> {
  return decideCreate(env);
}

// ============================================================================
// Helpers
// ============================================================================

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === "" || v == null) continue;
    out[k] = v;
  }
  return out;
}

function initialState(): DraftReducerState {
  return { draft: null, createdCount: 0 };
}

// ============================================================================
// buildCreatedRow (exported pure helper)
// ============================================================================

/** Build a VizRow from a successful create-node response + the committed fields. */
export function buildCreatedRow(
  data: { node_id: string; file_path?: string },
  title: string,
  fields: Record<string, unknown>,
  lockedType: string,
): VizRow {
  return {
    id: data.node_id,
    title,
    file_path: data.file_path ?? "",
    types: [lockedType],
    fields,
    // version omitted — new nodes start at 1; useVizCellEdit.resolveVersion fills it if edited.
  };
}

// ============================================================================
// useVizDraft hook
// ============================================================================

export function useVizDraft(
  client: Client,
  lockedType: string,
  schema: Schema,
  onAfterCreate?: (created: VizRow) => void,
): VizDraftAPI {
  const [state, dispatch] = useReducer(reduceDraft, undefined, initialState);

  // Stable refs so async closures see the latest state/callbacks
  const stateRef = useRef(state);
  stateRef.current = state;

  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  const onAfterCreateRef = useRef(onAfterCreate);
  onAfterCreateRef.current = onAfterCreate;

  // Synchronous in-flight guard: blocks same-tick double-calls before React
  // flushes the SET_BUSY re-render (DRAFT-INV-6 hardening — the 5a lesson).
  const inFlightRef = useRef(false);

  // ---- start ----------------------------------------------------------------

  const start = useCallback((seedFields?: Record<string, unknown>) => {
    dispatch({ type: "START", seedFields });
  }, []);

  // ---- cancel ---------------------------------------------------------------

  const cancel = useCallback(() => {
    dispatch({ type: "CANCEL" });
  }, []);

  // ---- exitEdit -------------------------------------------------------------

  const exitEdit = useCallback(() => {
    dispatch({ type: "EXIT_EDIT" });
  }, []);

  // ---- editCell -------------------------------------------------------------

  const editCell = useCallback((field: string) => {
    dispatch({ type: "EDIT_CELL", field });
  }, []);

  // ---- setTitle -------------------------------------------------------------

  const setTitle = useCallback((raw: string, opts?: { advance?: boolean }) => {
    const d = stateRef.current.draft;
    if (!d) return;
    const value = typeof raw === "string" ? raw : String(raw ?? "");
    // Build a temporary draft to compute nextDraftCell
    const tempDraft = { ...d, title: value };
    const nextEditing = opts?.advance === false
      ? d.editing
      : nextDraftCell(schemaRef.current, tempDraft, TITLE_FIELD);
    dispatch({ type: "SET_TITLE", value, nextEditing });
  }, []);

  // ---- setField -------------------------------------------------------------

  const setField = useCallback((field: string, raw: unknown) => {
    const d = stateRef.current.draft;
    if (!d) return;
    // Build a temporary draft to compute nextDraftCell
    const fields =
      raw === "" || raw == null
        ? (({ [field]: _ignored, ...rest }) => rest)(d.fields)
        : { ...d.fields, [field]: raw };
    const tempDraft = { ...d, fields };
    const nextEditing = nextDraftCell(schemaRef.current, tempDraft, field);
    dispatch({ type: "SET_FIELD", field, value: raw, nextEditing });
  }, []);

  // ---- commit (DRAFT-INV-1 through DRAFT-INV-6) ----------------------------

  /** Apply one field edit to a fields map, matching setField's delete-on-empty rule. */
  const withField = (
    fields: Record<string, unknown>,
    field: string,
    raw: unknown,
  ): Record<string, unknown> => {
    if (raw === "" || raw == null) {
      const { [field]: _dropped, ...rest } = fields;
      return rest;
    }
    return { ...fields, [field]: raw };
  };

  /**
   * The one create path. `fieldsOverride` lets a caller commit a value whose
   * dispatch has not flushed yet — the same reason the title travels as an
   * argument. When absent the draft's own staged fields are used.
   */
  const commitTitle = useCallback(async (
    rawTitle: string,
    fieldsOverride?: Record<string, unknown>,
  ): Promise<void> => {
    // DRAFT-INV-6: busy guard — early return before any dispatch
    if (stateRef.current.draft?.busy) return;
    // Synchronous in-flight guard (before React flushes SET_BUSY)
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const d = stateRef.current.draft;
    if (!d) {
      inFlightRef.current = false;
      return;
    }

    // DRAFT-INV-3: non-empty title required
    const title = rawTitle.trim();
    if (!title) {
      dispatch({
        type: "SET_ERROR",
        error: { field: TITLE_FIELD, code: "REQUIRED_MISSING", message: "Title is required." },
      });
      inFlightRef.current = false;
      return;
    }

    const fields = cleanFields(fieldsOverride ?? d.fields);
    dispatch({ type: "SET_BUSY", busy: true });

    try {
      // DRAFT-INV-1: dry-run FIRST — never create without dry-run+decide
      const env = (await client.createNode({
        title,
        types: [lockedType],   // DRAFT-INV-4
        fields,
        dry_run: true,
      })) as Envelope<CreateDryRunData>;

      const dec = parseCreateDecision(env);

      if (dec.decision === "inline-error") {
        // DRAFT-INV-1: inline-error → set error, draft stays open, NO commit
        dispatch({ type: "SET_ERROR", error: dec.error });
        return;
      }

      if (dec.decision === "promote") {
        // DRAFT-INV-1: promote → set pending (NOT committed)
        dispatch({ type: "SET_PENDING", reasons: dec.reasons });
        return;
      }

      // "create" → commit (dry_run:false)
      await finalizeCreate(client, lockedType, title, fields, dispatch, onAfterCreateRef);
    } finally {
      // Only reset busy when draft is still present (finalize nulls it on success)
      if (stateRef.current.draft) {
        dispatch({ type: "SET_BUSY", busy: false });
      }
      inFlightRef.current = false;
    }
  }, [client, lockedType]);

  const commit = useCallback(
    (): Promise<void> => commitTitle(stateRef.current.draft?.title ?? ""),
    [commitTitle],
  );

  const commitWithTitle = useCallback(
    async (title: string): Promise<void> => {
      // DRAFT-INV-6: guard BEFORE the dispatch. commitTitle re-checks (it is also
      // reached via commit()), but a dropped submit must not repaint the row with a
      // title that is never going to be created — the create in flight is the older
      // one, and its title is what the draft is about to act on.
      if (stateRef.current.draft?.busy || inFlightRef.current) return;
      // Keep the row's displayed title in step with what we are creating. The
      // create itself uses the argument, so it does not depend on this dispatch
      // having flushed (the reason commitWithTitle exists at all).
      dispatch({ type: "SET_TITLE", value: title, nextEditing: null });
      await commitTitle(title);
    },
    [commitTitle],
  );

  const commitWithField = useCallback(
    async (field: string, raw: unknown): Promise<void> => {
      // DRAFT-INV-6: guard before any dispatch, as commitWithTitle does.
      if (stateRef.current.draft?.busy || inFlightRef.current) return;
      const d = stateRef.current.draft;
      if (!d) return;
      const fields = withField(d.fields, field, raw);
      // Show the value in its cell; the create uses the merged map above, so it
      // does not depend on this dispatch having flushed.
      dispatch({ type: "SET_FIELD", field, value: raw, nextEditing: null });
      await commitTitle(d.title, fields);
    },
    [commitTitle],
  );

  // ---- confirmCreate (DRAFT-INV-2) -----------------------------------------

  const confirmCreate = useCallback(async (): Promise<void> => {
    // DRAFT-INV-6: busy guard — early return before any dispatch
    if (stateRef.current.draft?.busy) return;
    // Synchronous in-flight guard
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const d = stateRef.current.draft;
    if (!d || !d.pending) {
      inFlightRef.current = false;
      return;
    }

    const title = d.title.trim();
    if (!title) {
      inFlightRef.current = false;
      return;
    }

    const fields = cleanFields(d.fields);
    dispatch({ type: "SET_BUSY", busy: true });

    try {
      // DRAFT-INV-2: this is the ONLY other path to createNode(dry_run:false)
      await finalizeCreate(client, lockedType, title, fields, dispatch, onAfterCreateRef);
    } finally {
      if (stateRef.current.draft) {
        dispatch({ type: "SET_BUSY", busy: false });
      }
      inFlightRef.current = false;
    }
  }, [client, lockedType]);

  // ---- Return API -----------------------------------------------------------

  return {
    draft: state.draft,
    isDrafting: state.draft !== null,
    createdCount: state.createdCount,
    start,
    editCell,
    setTitle,
    setField,
    commit,
    commitWithTitle,
    commitWithField,
    confirmCreate,
    cancel,
    exitEdit,
  };
}

// ============================================================================
// Shared finalize helper (not exported — internal to the hook module)
// ============================================================================

async function finalizeCreate(
  client: Client,
  lockedType: string,
  title: string,
  fields: Record<string, unknown>,
  dispatch: (action: DraftAction) => void,
  onAfterCreateRef: React.RefObject<((created: VizRow) => void) | undefined>,
): Promise<void> {
  const env = await client.createNode({
    title,
    types: [lockedType],   // DRAFT-INV-4
    fields,
    dry_run: false,
  });

  if (!env.ok) {
    const field =
      (env.error.details as { field?: string } | undefined)?.field ?? TITLE_FIELD;
    dispatch({
      type: "SET_ERROR",
      error: { field, code: env.error.code, message: env.error.message },
    });
    return;
  }

  // DRAFT-INV-5: success → surface the created row, then close the draft
  const data = env.data as { node_id: string; file_path?: string };
  onAfterCreateRef.current?.(buildCreatedRow(data, title, fields, lockedType));
  dispatch({ type: "CLOSE", created: true });
}
