# @vault/pricing

`@vault/pricing` is the suite-wide fallback rate table and cost-arithmetic package.
Engine, Curator, `@vault/llm`, Bench, the installer, and the Obsidian plugin use the same
functions so a token or audio unit is priced consistently across surfaces.

The package has zero runtime dependencies and performs no network calls. Rates are
maintained explicitly in source and covered by tests.

## Units and precedence

- Language-model rates are US dollars per one million tokens.
- Audio rates are US dollars per audio minute.
- `resolvePricing()` prefers pricing stored on a model-catalog entry, then falls back
  to the static table, then returns `null`.
- Missing cache rates on a catalog entry fall back to its input rate.
- Unknown models remain unpriced; callers must surface that state instead of silently
  inventing a cost.

Engine snapshots the resolved unit prices alongside each usage event. Updating this
package changes future calculations and explicit backfills, not historical snapshots
already recorded in the ledger.

## Usage

```ts
import {
  estimateCostUsdWith,
  resolvePricing,
  type TokenUsage,
} from '@vault/pricing';

const pricing = resolvePricing('provider/model-id', {
  input: 0.4,
  output: 1.6,
  cacheRead: 0.08,
});

const usage: TokenUsage = {
  input: 10_000,
  output: 2_000,
  cacheWrite: 0,
  cacheRead: 20_000,
};

const cost = pricing ? estimateCostUsdWith(pricing, usage) : null;
```

Audio helpers use seconds at the call site and convert internally:

```ts
import { audioCostUsd } from '@vault/pricing';

audioCostUsd('deepgram-nova-3', 600); // ten minutes
```

## Public API

| Export | Purpose |
| --- | --- |
| `pricingForExact(model)` | Resolve only an exact static row, without family guesses (used by Fireworks discovery) |
| `pricingFor(model)` | Resolve an exact or supported family fallback from the static table |
| `resolvePricing(model, entryPricing?)` | Apply catalog-first pricing precedence |
| `estimateCostUsd(model, usage)` | Price token usage through the static table |
| `estimateCostUsdWith(pricing, usage)` | Price token usage with an already resolved rate |
| `audioPricingFor(model)` | Resolve a per-minute audio rate |
| `audioCostUsd(model, seconds)` | Price one audio call |
| `addUsage(a, b)` | Sum token buckets |
| `ZERO_USAGE` | Zeroed `TokenUsage` accumulator |
| `formatUsage(usage, cost)` | Produce the shared compact usage summary |

## Updating rates

1. Verify the provider's current list price and the exact model ID used by the
   catalog or adapter.
2. Update the static row and its source/date comment in `src/index.ts`.
3. Add or update an exact-value regression test.
4. Check model-catalog notes that carry their own pricing, because those values take
   precedence over the static row.
5. Run Engine settings/pricing tests when a seeded model changes.

Do not fetch rates at runtime from this package or add provider SDKs to it.

## Development

```bash
npm run typecheck -w @vault/pricing
npm run build -w @vault/pricing
npm test -w @vault/pricing
```

## License

MIT
