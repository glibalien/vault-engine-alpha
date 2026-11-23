# Durable Memory Markdown Projection

The complete durable-memory stock is materialized as an editable `Settings/Memories.md` projection. SQLite remains authoritative; the file is an editable input view and a rendered snapshot.

## Model

- **DB-authoritative, file-edit-input.** Memory rows live in the `memories` table. The markdown file is a projection: edits to editable fields are ingested back into the DB, and the canonical file is refreshed once daily.
- **Daily-only canonical write-back.** Ordinary create-memory, update-memory and expire-memory operations (including purge) never rewrite the note. The production `vault-curator.service` scheduled sweep refreshes it once after memory, conversation, organization, and reconciliation phases. An explicit `refresh-memory-note` tool call (operator or dry-run) is the only other write path.
- **No local scheduler.** The job is the in-process scheduler owned by the production `vault-curator.service`. The local workstation only edits/receives the vault through existing file-sync.

## Format

Canonical frontmatter:

```yaml
---
types:
historical_count: 41
live_count: 386
memory_log_version: 1
snapshot_at: 2026-08-13T09:00:00.000Z
vault_engine_projection: memories
---
```

`types:` is deliberately empty: `vault_engine_projection: memories` is a
frontmatter field rather than a schema type. The normal mutation renderer owns
this frontmatter; the projection renderer supplies only these fields plus the
memory-block body, so the file always has exactly one frontmatter document.

Canonical grouping/order:
1. `Live — Rules, corrections and preferences`
2. `Live — Other memories`
3. `Historical — Expired and superseded`
4. Within a section: `source ASC`, `scope ASC`, `updated_at DESC`, `id DESC`.

Each entry is marker-delimited with one tilde-fenced YAML payload. The fence length is dynamically chosen to exceed any all-tilde line in the serialized content, so arbitrary memory text cannot close it accidentally.

```markdown
### Memory 418 — correction

<!-- ve:memory:418 revision="2026-08-12T14:03:11.000Z" base="sha256:..." -->
~~~~yaml
id: 418
status: live
content: Avery prefers concise implementation plans.
category: correction
source: chat
...
~~~~
<!-- /ve:memory:418 -->
```

### Editable fields

- `content` — the memory text
- `subjects` — what the memory is about (#554): a list of names. A block shows the names its subjects were given, and only when it has some; a rename of the note does not change them. Add the key to any block (or a `new:` block) to give a memory subjects: note titles, aliases or `[[links]]` (quote a link in a list item, or write it unquoted; both are read). A name is linked to the one note of an entity kind (the vault map's `entityTypes`, else its person, company and project kinds) that answers to it, by its vault path, title or alias; a name no such note answers to is kept and matched once one does; a name several notes answer to links to none of them, so write the title or the path to pick one. A one-word name you type here links like any other (a tool's one-word name for a person links only through the memory's source note). Order and letter case are no edit. Removing a name removes that subject. `get-memory` shows each subject's note and status.
- `category` — lightweight taxonomy: `fact`, `preference`, `rule` (a rule on what may or may not be said, shared or claimed: a name or wording to use or avoid, a date or detail not to give, material to keep internal, a claim not to make), `correction`, `note`
- `status` — `live` or `expired`

### Read-only fields (rendered for review, editing is a validation error)

`source`, `scope`, `node_id`, `created_at`, `updated_at`, `valid_at`, `invalid_at`, `expired_at`, `expire_reason`, `superseded_by`, `predecessors`, `evidence`, `metadata`, `embedded`

A block also carries a read-only `changed_by` line, right after `source`, when a chat AI (claude.ai, Claude Code, or the Obsidian chat) last wrote that memory through the memory tools: it rewrote the content, edited the category or metadata, or retired or reactivated it. The line names the client by the first eight characters of its id and the name it registered under, for example `changed_by: client 3f8a5c2e "Chat App"`. For the Obsidian chat it reads `changed_by: chat "Obsidian chat" (service-<token name>)`. A memory keeps its `source` across updates, so this line is what says an `owner` or `curator` memory is no longer in its source's own words. A block no chat client touched has no such line.

### New-entry template

```markdown
<!-- ve:memory:new:550e8400-e29b-41d4-a716-446655440000 revision="new" base="sha256:..." -->
~~~~yaml
id: new:550e8400-e29b-41d4-a716-446655440000
status: live
content: A durable owner-authored fact.
category: fact
subjects:
  - Dana Whitfield
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:550e8400-e29b-41d4-a716-446655440000 -->
```

The engine fixes `source='owner'`; the file cannot choose or spoof it.

An edit to this note is read as the owner's own, so a chat AI (a signed-in chat client, or the Obsidian chat's model) cannot write the note with `create-node`, `update-node` or `batch-mutate`, or rename or move another note to its path; it changes memories with `create-memory`, `update-memory` and `expire-memory`. The suite's own callers (a service token, or no auth) are not refused, the plugin's own actions included.

