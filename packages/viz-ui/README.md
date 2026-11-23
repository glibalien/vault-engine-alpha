# @vault/viz-ui

`@vault/viz-ui` is the shared React library for live Vault Engine cards. It renders
tables, kanban boards, lists, calendars, node previews, vault statistics, and spend
reports while using Engine MCP calls for all data and mutation.

The package is host-agnostic: it does not import Engine, Curator, or Obsidian. Hosts
inject a transport and decide where cards live, how previews open, and how changed
specs are persisted.

## Card types

### Query visualizations

`VizSpec` supports four current kinds:

- `table`
- `kanban`
- `list`
- `calendar`

The legacy persisted spelling `tasklist` is accepted on read and normalized to
`list`. A visualization spec carries a title, the full `query-nodes` argument object,
display fields, and optional grouping/date/layout preferences.

Fence and board-card parsing normalize repeated `display_fields` entries by keeping
the first occurrence of each exact field name, preserving order. Names are not
trimmed or case-folded. Parsing leaves its input and all `column_widths` entries
untouched, including legacy flat Kanban widths and per-view width maps. The surviving
column retains its field-keyed width; subsequent saves persist the normalized list.
Structural guards still accept duplicate-bearing historical specs so they can be
read and normalized without a migration.

This normalization applies at the fence and board-card parsing boundaries. Historical
chat `data-viz` parts replayed directly by a host bypass these parsers and are not
rewritten by this change.

A table has one sort (`tableSortOf`), shown by both the header arrow and the toolbar's
Sort, and saved with the view. Clicking the Name header or picking a toolbar order sets
`query.sort_by` / `sort_order`, so the Engine orders every row. Clicking any other column
saves `column_sort: { field, order }`, which sorts the loaded rows on the client; when the
limit cut the result off, a note says so. A toolbar pick or a Name click clears
`column_sort`; clicking the sorted column again flips its direction. A table with no saved
sort shows rows in the order the query returned them. While a search's rows come back ranked
by relevance (each hit carries a `score`), query-nodes ignores `sort_by`, so every header sorts
the loaded rows; a search the Engine can't rank (no embedder) keeps the server sort. Other kinds ignore
`column_sort`. A missing, malformed, or orphaned `column_sort` (its column no longer shown)
is ignored, so older views open unchanged.

### Board-only cards

`BoardCardSpec` extends query visualizations with:

- `node` — one node preview.
- `stats` — vault status and watcher health.
- `spend` — Usage and cost: this month or the last 30 days (resolved when it loads), provider-reported and estimated cost, Curator's spend today against its cap, spend per day and the top drivers. No model call.

