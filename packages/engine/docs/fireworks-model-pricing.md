# Fireworks model discovery pricing

`discover-models` first reads the authenticated Fireworks Models API for identities
and capabilities, then applies serverless/query/vision filters, catalog ordering,
and the result limit (at most 100). Only those visible results receive pricing
lookups. Discovery never changes existing model notes, pricing, or catalog versions.

Prices come from the public page at
`https://fireworks.ai/models/fireworks/<exact-model-slug>`. The adapter requires the
page's displayed `model path` to equal the full requested model ID, a single
`Available Serverless` card, USD amounts, explicit per-million-token units, and
recognized input/output or input/cached-input/output labels. It does not estimate
rates from model size, execute page scripts, or translate aliases. Redirects are
rejected: a transition from `qwen3p8-2p4t-a95b` to `qwen3p8-max` must not assign one
identity's rate to the other. Dedicated, batch, and priority prices are not inferred.

The current rendered format was checked on September 13, 2026 against
[Qwen 3.8 Max](https://fireworks.ai/models/fireworks/qwen3p8-max) and
[GPT OSS 120B](https://fireworks.ai/models/fireworks/gpt-oss-120b).
[Fireworks' pricing documentation](https://docs.fireworks.ai/serverless/pricing)
confirms USD per million tokens and the input/cached-input/output ordering.

Lookups share a resolver across MCP sessions using the same fetch implementation:

- At most four active public requests, with no API credentials sent.
- Five seconds per lookup including queue time and response-body reads; at most
  200 outstanding lookups. Excess requests use the static fallback immediately.
- Response bodies are capped at 1 MiB.
- In-flight requests for the same exact ID are deduplicated.
- Completed prices are cached for one hour; failures/missing prices for one minute.
  The completed cache holds at most 256 identities.

A missing source, changed format, timeout, identity mismatch, or invalid price
falls back to `@vault/pricing`'s exact static row. No family matching is used for
this fallback. Without an exact row, discovery returns `pricing: null` and model
addition omits pricing fields. Static rows are maintained list prices and can lag
provider updates; this fallback does not imply live verification.

`add-model` independently refreshes pricing for the selected exact ID before
checking collisions and writing the model note through the existing mutation
pipeline. It bypasses the completed cache. If an earlier discovery request is
still running, it waits for that request and starts a new lookup (up to ten seconds
total for pricing in this overlap case). A failed refresh discards the old live
price and uses the exact static fallback or leaves the model unpriced. Pricing
failure never prevents addition; existing provider-catalog validation still applies.

There are no schema migrations, new MCP fields, new credentials, paid model calls,
or changes to existing model notes. Updating the static table or other consumers'
legacy family fallback behavior is outside this feature.
