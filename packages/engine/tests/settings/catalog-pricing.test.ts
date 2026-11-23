import { describe, expect, it } from 'vitest';
import { SEED_MODELS } from '@vault/settings-registry';
import { pricingFor } from '@vault/pricing';

// Pinned check (Phase 3 Task 10): every model the settings catalog seeds must
// have a @vault/pricing row. Unpriced is loud (a warning + cost 0 in the spend
// ledger), never silent — this test is the earliest possible catch, before a
// seeded model ever makes its first paid call. Re-verify claude-* rows against
// https://platform.claude.com/docs/en/about-claude/pricing (not memory) any
// time a new Claude model joins SEED_MODELS.
describe('seed catalog ↔ pricing', () => {
  it('every seed catalog model has a pricing row (unpriced is loud, never silent)', () => {
    for (const m of SEED_MODELS) expect(pricingFor(m.model), m.model).not.toBeNull();
  });
});