The retired `evidence` and `project-health` kinds (#281) parse as unknown, so a saved card
of either kind shows as unrecognized instead of disappearing.

Engine stores board card specs opaquely. Call `parseBoardCardSpec()` before rendering;
unknown or malformed kinds return `null` so the host can show an explicit unsupported
state.

## Render a live card

Import the package stylesheet once in the host, provide an MCP transport, then render
cards below `VizClientProvider`:

```tsx
import {
  VizCard,
  VizClientProvider,
  type VizSpec,
} from '@vault/viz-ui';
import '@vault/viz-ui/styles.css';
import type { CallFn } from '@vault/query-core';

declare const call: CallFn;

const spec: VizSpec = {
  kind: 'table',
  title: 'Open tasks',
  query: {
    types: ['task'],
    fields: { status: { eq: 'open' } },
    sort_by: 'file_mtime',
    sort_order: 'desc',
  },
  display_fields: ['status', 'priority', 'due'],
};

export function OpenTasks() {
  return (
    <VizClientProvider call={call}>
      <VizCard
        spec={spec}
        onSpecChange={(next) => console.log(next)}
      />
    </VizClientProvider>
  );
}
```

Every query view renders an Obsidian Bases-style toolbar (`VizToolbar`): a layout menu
(table/kanban/list/calendar, plus Group by for a table, list or kanban, table density and
columns, and a calendar's Date field and End field), a results count with limit
and refresh, then Sort, Filter (type lock, title, field filters), Properties, Search and
New. Passing `onSpecChange` enables the editable controls and persists layout switches on
the spec. `presentation="card"` (default) draws a bordered card with a title row for chat
and the MCP app; `presentation="pane"` fills its host flush and leaves naming to the host
(a board's view tab). Hosts can also provide pin, close, collapse, preview callbacks and
`toolbarActions`.

`VizClientProvider` also takes `vocabulary`, the names in Engine's vault map
(`Settings/Vault.md`, read with `get-settings` and `vaultSettingsFrom`) that the views
read: the task kind, its status field and values, the tick and untick values, and the
due/date/scheduled fields. Without it the views use the map's defaults (`task`, `status`,
`done`/`open`, `due`, `date`, `scheduled`). It sets the kanban's column field when a spec
names no `group_by` (and the field always fetched for it), the list's checkbox (ticked for a
done status; a click writes the tick or untick value; no checkbox when the vault has no task
status field, or when a click could not work, `taskCheckboxOn`: the tick value is not a done
status, the untick value is empty or a done status, or the view's type has the field as an enum
that does not take one of them; the row then shows its status), the calendar's date fallbacks,
and the order and colour of status values (`statusScaleFor`). A spec's own field names always win, so saved cards keep working.

A table or list with a `group_by` shows one section per value of that field, headed by the
value and its row count: status values in their board order, the rest alphabetically, rows with
no value in a last "—" section, and a field holding several values under its values joined, as
on a kanban. A date field gives one section per day, oldest first, in the calendar's time zone.
The table's sort holds within each section. Sections cover the loaded rows only, so when the
view's limit cut the result off, a line above says so ("Grouped within the 50 loaded rows, not
all 200."), as for a column sort. Clicking a heading folds the section; the folded
values are saved on the spec as `collapsed_groups` and dropped when `group_by` changes. Without
a `group_by`, a table or list has no sections (a kanban's columns still default to the status
field). The Layout menu's Group by lists the fields of the view's types (`groupByOptions`), plus
None for a table or list.

A calendar plots each item by its spec's `date_field`, else by the first of the due/date/scheduled
fields on the first loaded row, and names that field next to the month. With an
`end_date_field`, an item with both dates is a bar across every day from start to end (its
start day only when the end is missing or earlier), continued on the next week row; a day shows
three items, then "+N more". The Layout menu's pickers list the date fields of the view's types
(`calendarFieldOptions`). Days are taken in the provider's `timeZone` (the plugin passes
Curator's `tz`), else the viewer's: a date, or a time written without a zone, stays on the day
written, and an instant with a zone lands on its day there.

Colors come only from the token variables (`--bg`, `--panel`, `--panel-2`, `--border`,
`--text`, `--text-dim`, `--accent`, `--link`, …): the Obsidian plugin maps them to the
theme (Bases variables first) and the MCP app sets its own default palette.

## Interactive behavior

Query cards use [`@vault/query-core`](../query-core/README.md) and Engine's safety
contracts to provide:

- Live refresh with last-good data preserved on transient failures.
- Type locking, caller-fragment chips, filter editing, field selection, and sorting.
- Inline field and title edits with dry-run promotion and explicit confirmation.
- Expected-version checks and stale-row reload behavior.
- Draft rows for node creation, including required fields not currently displayed.
- Bulk selection and preview-first batch mutation.
- One-level relationship expansion.
- Reference autocomplete and reference-aware cell rendering.
- Kanban status movement and list completion toggles.

Polling pauses while a card is collapsed or an edit/draft is active so refreshes do
not replace state underneath an interaction.

## Spec helpers

| Export | Purpose |
| --- | --- |
| `isVizSpec`, `parseVizFence`, `serializeVizFence` | Validate and round-trip chat `viz` fences |
| `vizQueryArgs` | Compose the query and required display/group/date fields |
| `rowsFromCallResult` | Convert a raw `query-nodes` result to `VizRow` data |
| `deriveVizTitle`, `defaultDisplayFields` | Fill display defaults from type/schema context |
| `parseBoardCardSpec` | Validate and normalize persisted board cards |
| `readCardEnvelope` | Parse the shared `data-card` part used by chat/board hosts |
| `sortRows`, `filterRows`, `groupRows` | Pure client-side view helpers |
| `tableSortOf`, `nextTableSort`, `tableSortLabel`, `withoutColumnSort` | A table's one sort, a header click's next sort, and its toolbar label |

The root entrypoint also exports lower-level hooks, reducers, editors, and components
for hosts that need to compose a custom surface. Prefer `VizCard` unless the host
actually needs that control.

## Wiki panel (provenance inspector)

`ProvenanceInspector` is the wiki panel's sidebar component (#545) under `VizClientProvider`,
not a persisted board card. Its host supplies the `InspectorTarget` (the panel follows the active
note unless pinned: `pinned` and `onTogglePin`), connection generation, tool availability and
stable-ID navigation. It reads only Obsidian theme variables, so any theme restyles it.

For any note, the hook looks up the wiki it belongs to: the root its `wiki_for` names, or the
note itself as a root, checked with the host's `findWiki`. The home's `wiki_status` is read
from the home itself, or from the page that names the same root in `wiki_for` and has no
`wiki_parent`, found among the root's incoming `wiki_for` links (as Engine finds it, so a
renamed home is still found; `<name> Wiki` is read first).

