/** Fixed SQL expressions only. Legacy malformed metadata is unknown, never fatal. */
export function usageMetadata(path: string): string {
  if (!/^\$\.[a-zA-Z0-9_.]+$/.test(path)) throw new Error('invalid usage metadata path');
  return `json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '${path}')`;
}

/** Purposes the Engine records itself, from the provider response it holds, even when the call
 *  is filed under the Curator's service (memory consolidation behind the Curator's create-memory
 *  counts against the Curator's budget, #311). The Curator's usage-completeness marker belongs to
 *  calls the Curator reports; it never writes one for these, so they are not incomplete. */
const ENGINE_RECORDED_PURPOSES = ['memory-consolidation', 'memory-consolidation-run'] as const;
const ENGINE_RECORDED_SQL = ENGINE_RECORDED_PURPOSES.map(p => `'${p}'`).join(', ');

/** A row's confirmed provider cost (#329), NULL until the provider's own log confirms it.
 *  Correlated on `usage_events` by name, so a query using these must not alias that table. */
const CONFIRMED_COST = `(SELECT c.confirmed_cost_usd FROM usage_confirmations c
    WHERE c.usage_event_id = usage_events.id AND c.status = 'confirmed')`;

/** What providers' own logs confirmed, against the ledger's figure for the same rows. */
export const CONFIRMED_HEADERS = ['confirmed_usd', 'confirmed_events', 'confirmed_ledger_usd'] as const;
export const CONFIRMED_SUMS = `
  COALESCE(SUM(${CONFIRMED_COST}), 0) AS confirmed_usd,
  COALESCE(SUM(${CONFIRMED_COST} IS NOT NULL), 0) AS confirmed_events,
  COALESCE(SUM(CASE WHEN ${CONFIRMED_COST} IS NOT NULL THEN cost_usd ELSE 0 END), 0) AS confirmed_ledger_usd`;

export const COST_HEADERS = [
  'provider_reported_usd', 'estimated_usd', 'provider_reported_events', 'estimated_events',
  'unpriced_events', 'incomplete_usage_events', ...CONFIRMED_HEADERS,
] as const;

export const COST_SUMS = `
  COALESCE(SUM(CASE WHEN cost_basis = 'provider-reported' THEN cost_usd ELSE 0 END), 0) AS provider_reported_usd,
  COALESCE(SUM(CASE WHEN cost_basis = 'computed' THEN cost_usd ELSE 0 END), 0) AS estimated_usd,
  COALESCE(SUM(cost_basis = 'provider-reported'), 0) AS provider_reported_events,
  COALESCE(SUM(cost_basis = 'computed'), 0) AS estimated_events,
  COALESCE(SUM(cost_basis = 'unpriced'), 0) AS unpriced_events,
  COALESCE(SUM(service = 'curator' AND purpose NOT IN (${ENGINE_RECORDED_SQL})
    AND COALESCE(${usageMetadata('$.curator_usage.usage_complete')}, 0) != 1), 0) AS incomplete_usage_events,
  ${CONFIRMED_SUMS}`;

export const SWEEP_COLUMN = usageMetadata('$.curator_usage.sweep_ref');
export const STAGE_COLUMN = `COALESCE(${usageMetadata('$.curator_usage.stage')}, ${usageMetadata('$.wiki_call.stage')})`;
export const OUTCOME_COLUMN = `COALESCE(${usageMetadata('$.curator_usage.outcome')}, ${usageMetadata('$.wiki_call.outcome')})`;
/** The model the response says served the call: the Engine's own calls and record-usage's
 *  `reported_model` store it at the top of the metadata, the Curator's report under
 *  `curator_usage` (#340). */
export const REPORTED_MODEL_COLUMN = `COALESCE(${usageMetadata('$.reported_model')}, ${usageMetadata('$.curator_usage.reported_model')})`;
