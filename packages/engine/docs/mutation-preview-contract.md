# Mutation preview contract

A preview checks the prerequisites of its corresponding live mutation against current
state, or sequentially simulated state for a composed operation. It does not retain
database mutations, write vault projections, create undo history, or emit mutation
notifications. Live execution still rechecks; preview is not a reservation and cannot
guarantee that later filesystem I/O will succeed.

## Guard ordering

Existing tool mutations require a readable projection before preparation. Propagation
uses its existing regular-file/readability check. The pipeline validates and renders,
checks a supplied database content hash, detects an exact no-op, then checks a supplied
version and any disk hash required by that operation. An exact no-op therefore retains
the live version exception, while a stale database hash still fails. Ordinary updates
do not acquire a new disk-hash requirement; field-guess saves retain their stricter CAS.
Existing validation-preview payloads are retained for invalid proposals; version guards
are not evaluated when live validation would stop before them.

Single-node title changes and directory moves commit through `executeRename` after the
content mutation. Because a pure rename or move is a no-op content write, which skips the
pipeline's version check, both the preview and the live path check a supplied
`expected_version` explicitly before anything moves. Query-mode moves keep their staged
path.

## Surface inventory

| Surface | Preview prerequisites and exceptions |
| --- | --- |
| Single `update-node` | Existing-file presence, supplied database hash/version, conversation authority, and field-guess guards when supplied; pipeline no-op ordering is shared. Type membership changes (`add_types` / `remove_types` / `set_types`) use the same guards; leaving a node typeless is a `LAST_TYPE_REMOVAL` warning. |
| `delete-node` | Supplied version in explicit and implicit confirmation previews; deletion may clean up an indexed node whose file is already missing. |
| `create-node` | Existing destination checks and their existing preview warning shape; creation has no existing-node presence requirement. |
| Query-mode update / `batch-mutate` | Existing common preflights and composed database simulation; caller version/hash guards are not accepted in query mode. Nodes created earlier in a batch are not treated as missing existing projections. Later no-op checks use previously simulated projection hashes. Stale operations keep the live skip-and-continue policy and appear as preview warnings. |
| `update-schema` | Live propagation presence checks for projected nodes in rollback-only simulation. Metadata-only schema or claim changes skip node propagation while retaining accurate claim diffs. |
| `update-global-field` type-change impact preview | Live re-render target set: stored values, explicit-null markers, and nodes whose incompatible values will be discarded. Metadata-only updates retain their short circuit and existing discard confirmation gates remain. |
| `wiki-write` | Existing-node pipeline guards, including supplied version, and new-target disk conflicts. |
| `wiki-reconcile` | Explicitly targeted wiki nodes and derived merge ancestors require existing projections. Reused plans validate the current indexed home's section structure before returning without writes; valid owner edits remain untouched. |
| `refresh-memory-note` | Existing indexed notes require a readable projection matching the indexed hash. Creation retains its existing policy. |
| Multi-operation undo | Conflict checks see earlier simulated restores/deletions under a rollback-only transaction; no projection writes or observer notifications. |
| Single-operation undo | Existing database conflict policy and missing-file recovery remain. |
| `archive-source` / `materialize-transcript` | Existing shared preview/live preflights remain. |

No preview mode is added to definition tools without an existing preview,
ordinary memory CRUD, conversation, board, or settings tools. Watcher, normalizer, undo,
and intentional DB-only operations keep their existing pipeline presence exemptions;
preview callers explicitly apply their corresponding live preflight where needed.

No public MCP parameter or envelope-shape changes, database migrations, or model calls are
required by this contract.
