import { useEffect, useMemo, useState } from "react";
import { seedFieldsFromFilters, widgetForField } from "@vault/query-core";
import type { Schema, FilterChip, CallerFragment } from "@vault/query-core";
import { useVizClient } from "./viz-client-context.js";

/**
 * Seed values for a new draft row from the active filter chips.
 *
 * Like the pure `seedFieldsFromFilters`, but ALSO inherits reference (link)
 * filters whose chip only carries the target id. A saved board query stores
 * node_ids, so on load the link chip is rebuilt as `{ id, title: null }`
 * (filters.ts) — and seedFieldsFromFilters needs a non-null title to seed a link
 * field. Without this, a "filtered by project" board never inherits the project
 * into a created row (the headline new-row-inherit use case).
 *
 * We resolve missing titles via the client and CACHE them by node id. The cache
 * is what makes this robust where the prior "write the title back into the chip
 * state" approach was not: a board surface re-initialises chips from spec.query
 * on every poll/save (wiping a chip-state title back to null), but the id→title
 * cache persists across those re-inits, so the seed value is always available by
 * the time the user clicks "+ New". Surface-independent — both chat and the
 * Obsidian plugin go through the same client abstraction.
 */
export function useSeedFields(
  schema: Schema | null | undefined,
  chips: FilterChip[],
  fragments: CallerFragment[],
): Record<string, unknown> {
  const client = useVizClient();
  // node id → resolved title, persisted across chip re-inits.
  const [titleById, setTitleById] = useState<Record<string, string>>({});

  // Link-filter targets with an id but no title that we haven't resolved yet.
  const pendingIds = useMemo(() => {
    if (!schema) return [] as string[];
    const ids: string[] = [];
    for (const chip of chips) {
      const field = schema.fields.find((f) => f.name === chip.field);
      if (!field || widgetForField(field) !== "link") continue;
      const st = chip.state as { exists?: unknown; target?: { id?: unknown; title?: unknown } | null };
      if (st.exists === true || st.exists === false) continue; // presence filter — nothing to seed
      const t = st.target;
      if (t && typeof t.id === "string" && (t.title == null || t.title === "") && titleById[t.id] === undefined) {
        ids.push(t.id);
      }
    }
    return ids;
  }, [schema, chips, titleById]);

  useEffect(() => {
    if (pendingIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      pendingIds.map((id) =>
        client
          .queryNodes({ node_ids: [id], limit: 1 })
          .then((r) => (r.ok && r.data.nodes[0] ? ([id, r.data.nodes[0].title] as const) : null))
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const found = results.filter(
        (x): x is readonly [string, string] => x != null && typeof x[1] === "string" && x[1] !== "",
      );
      if (found.length) {
        setTitleById((prev) => {
          const next = { ...prev };
          for (const [id, title] of found) next[id] = title;
          return next;
        });
      }
    });
    return () => { cancelled = true; };
  }, [pendingIds, client]);

  return useMemo(() => {
    if (!schema) return {};
    const seed = seedFieldsFromFilters(schema, chips, fragments);
    // Fill any reference filter the pure seed skipped (id-only chip) from the cache.
    for (const chip of chips) {
      if (chip.field in seed) continue;
      const field = schema.fields.find((f) => f.name === chip.field);
      if (!field || widgetForField(field) !== "link") continue;
      const st = chip.state as { exists?: unknown; target?: { id?: unknown } | null };
      if (st.exists === true || st.exists === false) continue;
      const t = st.target;
      if (t && typeof t.id === "string") {
        const title = titleById[t.id];
        if (title) seed[chip.field] = title;
      }
    }
    return seed;
  }, [schema, chips, fragments, titleById]);
}
