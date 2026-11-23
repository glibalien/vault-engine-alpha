/**
 * useDraftEditAdapter — presents the open draft through the SAME VizCellEditAPI
 * the table uses for real rows, so VizTable can render the draft with its normal
 * cell renderers instead of a parallel component. Draft-id calls map onto
 * useVizDraft; every other id delegates to the real useVizCellEdit instance.
 *
 * Field edits on the draft are STAGED locally (no server call) and go out with
 * the single create that the title commit triggers.
 *
 * SCOPE: this API answers for the DRAFT ROW. VizTable selects it per row (draft id
 * → this adapter, every other id → the raw edit API), so `editing` / `pending` /
 * `cellError` here are draft-only and never fall back to `base`: the API has one
 * of each for the whole table, so any fallback would let an open draft editor mask
 * the real rows' — which is exactly the bug that made every row above the draft
 * uneditable while a draft cell was open.
 */
import { TITLE_FIELD } from "@vault/query-core";
import type { CellError, DraftState, PendingEdit } from "@vault/query-core";
import type { VizCellEditAPI } from "./use-viz-cell-edit.js";
import type { VizDraftAPI } from "./use-viz-draft.js";
import type { VizRow } from "./viz-spec.js";

/** Row id of the not-yet-created draft row. Never a real node id. */
export const DRAFT_ROW_ID = "__draft__";

/** The draft as a row the table can render. Null when no draft is open. */
export function draftRowFor(draft: DraftState | null, lockedType: string): VizRow | null {
  if (!draft) return null;
  return { id: DRAFT_ROW_ID, title: draft.title, file_path: "", types: [lockedType], fields: draft.fields };
}

export function useDraftEditAdapter(base: VizCellEditAPI, draft: VizDraftAPI): VizCellEditAPI {
  const d = draft.draft;
  const isDraft = (id: string): boolean => id === DRAFT_ROW_ID;

  const pending: PendingEdit | null = d?.pending
    ? { id: DRAFT_ROW_ID, field: TITLE_FIELD, value: d.title, version: 0, warnings: [], reasons: d.pending.reasons }
    : null;

  const cellError: CellError | null = d?.error
    ? { id: DRAFT_ROW_ID, field: d.error.field, code: d.error.code, message: d.error.message }
    : null;

  return {
    cellValue: (row, field) => (isDraft(row.id) ? d?.fields[field] : base.cellValue(row, field)),
    cellTitle: (row) => (isDraft(row.id) ? (d?.title ?? "") : base.cellTitle(row)),
    // Draft-only (see SCOPE above) — never `?? base.*`.
    editing: d?.editing ? { id: DRAFT_ROW_ID, field: d.editing } : null,
    pending,
    cellError,
    isStale: (id) => (isDraft(id) ? false : base.isStale(id)),
    isFlashing: (id, field) => (isDraft(id) ? false : base.isFlashing(id, field)),
    isEditing: base.isEditing || draft.isDrafting,
    busy: base.busy || !!d?.busy,

    beginEdit: (id, field) => { isDraft(id) ? draft.editCell(field) : base.beginEdit(id, field); },

    submitEdit: async (row, field, raw, meta) => {
      if (!isDraft(row.id)) return base.submitEdit(row, field, raw, meta);
      if (field === TITLE_FIELD) {
        const title = (typeof raw === "string" ? raw : String(raw ?? "")).trim();
        if (!title) { draft.cancel(); return; }
        await draft.commitWithTitle(title);
        return;
      }
      // A mouse pick or a blur only stages — picking a status must not yank the
      // user into the next row mid-entry.
      if (meta?.via !== "enter") { draft.setField(field, raw); return; }
      // A deliberate Enter means "make this row" wherever it is pressed, so the
      // grid gesture (title → Tab → field → Enter) lands one. Tab is what moves
      // without creating; see stageEdit.
      if (!(d?.title ?? "").trim()) {
        // Nothing to create yet: stage the value and put the caret where the row
        // is actually blocked. Enter must never be a silent no-op.
        draft.setField(field, raw);
        draft.editCell(TITLE_FIELD);
        return;
      }
      await draft.commitWithField(field, raw);
    },

    // Staging is what makes the draft row different from a real one: a cell can
    // hold a value before the node exists. Editors reach for this on Tab so moving
    // through the row never creates (design Part B) — Enter on the title, or a blur
    // that carries text, stays the only create trigger.
    stageEdit: (row, field, raw) => {
      if (!isDraft(row.id)) return;
      if (field !== TITLE_FIELD) { draft.setField(field, raw); return; }
      // advance:false — the table's own Tab nav decides the next cell (column
      // order); the guided jump would fight it and can land on a hidden field.
      draft.setTitle(typeof raw === "string" ? raw : String(raw ?? ""), { advance: false });
    },

    confirmPending: async () => {
      if (pending) return draft.confirmCreate();
      return base.confirmPending();
    },

    // Escape in the title editor abandons the row; Escape in a field editor just
    // closes that editor and keeps the staged draft.
    cancelEdit: () => {
      if (!d) { base.cancelEdit(); return; }
      if (d.editing === TITLE_FIELD || d.editing === null) draft.cancel();
      else draft.exitEdit();
    },

    reloadRow: async (row) => { if (!isDraft(row.id)) await base.reloadRow(row); },
  };
}
