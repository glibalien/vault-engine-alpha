# Schema change effects

Classification is about propagation to **existing nodes**. All schema updates still
validate the definition, enforce override permissions and admission limits, update
schema state, and retain schema undo history. Metadata-only does not mean that the
property has no effect on clients or future operations.

## Field claims

`diffClaims` records every changed claim in `changed` (the MCP preview's
`claims_modified`). Its internal `renderChanged` list includes both render-affecting
and validation-affecting changes that require the existing mutation pipeline. The
property table is exhaustive over the normalized claim shape read from the database.

| Claim property | Classification | Effect on existing nodes |
| --- | --- | --- |
| `field` / claim addition or removal | Render and validation | Changes membership, field ordering, adoption defaults, or orphan handling. Always uses propagation. |
| `sort_order` | Render | Controls Markdown field order and the order of suggested fixes. Uses propagation. |
| `required` | Validation | Changes required-field semantics. Retains the existing propagation pipeline and its missing-field policy. |
| `default_value` | Validation | Changes default resolution, including cancellation across multiple types. Retains the existing propagation pipeline and its default-population policy. |
| `enum_values_override` | Validation | Changes allowed values and coercion. Can change Markdown, so uses propagation. |
| `label` | Metadata only | Presentation text is read from current schema claims; it is not written into node Markdown or used for value validation. |
| `description` | Metadata only | Descriptive/prompt evidence is read from current schema state; changing it does not require rewriting existing nodes. |
| `ai_guessable` | Metadata only | Changes candidate discovery/AI policy, not existing-node validation or rendering. |

Storage override columns are normalized by `readCurrentClaims`. In particular,
`default_value_overridden` is represented by the distinction between an inherited
`undefined` default and an explicit override (including `null`). That distinction
continues to count as a validation-affecting change.

Propagation preserves the existing re-render policy: missing required fields are
tolerated, and default changes on existing claims do not backfill missing values.
Adoption defaults are populated for newly added claims under the existing rules.

## Schema-level properties

| Property | Classification for existing nodes | Other effects |
| --- | --- | --- |
| `display_name` | Metadata only | Changes the schema's presentation name. |
| `icon` | Metadata only | Changes schema presentation. |
| `metadata` | Metadata only | Updates attached schema metadata. |
| `filename_template` | Metadata only | Used when selecting names for future node creation; does not rename existing nodes. |
| `default_directory` | Metadata only | Used when selecting destinations for future operations; does not move existing nodes. |
| `field_claims` / add, update, remove claim operations | Depends on the resulting claim diff | See the field-claim table. |
| `name` | Identity, handled by the separate rename operation | Not an `update-schema` property; renaming a type retains its existing node-update behavior. |

## Preview and write behavior

- Both replacement and patch updates report actual metadata edits in `claims_modified`.
  A retry of an unchanged definition reports no modified claims.
- Pure metadata changes have zero affected/re-rendered nodes, do not require existing
  node projections to be present, and leave node versions, hashes, fields, files,
  edit logs, node undo snapshots, and embedding refresh targets unchanged.
- A mixed edit uses propagation if **any** changed property affects validation or
  rendering. Definition validation, projection-presence guards, rollback, orphan
  confirmation, and explicit-null protections remain in force on that path.
- Previews retain the existing response shape and rollback their simulated definition
  changes. Metadata remains visible immediately through schema reads after a live edit.

No database migration or public MCP envelope/parameter change is needed.