## Edit rules

- **Content + category may change together.** A status transition may not be combined with a content or category change in one block edit; reject and ask for two daily cycles.
- **Removing a block is a no-op.** Retirement requires explicit `status: expired`. Hard purge remains MCP-only (`expire-memory` with `purge: true, confirm: true`).
- **Stale conflicts.** Every canonical block carries `revision=<updated_at>` and `base=<editable hash>`. A changed block whose `revision` no longer matches the row is rejected as stale; the newer DB value wins and is rendered at the next nightly refresh.
- **Idempotency.** A durable receipt ledger (`memory_note_receipts` table) keys `(block_key, edit_hash)`. Repeated watcher/reconciler/restart delivery of the same edit is an exact no-op. `new:<uuid>` drafts map to their resulting memory id — a consumed draft key can never mint a second row.
- **Validation posture.** The entire note is parsed and validated before any block is applied. Syntax/shape errors reject the whole batch. Once application starts, operations are sequential and receipt-backed; a runtime failure may leave earlier blocks applied while failed/unreceipted blocks retry.

## Feedback-loop exclusion

The note carries `vault_engine_projection: memories` in its frontmatter. This field:
- Excludes the node from semantic embeddings (the indexer removes prior vectors and skips new ones). FTS remains so humans can find memory text via full-text search.
- Excludes the node from curator `semanticRelated`, `listChangedNodes`, `listUntypedNodes`, and `listNodesInDirs` queries (via `without_fields: ['vault_engine_projection']`).
- Ensures fenced payloads create zero body wiki-link relationships.

## Scheduling

The refresh runs inside `vault-curator.service` (the production systemd service), after the memory sweep, conversation sweep, organization sweep, and reconciliation, and before the journal entry. Only `trigger: 'scheduled'` calls it — CLI and on-demand sweeps do not.

`sweepAt`/`tz` in `Settings/Curator/General.md` control the daily timing. DST is handled correctly (fresh wall-clock recomputation, never `+24h` math). Startup catch-up is eligible (it already uses `trigger: 'scheduled'`). The retired `vault-curator.timer` remains disabled.

## Operator verification

```bash
curator-status                                    # next_sweep_at, service health
systemctl status vault-curator                    # service status
journalctl -u vault-curator --since "1 hour ago" # recent logs
```

Engine dry-run and count check:
```bash
# Call the engine's refresh-memory-note with dry_run: true
# Compare live_count + historical_count with list-memories { include_superseded: true } total
```

## Recovery

- **Malformed note:** fix the YAML/markers, then wait for the next scheduled sweep (or call `refresh-memory-note` explicitly).
- **Incorrectly expired memory:** reactivate it by setting `status: live` in the note (next ingest cycle) or call `expire-memory` with `reactivate: true`.
- **Stop scheduled writes:** disable the curator phase (revert/disable the memory-note-refresh in `runSweep`). SQLite remains authoritative; memory lineage and reactivation is the recovery mechanism. Do not delete the note or memory rows as rollback.

## Private vault data

Actual private `Settings/Memories.md` contents live in the vault and are never committed to the repo. This document describes the format and operational model only.
