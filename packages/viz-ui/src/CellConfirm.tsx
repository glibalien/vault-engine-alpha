/**
 * CellConfirm — smart-confirm cell UI presentational components.
 *
 * Renders the three edit-hook states (from useVizCellEdit) as
 * self-contained, purely presentational React components:
 *
 *  - PromotePill     — confirm/cancel a pending edit with reasons list
 *  - CellErrorMsg    — inline red error text below a cell editor
 *  - StaleReloadBar  — "This row changed elsewhere" banner with Reload/Dismiss
 *
 * Types are imported from query-core — no engine imports.
 */
import React from "react";
import type { PendingEdit, CellError } from "@vault/query-core";

// ── PromotePill ───────────────────────────────────────────────────────────────

export interface PromotePillProps {
  pending: PendingEdit;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * PromotePill — shown when a dry-run produces a "promote" decision.
 * Lists every reason (coercion notices, orphan warnings, etc.) and
 * offers Confirm / Cancel actions.
 */
export function PromotePill({ pending, onConfirm, onCancel }: PromotePillProps) {
  return (
    <div className="promote-pill" role="region" aria-label="Confirm edit">
      <div className="pp-head">Review before saving</div>
      {pending.reasons.length > 0 && (
        <ul className="pp-reasons">
          {pending.reasons.map((reason, i) => (
            <li key={i} className="pp-reason">
              {reason}
            </li>
          ))}
        </ul>
      )}
      <div className="pp-actions">
        <button
          type="button"
          className="pp-btn confirm"
          onClick={onConfirm}
        >
          Confirm
        </button>
        <button
          type="button"
          className="pp-btn"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── CellErrorMsg ──────────────────────────────────────────────────────────────

export interface CellErrorMsgProps {
  error: CellError;
}

/**
 * CellErrorMsg — inline red error text rendered below a cell editor.
 * Keeps the editor open; displayed on inline-error decision outcomes.
 */
export function CellErrorMsg({ error }: CellErrorMsgProps) {
  return (
    <div className="cell-error-msg" role="alert">
      {error.message}
    </div>
  );
}

// ── StaleReloadBar ────────────────────────────────────────────────────────────

export interface StaleReloadBarProps {
  onReload: () => void;
  onDismiss?: () => void;
}

/**
 * StaleReloadBar — a banner shown when a row's version is stale (STALE_NODE).
 * Offers a Reload button (re-fetches current data) and an optional Dismiss.
 */
export function StaleReloadBar({ onReload, onDismiss }: StaleReloadBarProps) {
  return (
    <div className="stale-reload-bar" role="status">
      <span className="srb-msg">This row changed elsewhere — Reload</span>
      <div className="srb-actions">
        <button
          type="button"
          className="srb-btn reload"
          onClick={onReload}
        >
          Reload
        </button>
        {onDismiss != null && (
          <button
            type="button"
            className="srb-btn dismiss"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
