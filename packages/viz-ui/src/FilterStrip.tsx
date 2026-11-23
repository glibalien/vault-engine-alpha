import type { StripState } from "@vault/query-core";

/** Pure helper: return a new StripState with one field updated.
 *  For `limit`, parses the raw string to a number (falls back to 50 on NaN).
 *  All other fields are stored as-is (cast to the appropriate union where needed). */
export function stripField(
  strip: StripState,
  field: keyof StripState,
  raw: string,
): StripState {
  if (field === "limit") {
    return { ...strip, limit: parseInt(raw, 10) || 50 };
  }
  return { ...strip, [field]: raw } as StripState;
}

/** Controlled filter strip for an editable viz card.
 *  Receives the current StripState directly (no internal state); on any
 *  control change builds an updated StripState and calls onStripChange. */
export function FilterStrip({
  strip,
  onStripChange,
}: {
  strip: StripState;
  onStripChange: (next: StripState) => void;
}) {
  function emit(field: keyof StripState, raw: string) {
    onStripChange(stripField(strip, field, raw));
  }

  return (
    <div className="viz-filter-strip">
      <label>
        <span className="vfs-label">title</span>
        <input
          aria-label="title-contains"
          type="text"
          placeholder="title contains…"
          value={strip.title_contains}
          onChange={(e) => emit("title_contains", e.target.value)}
        />
      </label>

      <label>
        <span className="vfs-label">search</span>
        <input
          aria-label="hybrid-search"
          type="text"
          placeholder="hybrid search…"
          value={strip.query}
          onChange={(e) => emit("query", e.target.value)}
        />
      </label>

      <label>
        <span className="vfs-label">limit</span>
        <input
          aria-label="limit"
          type="number"
          min={1}
          max={200}
          value={strip.limit}
          onChange={(e) => emit("limit", e.target.value)}
        />
      </label>
    </div>
  );
}
