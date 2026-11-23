# @vault/query-core

`@vault/query-core` is the host-agnostic query and mutation logic behind Vault
Engine's interactive data surfaces. It wraps the relevant Engine MCP tools, mirrors
their schema/result shapes, owns query state, and provides pure decision and flow
helpers for filtering, inline edits, row creation, bulk changes, expansion, and
refresh.

[`@vault/viz-ui`](../viz-ui/README.md) builds React cards on top of this package. The
Obsidian plugin also uses its client and search result types directly.

## Responsibilities

- Typed wrappers for `query-nodes`, schema discovery, node reads/writes, type lists,
  and batch mutation.
- Query-argument parsing and recomposition without dropping caller-owned filters.
- Schema-to-widget inference and reference-field detection.
- Dry-run/commit decision logic for create, edit, and bulk operations.
- State models for filters, type locking, visible columns, optimistic overlays,
  stale-node handling, drafts, expansion, selection, and undo hints.
- Query builders for reference suggestions and one-level relationship expansion.

The package does not render UI or persist state. It depends on the MCP SDK but on no
other workspace package.

## Create a client

Inject any function with the shared MCP call shape:

```ts
import {
  makeClient,
  type CallFn,
} from '@vault/query-core';

declare const callServerTool: CallFn;

const client = makeClient(callServerTool);
const result = await client.queryNodes({
  types: ['task'],
  fields: { status: { eq: 'open' } },
  include_fields: ['status', 'priority', 'due'],
  sort_by: 'file_mtime',
  sort_order: 'desc',
  limit: 50,
});

if (result.ok) {
  console.log(result.data.nodes);
} else {
  console.error(result.error.code, result.error.message);
}
```

`makeClient()` is the one MCP chokepoint. UI flows consume the typed `Client` instead
of calling tool names directly.

## Query ownership

Incoming `query-nodes` arguments are split into three kinds of state:

- Filter-strip state the UI edits directly, such as search text, title, sort, and
  limit.
- A selected or inferred type lock.
- Caller fragments carried verbatim for arguments the UI does not interpret.

`parseArgs()` and `composeArgs()` preserve the semantic round trip. Schema-scoped
fragments drop when the user switches to a different type; global fragments survive.
This prevents a card from silently losing constraints simply because the current UI
does not expose an editor for them.

## Safe mutation flows

Interactive mutation helpers follow Engine's preview-first contracts:

1. Build the candidate tool arguments.
2. Run a dry-run or validation call.
3. Convert warnings, coercions, stale versions, and fixable values into an explicit
   decision state.
4. Commit only after the host confirms the promoted value or operation.
5. Keep enough prior state for a host-level undo affordance and refresh.

The package mirrors Engine's result shapes for node updates, renames, creation, batch
mutation, stale-node details, and schema descriptions. It does not bypass Engine's
version or validation gates.

## Envelope note

`Envelope` and `Issue` intentionally mirror, rather than import,
[`@vault/contract`](../contract/README.md). The dependency rule keeps query-core a
shared leaf with no workspace dependencies, and query-core widens the top-level error
code to `string` because it only forwards codes to hosts. If the wire shape changes,
update both definitions and their tests deliberately.

## Public API areas

| Module area | Examples |
| --- | --- |
| Types | `Envelope`, `Schema`, `SchemaField`, `NodeRow`, `QueryNodesData`, mutation previews/results, UI state types |
| Schema helpers | `inferWidget`, `widgetForField`, `isReferenceField`, `filterableFields` |
| Filters and arguments | `parseArgs`, `composeArgs`, filter summarization, field filter helpers |
| Client | `makeCall`, `makeClient`, `Client`, `CallFn` |
| Decisions | update, create, and bulk dry-run decision functions |
| State | `createState`, `resolveTypeLock`, `findRow` |
| Flows | seed, suggest, bulk, expand, edit, create, and refresh helpers |

Use the root `src/index.ts` entrypoint; internal filenames may be reorganized without
being separate package exports.

## Read-only Engine adapters

The client exposes additive typed mirrors for advanced Engine reads. They preserve the
standard envelope and warnings, remain separate from editable `NodeRow` state, and add
no polling, persistence, rendering, or automatic curation behavior.

### Related-node summaries

