# Explicit-null read projections

An explicitly authored YAML null is persisted in `node_explicit_null_fields`.
It is a present field with a null value, distinct from an absent field. If a
marker and a `node_fields` value row coexist, the marker wins when projecting
the field. Reading never repairs, deletes, or revives the shadow value row.

| Projection | Explicit-null representation |
| --- | --- |
| `get-node` fields, resolved by ID, path, or title | `{ value: null, type: 'null', source: 'frontmatter' }` |
| `get-node` expanded neighbor fields, outgoing/incoming/both | The same typed field detail as the root node |
| `query-nodes` with `include_fields: ['*']` | Field key with raw `null` |
| `query-nodes` with named `include_fields` | Raw `null` for requested marked fields; unrequested fields remain omitted |
| Internal `assemble().node.fields` | Field key with raw `null` |

The query projection applies to both structured results and ranked search results.
`include_fields` remains independent of `select`; omitted or empty `include_fields`
does not add a field map. An absent requested field is omitted, not synthesized as
null. `field_count` retains its existing count of stored value rows; it is not the
size of the projected field map. Filtering, ranking, and pagination are unchanged.

`get-node` uses the same root field projection with embeds enabled, disabled, or
left at their default. Embed entries contain extracted text rather than another
structured field map. The assembler's own raw node field map also honors markers.

All four field-map paths use `fields/project.ts`, preserving existing non-null
storage types and sources. Expansion fetches markers in a batch scoped to the
selected neighbor IDs. Query projection applies the same requested-name filter
to value rows and markers. Prototype-like field names remain ordinary own keys.

The existing MCP envelopes and field-detail shapes are unchanged. Expanded and
query field maps now include previously omitted null keys and suppress shadow
values. Curator's field unwrapping, Obsidian's field maps, and the shared query
value types already accept null; no consumer wire-type change is required.

These are read-only projections: node versions, hashes, Markdown, value rows,
null markers, and undo history remain untouched. No database migration is needed.
