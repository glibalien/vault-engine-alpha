/**
 * ReferenceAutocomplete — reference picker input + candidate list.
 *
 * Props:
 *  field           — SchemaField (for suggestArgs scoping)
 *  initial?        — initial input value (pre-seeds the text box)
 *  requireCandidate? — when true, the "keep as unresolved" row is suppressed
 *  onPick          — called with a PickResult discriminated union
 *  onCancel        — called on Escape
 *
 * onPick payload shape (PickResult):
 *   { kind: "candidate"; candidate: RefCandidate }
 *   { kind: "unresolved"; text: string }
 *
 * UX (mirrors mountReferenceEditor in _kit/cell-edit.ts):
 *  - On mount, search("") fires to populate recent nodes.
 *  - Typing debounced-searches by title_contains.
 *  - ArrowUp/Down navigate; Enter/click picks the active row.
 *  - Keep-unresolved row: shown when input is non-empty AND no candidate title
 *    equals the input exactly AND !requireCandidate.
 *  - Escape fires onCancel.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import type { RefCandidate, SchemaField } from "@vault/query-core";
import { useRefSuggest } from "./use-ref-suggest.js";

// ---- Exported payload type ----

export type PickResult =
  | { kind: "candidate"; candidate: RefCandidate }
  | { kind: "unresolved"; text: string };

// ---- Props ----

export interface ReferenceAutocompleteProps {
  field: SchemaField;
  initial?: string;
  requireCandidate?: boolean;
  onPick: (result: PickResult) => void;
  onCancel: () => void;
}

// ---- Component ----

export function ReferenceAutocomplete({
  field,
  initial = "",
  requireCandidate = false,
  onPick,
  onCancel,
}: ReferenceAutocompleteProps): React.ReactElement {
  const [inputValue, setInputValue] = useState(initial);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const { candidates, loading, search } = useRefSuggest(field);

  const inputRef = useRef<HTMLInputElement>(null);

  // Compute whether the keep-unresolved row should show:
  // - input is non-empty
  // - no candidate title is an exact case-insensitive match
  // - !requireCandidate
  const showKeepUnresolved = !requireCandidate
    && inputValue.trim().length > 0
    && !candidates.some(
      (c) => c.title.toLowerCase() === inputValue.trim().toLowerCase(),
    );

  // Build the complete list of activatable rows:
  //   [candidates..., optionally keepUnresolved]
  // activeIndex -1 means nothing selected; 0..candidates.length-1 = candidate;
  // candidates.length = keep-unresolved (when shown).
  const totalRows = candidates.length + (showKeepUnresolved ? 1 : 0);

  // On mount, fire recent search immediately
  useEffect(() => {
    search("");
    // Focus the input
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When candidates change, reset active index
  useEffect(() => {
    setActiveIndex(-1);
  }, [candidates, showKeepUnresolved]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      search(val);
    },
    [search],
  );

  const pickCandidate = useCallback(
    (candidate: RefCandidate) => {
      onPick({ kind: "candidate", candidate });
    },
    [onPick],
  );

  const pickUnresolved = useCallback(() => {
    onPick({ kind: "unresolved", text: inputValue.trim() });
  }, [onPick, inputValue]);

  const activate = useCallback(
    (index: number) => {
      if (index < candidates.length) {
        const c = candidates[index];
        if (c) pickCandidate(c);
      } else if (showKeepUnresolved && index === candidates.length) {
        pickUnresolved();
      }
    },
    [candidates, showKeepUnresolved, pickCandidate, pickUnresolved],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) =>
          totalRows === 0 ? -1 : Math.min(totalRows - 1, prev + 1),
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) =>
          totalRows === 0 ? -1 : Math.max(0, prev - 1),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < totalRows) {
          activate(activeIndex);
        } else if (showKeepUnresolved) {
          pickUnresolved();
        } else if (candidates.length > 0) {
          // Default: pick first candidate when no explicit selection
          const first = candidates[0];
          if (first) pickCandidate(first);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [
      totalRows,
      activeIndex,
      activate,
      showKeepUnresolved,
      pickUnresolved,
      candidates,
      pickCandidate,
      onCancel,
    ],
  );

  const refType = field.reference_target ?? "";

  return (
    <div className="ref-autocomplete">
      <input
        ref={inputRef}
        className="ref-autocomplete-input"
        type="text"
        value={inputValue}
        placeholder={refType ? `${refType} title…` : "title…"}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        role="textbox"
        autoComplete="off"
      />
      <div className="ref-autocomplete-popover">
        {loading && candidates.length === 0 && (
          <div className="ref-autocomplete-empty">Loading…</div>
        )}
        {!loading && candidates.length === 0 && !showKeepUnresolved && inputValue.trim() && (
          <div className="ref-autocomplete-empty">
            No {refType || "node"} matches &quot;{inputValue}&quot;
          </div>
        )}
        {candidates.map((c, i) => {
          const tint = c.types[0] ?? refType;
          return (
            <div
              key={c.id}
              className="ref-autocomplete-opt"
              data-active={i === activeIndex ? "true" : "false"}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pickCandidate(c);
              }}
            >
              {tint && (
                <span
                  className="ref-autocomplete-swatch"
                  style={{ "--swatch-color": `var(--${tint}-dot, var(--ink-4))` } as React.CSSProperties}
                />
              )}
              <span className="ref-autocomplete-title">{c.title}</span>
              {tint && <span className="ref-autocomplete-meta">{tint}</span>}
            </div>
          );
        })}
        {showKeepUnresolved && (
          <div
            className="ref-autocomplete-keep"
            data-active={activeIndex === candidates.length ? "true" : "false"}
            onMouseEnter={() => setActiveIndex(candidates.length)}
            onMouseDown={(e) => {
              e.preventDefault();
              pickUnresolved();
            }}
          >
            ↵ Keep &quot;{inputValue.trim()}&quot; — unresolved link
          </div>
        )}
      </div>
    </div>
  );
}
