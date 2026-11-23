# Field-guess evidence fingerprints

Terminal outcomes (`abstained`, `rejected_value`, `rejected_reference`) suppress a
field only when node ID, field name, Markdown content hash, effective definition
hash, resolved model, classifier version, evidence hash, and evidence version match.
Successful sets and operational failures retain their existing retry policy.

Evidence version 1 uses SHA-256 over a canonical bounded projection built from the
same helpers as the model prompt:

- Identity: ID, bounded title (including the path/ID fallback), bounded path, and
  bounded type entries.
- Current fields: sorted keys, unwrapped values, canonical object-key order, and
  the existing structural truncation markers.
- Relationships: bounded, sorted outgoing/incoming summaries. Relationship context
  text is omitted by both the prompt and fingerprint.
- Body: the configured bounded prefix plus the same source-length/truncation
  representation used in the prompt.
- The full candidate field set, in candidate order. Each field uses its individually
  bounded offered-field projection, including exact mandatory constraints and any
  optional detail that could be shown when fewer fields are offered.
- Resolved model, output-token limit, and reasoning effort, which influence provider
  behavior and prompt budgets.

Section projections are captured before the provider's final space reductions.
The aggregate mandatory candidate cap bounds the number of field records; each
individual offered record is also capped. Hashing records incrementally keeps the
digest fixed-size without persisting evidence text. This conservative projection
can reconsider evidence that a particular large request later trims. It avoids
missing evidence that a smaller terminal-filtered batch would expose.

The hash always uses the full discovered candidate field set, while the model is
offered only nonterminal fields. Suppressing one field therefore does not itself
change the shared fingerprint and reopen its earlier terminal decision. All attempt
rows from one call carry the same evidence hash/version. Node version, timestamps,
field wrapper type/source metadata, and other non-prompt state are not hashed.
The existing content-hash dimension still independently detects Markdown changes.

## Admission and writes

A title or move can change prompt evidence without changing Markdown bytes. Incoming
relationship evidence can also change independently of a node's content hash. Exact
terminal suppression therefore needs one fresh `get-node` read with embeds disabled.
The sequence is cap check, content-hash availability, node read, version/hash guard,
evidence fingerprint and terminal lookup, prompt build, then paid-call admission.
No provider call occurs for fully suppressed nodes. Reads and stale/error skips do
not consume paid-call slots; provider entry remains the point that consumes a slot.

After the cap is spent, paging and cursor-cycle protection continue without node
body reads. Unread candidates count as deferred; their terminal status cannot be
known from the body-free candidate page. Queue serialization, one call per paid node,
one combined guarded Engine mutation, dry-run writes, and usage recording are unchanged.

## Migration and history

Curator migration 15 transactionally adds nullable `evidence_hash` and
`evidence_version` columns and replaces the terminal lookup index. It preserves
existing append-only rows, IDs, outcomes, and forensic data. Legacy rows have null
evidence because their original prompt evidence cannot be reconstructed safely;
they remain visible in history but never match a current evidence lookup.

New production attempts supply both evidence columns. Compatibility inserts with
neither column remain unknown evidence; supplying just one is rejected. A legacy
terminal candidate may be reconsidered once under the paid-call cap, after which an
unchanged new terminal result suppresses it normally. No Engine database, MCP wire
shape, provider schema, model routing, or production deployment changes are required.
