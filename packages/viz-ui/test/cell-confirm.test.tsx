// @vitest-environment jsdom
/**
 * cell-confirm.test.tsx
 *
 * TDD tests for the smart-confirm cell UI presentational components:
 *  - PromotePill: renders each reason from pending.reasons + Confirm/Cancel buttons
 *  - CellErrorMsg: renders inline error text
 *  - StaleReloadBar: renders stale bar + Reload/Dismiss buttons
 *
 * Tests written BEFORE implementation — must be RED initially.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

import {
  PromotePill,
  CellErrorMsg,
  StaleReloadBar,
} from "../src/CellConfirm.js";

import type { PendingEdit, CellError } from "@vault/query-core";

afterEach(() => cleanup());

// ── helpers ──────────────────────────────────────────────────────────────────

function makePendingEdit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: "node-1",
    field: "status",
    value: "2026-06-27",
    version: 7,
    warnings: [],
    reasons: ["Interpreted your input as '2026-06-27'", "Sets a field that isn't in this type's schema (orphan)."],
    ...overrides,
  };
}

function makeCellError(overrides: Partial<CellError> = {}): CellError {
  return {
    id: "node-1",
    field: "status",
    code: "VALIDATION_FAILED",
    message: "Value must be one of: open, done, next.",
    ...overrides,
  };
}

// ── PromotePill ───────────────────────────────────────────────────────────────

describe("PromotePill", () => {
  it("renders all reasons from pending.reasons", () => {
    const pending = makePendingEdit({
      reasons: [
        "Interpreted your input as '2026-06-27'",
        "Sets a field that isn't in this type's schema (orphan).",
      ],
    });
    render(<PromotePill pending={pending} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // getByText throws if not found — that's the assertion
    expect(screen.getByText("Interpreted your input as '2026-06-27'")).toBeTruthy();
    expect(screen.getByText("Sets a field that isn't in this type's schema (orphan).")).toBeTruthy();
  });

  it("renders a single reason when reasons has one entry", () => {
    const pending = makePendingEdit({ reasons: ["Value was coerced to a date."] });
    render(<PromotePill pending={pending} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Value was coerced to a date.")).toBeTruthy();
  });

  it("renders all reasons, not just the first", () => {
    const reasons = ["Reason A", "Reason B", "Reason C"];
    const pending = makePendingEdit({ reasons });
    render(<PromotePill pending={pending} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    for (const r of reasons) {
      expect(screen.getByText(r)).toBeTruthy();
    }
  });

  it("Confirm button calls onConfirm", () => {
    const onConfirm = vi.fn();
    const pending = makePendingEdit();
    render(<PromotePill pending={pending} onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    const pending = makePendingEdit();
    render(<PromotePill pending={pending} onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("Confirm does NOT call onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const pending = makePendingEdit();
    render(<PromotePill pending={pending} onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("renders with empty reasons array without throwing", () => {
    const pending = makePendingEdit({ reasons: [] });
    expect(() =>
      render(<PromotePill pending={pending} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    ).not.toThrow();
  });
});

// ── CellErrorMsg ──────────────────────────────────────────────────────────────

describe("CellErrorMsg", () => {
  it("renders error.message as text", () => {
    const error = makeCellError({ message: "Value must be one of: open, done, next." });
    render(<CellErrorMsg error={error} />);

    expect(screen.getByText("Value must be one of: open, done, next.")).toBeTruthy();
  });

  it("renders different error messages", () => {
    const error = makeCellError({ message: "Title cannot be empty." });
    render(<CellErrorMsg error={error} />);

    expect(screen.getByText("Title cannot be empty.")).toBeTruthy();
  });

  it("does not render the error code as visible text by default", () => {
    const error = makeCellError({ code: "VALIDATION_FAILED", message: "Some error." });
    render(<CellErrorMsg error={error} />);

    // The message should be present
    expect(screen.getByText("Some error.")).toBeTruthy();
  });
});

// ── StaleReloadBar ────────────────────────────────────────────────────────────

describe("StaleReloadBar", () => {
  it("renders a stale warning message", () => {
    render(<StaleReloadBar onReload={vi.fn()} onDismiss={vi.fn()} />);

    // Some text indicating "stale" / "changed" / "reload"
    expect(screen.getByText(/changed elsewhere/i)).toBeTruthy();
  });

  it("Reload button calls onReload", () => {
    const onReload = vi.fn();
    render(<StaleReloadBar onReload={onReload} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("renders a dismiss button when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    render(<StaleReloadBar onReload={vi.fn()} onDismiss={onDismiss} />);

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    expect(dismissBtn).toBeTruthy();
  });

  it("dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<StaleReloadBar onReload={vi.fn()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("Reload does NOT call onDismiss", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(<StaleReloadBar onReload={onReload} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders without onDismiss prop (optional)", () => {
    expect(() =>
      render(<StaleReloadBar onReload={vi.fn()} />)
    ).not.toThrow();
  });
});
