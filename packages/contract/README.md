# @vault/contract

`@vault/contract` defines the small wire contract shared by Vault Engine MCP
producers and consumers. It has zero runtime dependencies and intentionally knows
nothing about Engine internals, transports, storage, or UI.

The package is workspace-private today. Its types are still public contracts inside
the monorepo: changing them can affect Engine, Curator, Bench, chat UI, and any other
MCP client.

## What it owns

### Response envelopes

Every Engine MCP tool returns one of two shapes:

```ts
import type { Envelope } from '@vault/contract';

const success: Envelope<{ id: string }> = {
  ok: true,
  data: { id: 'node-1' },
  warnings: [],
};

const failure: Envelope<never> = {
  ok: false,
  error: {
    code: 'NOT_FOUND',
    message: 'No matching node',
  },
  warnings: [],
};
```

`Issue.code` is a plain string so new warning and validation codes are additive for
clients. `ErrorCode` is a closed union of the top-level failure codes Engine emits.
Warnings remain present on both success and failure branches.

### Shared verdicts

The package also provides pure outcome classifiers. Today only the benchmark uses them:

```ts
import { dryRunVerdict, verdict } from '@vault/contract';

verdict('query-nodes', {
  ok: true,
  data: { nodes: [], total: 0 },
  warnings: [],
}); // 'WEAK'

dryRunVerdict({
  ok: true,
  data: { updated: false },
  warnings: [{ code: 'REQUIRED_MISSING', message: 'status is required', severity: 'error' }],
}); // 'INVALID'
```

- `verdict()` returns `PASS`, `WEAK`, or `FAIL`. Only tools listed in
  `EMPTY_COLLECTION_KEYS` can be weak because an empty primary collection is a
  meaningful routing signal.
- `dryRunVerdict()` returns `VALID` or `INVALID`. It treats error-severity warnings
  in a successful dry-run envelope as invalid.

### Wiki page titles

`isValidWikiPageTitle`, `wikiTitleKey` and `wikiPageTitlePrefix` are the one rule for a new
wiki page's title (#557). The Engine enforces it when a wiki is reconciled; the Curator checks a
planned title with it before paying for any page, and gives the planner
`WIKI_TITLE_FORBIDDEN_CHARACTERS` and the safe "<root> — " prefix.

## Boundaries

- No runtime dependencies and no imports from another workspace package.
- No tool-specific data payload types beyond the generic envelope.
- No Engine implementation error classes or internal `IssueCode` union.
- No JSON parsing, MCP SDK integration, persistence, or UI behavior.

Engine keeps stricter internal types and verifies their assignability to this wire
shape with type-level conformance tests. When adding a top-level Engine failure code,
update `ErrorCode` here and trace all consumers. When a list-like tool becomes a weak
signal, update `EMPTY_COLLECTION_KEYS` and its verdict tests together.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | `Issue`, `ErrorCode`, `Envelope<T>`, and public exports |
| `src/verdict.ts` | Read/write outcome classifiers and empty-collection mapping |
| `src/index.test-d.ts` | Compile-time wire-shape checks |
| `src/verdict.test.ts` | Runtime verdict coverage |
| `src/wiki-title.ts` | The new wiki page title rule shared by Engine and Curator |

## Development

Run from the monorepo root:

```bash
npm run typecheck -w @vault/contract
npm run build -w @vault/contract
npm test -w @vault/contract
```

For contract changes, also run the relevant Engine/consumer tests and the root
dependency check.

## License

MIT