The panel leads with a status board: one row for this page and one for its wiki, each with its
state and its own **Rebuild…** (paid, confirmed in the host's dialog; the row that needs attention
gets `mod-cta`). With a `WikiControlApi` (`curator-status` and `set-wiki-paused`),
`useWikiStatus` reads the wiki's live status and `WikiSection` shows its controls: a **Scheduled
builds** toggle (pause and resume), the last full build and today's budget. Below come collapsible
sections: **Changed since this build**, **Sources** (Read, Listed, Memories, Your corrections, Wiki
context, Instructions & format), **Pages built from this note** (`PagesBuiltFrom`, which reads
`find-affected-outputs` only while open; **See what it was built from** goes to the host's
`onReviewBuild`, which shows that build with `backTo`), **History** and Technical details. On a
note that isn't part of a wiki, the panel offers the host's create actions.

A dossier (#554) is found the same way: with no wiki registered for the root note, a home whose
root is of a kind the host's `dossierKind` names (a person, a company or another entity kind) is
that note's dossier, and the note is its subject. The panel then shows one **This dossier** row
on the page, or a **Dossier** row on the subject, from `dossierState`: Curator's status under the
page title (`useDossierStatus`, which reads a build in flight again every `DOSSIER_POLL_MS` and calls
`onFinished` when it ends; a subject with no page yet is read under `dossierPageTitle`, the
*<Name> Dossier* its first build gives it), the page's `wiki_status`, and on the page the sources that changed
plus the memories recorded about the subject since the build (`useDossierNews`: `list-memories`, read
page by page because it comes by the day each memory became true).
`DossierSection` holds **Rebuild nightly when behind**, which writes the subject's `dossier` field
with `update-node` (dry run first), the last build and today's budget. A subject with no dossier
gets **Build a dossier** in place of the wiki card, or a **Dossier** row while its first build is
queued or running or after it failed; **Rebuild…** and **Build dossier…** go to the
host's `onBuildDossier`, which shows `DossierBuild`. Its heading asks the question until the build
is sent, then says what is happening: building, queued behind the build `queue.current` names, ready,
or not written. Sources name a dossier's selections and keep
its **Past facts** apart from its memories.
It pages history on demand, reads a build's whole input list (100 per read, up to
five reads before asking), and renders only one full retained text page at a time as
plain text. `provenance-sources.ts` folds the per-use input records into one row per
source, names each use in plain words, groups rows (read, mentioned, memories, wiki
pages, behind the scenes) and diffs a build's sources against the build it replaced.
Short excerpts (memory lines, the lines of a list that mention a note) load on
demand, four at a time. Opening a source never retargets the inspector. Connection changes,
refresh and observed erasure invalidate retained text; manual refresh is required
to discover remote changes while idle. If loading older node history rejects a
cursor with `INVALID_PARAMS` / `details.reason: PROVENANCE_LIMIT`, the inspector
clears pagination and retained reads, then refreshes once without the cursor while
preserving the selected generation. A failed restart is surfaced normally;
unrelated errors retain their existing retry behavior. It does not verify narrative truth. Project subpages use the same inspector and
retained-input reads. `expected_self_transition` is labeled as an expected change
during publication, including merged source pages; it does not imply that the source
is the generated output. Rebuild eligibility remains Engine-owned, for a home and for a
sub-page alike.