`client.summarizeNodes(request)` returns `Envelope<SummaryData>` with warnings and
structured failure details preserved. `SummaryRequest` and `SummaryData` are exported
from this package. The result uses `kind: "node_summaries"`; it is separate from
editable `NodeRow` state and existing query flows. This adapter does not add a
rendered summary view. See the [Engine request example](../engine/README.md#related-node-summaries).

The wire types deliberately mirror Engine without adding a workspace dependency.
Root `npm run typecheck:summary-wire` checks both client mirrors against Engine;
all three suites share frozen synthetic fixtures under `tests/fixtures/summarize-nodes`.

### Saved rollup adapters

`makeClient(...).readRollups` calls Engine's read-only
`read-rollups` with typed `ReadRollupsRequest` / `ReadRollupsData`. Discover configured
names first with `describeSchema(name, ["relationship_views"])`;
check validity and the namespace hash before requesting values or editing definitions.
Schema discovery is opt-in and existing one-argument describeSchema calls remain unchanged.
Computed rollups and inverse lookups remain separate from editable fields. These adapters
do not add rendered UI or automatic curation. Definitions and limits belong to Engine.

### Dependency traversal adapter

`makeClient(...).traverseNodes` forwards the typed
`TraversalRequest` to Engine's read-only `traverse-nodes` tool. The versioned
`TraversalData` includes shortest depths, directed edges, observed cycle components,
boundaries and unresolved-reference scope. Inspect warnings and boundary completeness
before drawing graph-wide conclusions. The standard Envelope is preserved.
This adapter does not add a rendered view or automatic traversal during curation.

### Provenance inspection

`client.inspectProvenance()` wraps read-only `inspect-provenance` status, node
history, output inputs/comparisons, and selected retained input text. Discriminate
`ProvenanceInspectData` by `select`; preserve errors and warnings. The consumer must
check both inspection feature names in status before requesting the new reads.
`getNode` also accepts a file path for explicit current-note resolution. Wire types
remain host-agnostic mirrors checked by `typecheck:provenance-wire`.

`client.findAffectedOutputs()` wraps the existing read-only
`find-affected-outputs` tool with `ProvenanceImpactRequest` and
`ProvenanceImpactData`. The response covers captured direct dependencies only.
Callers must preserve Engine ordering and cursor semantics: a filtered page may
contain zero outputs while still returning `next_cursor`, so an empty page is not
terminal until its cursor is null. This adapter does not follow cursors, poll,
refresh outputs, or make model calls automatically.

Project subpages reuse the existing typed provenance read selectors, envelopes and
comparison values. `expected_self_transition` includes a source deliberately changed
during publication (such as a merge source); `refresh_target.eligible` remains false
for subpages. Optional capture-flow and plural receipt additions leave legacy
home-only callers compatible.

### Percentage and calendar-date summary contracts

The typed summary/rollup clients preserve `percentage` metrics, numerator/denominator
components and `evaluation_context`. Pass explicit `time_zone` for `date_window`
filters; `as_of` optionally pins their calendar boundary, not historical node state.
Saved definitions choose their own eligible/matching fields and statuses. Consumers
must preserve null for an empty denominator and may round only for display.
See [Engine's contract examples](../engine/README.md#percentage-and-relative-date-rollups).

### Compound `where` filters

Compound `where` filters are a single global caller fragment. Their nested fields,
types and joins are never promoted into separate chips or dropped on a type switch.
The selected type and ordinary chips remain outer AND constraints. The existing
fragment tooltip exposes the complete JSON; explicit removal removes the whole
expression. Summary and rollup client contracts mirror the Engine's additive
expression types, including fields-only percentage matching.

## Boundaries

- Depends on the MCP SDK but on no other workspace package.
- Mirrors Engine wire types without importing Engine runtime code.
- Does not render React, subscribe to host lifecycle events, or persist query state.
- Does not bypass Engine validation, version checks, dry-run promotion, or mutation
  envelopes.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Engine wire mirrors and all surface state contracts |
| `src/client.ts` / `src/call.ts` | Typed MCP wrapper |
| `src/schema.ts` | Widget and field helpers |
| `src/owned-args.ts` / `src/filters.ts` | Query ownership, round trips, and filter logic |
| `src/decide*.ts` | Dry-run interpretation for edits and creates |
| `src/state.ts` | Initial state and type-lock resolution |
| `src/flows/` | Reusable operation-specific orchestration helpers |
| `test/` | Pure and client-level regression coverage |

## Development

```bash
npm run typecheck -w @vault/query-core
npm run build -w @vault/query-core
npm test -w @vault/query-core
```

For wire-shape or query behavior changes, also run `@vault/viz-ui` and Obsidian tests.

## License

MIT