`SourceImpactReview` adds the source-first companion workflow. It checks exactly
one pinned node source, loads current impact pages first, and loads historical uses
only after an explicit action. Because Engine omits unchanged uses, it presents
results as wiki pages built from an earlier version of the note, says plainly when
none are (using the page's comparison count), and groups older builds by page. Output title/path hydration is a convenience from
current `query-nodes` data; an unavailable or deleted current node does not remove
the authoritative impact receipt. Selecting a candidate reuses
`ProvenanceInspector` with the exact output revision ID, including revisions outside
the first history page, and highlights the matching recorded input IDs.

Current and historical cursors stay independent, and the component never drains a
cursor automatically. Target, page, selection, and retained-text state are held only
in memory and are cleared on refresh, connection replacement, target change, or
unmount. An empty result does not prove completeness: uncaptured flows, new sources,
opaque components, and unavailable or purged history can remain outside captured
direct dependency coverage.

## Boundaries

- React presentation and interaction live here; board persistence lives in
  [`@vault/board-core`](../board-core/README.md).
- Engine remains authoritative for validation, data, versions, and writes.
- Hosts own transport lifecycle, card persistence, routing, preview behavior, and
  surrounding layout.
- The package may depend on `@vault/query-core` and React, but not on deployable
  packages or `@vault/contract`.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/viz-spec.ts` | Query visualization protocol and parsing |
| `src/board-card-spec.ts` | Full board-card union and structural guard |
| `src/VizCard.tsx` | Integrated live card and view composition |
| `src/VizTable.tsx`, `VizKanban.tsx`, `VizTaskList.tsx`, `VizCalendar.tsx` | Visualization renderers |
| `src/ProvenanceInspector.tsx`, `src/provenance-inspector.ts`, `src/provenance-sources.ts`, `src/use-provenance-inspector.ts` | The wiki panel: the note's wiki lookup, retained-input inspection state, reader-facing grouping, and UI |
| `src/WikiSection.tsx` | The wiki panel's wiki: its live status from Curator, its state on the status board, and its controls (scheduled builds, last build, budget) |
| `src/DossierSection.tsx`, `src/DossierBuild.tsx`, `src/use-dossier-build.ts` | The wiki panel's dossier: its status, what is new since its build, its controls (nightly rebuilds, last build, budget), and building or rebuilding it in the host's dialog |
| `src/PagesBuiltFrom.tsx`, `src/use-source-impact-review.ts` | Pages built from this note: bounded source-first impact review and exact-generation handoff |
| `src/HomeRefresh.tsx`, `src/WikiRebuild.tsx` | Rebuild one page or the whole wiki: a free check, then a paid confirm, shown in the host's dialog |
| `src/use-viz-*.ts` | Query, schema, edit, draft, bulk, expansion, and mutation state |
| `src/cell-editors/` | Type-aware inline editors |
| `src/*Card.tsx` | Node, stats, and spend cards |
| `styles.css` | Host-imported component stylesheet |
| `test/` | Pure, hook, component, and integration coverage |

## Development

```bash
npm run typecheck -w @vault/viz-ui
npm run build -w @vault/viz-ui
npm test -w @vault/viz-ui
```

Run Obsidian tests for user-visible card behavior and `@vault/query-core` tests when
changing query or mutation contracts.

## License

MIT
