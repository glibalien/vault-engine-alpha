// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider } from '../src/viz-client-context.js';
import { SpendCard, resolveSpendRange } from '../src/SpendCard.js';
import type { SpendCardSpec } from '../src/board-card-spec.js';

const env = (data: unknown, warnings: unknown[] = []): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data, warnings }) }],
});

const NOW = new Date(2026, 10, 3, 15, 0); // 3 Nov 2026, local
const TOTALS = { events: 40, cost_usd: 3.5, provider_reported_usd: 1.25, estimated_usd: 2.25, unpriced_events: 0, incomplete_usage_events: 0 };

/** An Engine that answers usage-report by its arguments, and get-settings with a $1.00 cap. */
function engine(over: { totals?: Record<string, unknown>; warnings?: unknown[]; capCents?: number | null; driverCount?: number; reconciliation?: Record<string, unknown> } = {}) {
  return vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
    if (req.name === 'get-settings') {
      return env({ domains: { curator: { effective: { dailyBudgetCents: over.capCents === undefined ? 100 : over.capCents } } } });
    }
    const a = req.arguments;
    if (a.service === 'curator') return env({ groups: [], totals: { cost_usd: 0.85, events: 9 } });
    if (Array.isArray(a.group_by) && a.group_by[0] === 'day') {
      const days = resolveSpendRange('month').days; // the component resolves against the (pinned) clock
      return env({ groups: [
        { day: days[days.length - 1], cost_usd: 2, events: 10 }, // the server sorts by cost; the view sorts by day
        { day: days[0], cost_usd: 1.5, events: 30 },
      ], totals: { ...TOTALS, ...over.totals }, ...(over.reconciliation ? { reconciliation: over.reconciliation } : {}) }, over.warnings ?? []);
    }
    return env({ groups: [
      { service: 'curator', purpose: 'wiki-synthesis', cost_usd: 2.5, events: 20 },
      { service: 'engine', purpose: 'audio-transcription', cost_usd: 1, events: 2 },
    ], group_count: over.driverCount ?? 2, totals: TOTALS });
  });
}

function renderSpend(spec: SpendCardSpec, call = engine(), onSpecChange?: (s: SpendCardSpec) => void) {
  render(<VizClientProvider call={call as never}><SpendCard spec={spec} onSpecChange={onSpecChange} /></VizClientProvider>);
  return call;
}

const SPEC: SpendCardSpec = { kind: 'spend', title: 'Usage and cost', range: 'month' };

describe('resolveSpendRange', () => {
  it('this month runs from the 1st to today; last 30 days ends today', () => {
    const month = resolveSpendRange('month', NOW);
    expect(month.days).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(month.since).toBe(new Date(2026, 10, 1).toISOString());
    expect(month.label).toBe('This month (November 2026)');
    const last30 = resolveSpendRange('30d', NOW);
    expect(last30.days).toHaveLength(30);
    expect(last30.days.at(-1)).toBe('2026-11-03');
    expect(last30.days[0]).toBe('2026-10-05');
  });
});

describe('SpendCard (#281)', () => {
  // The card reads the clock when it loads. Pin it to mid-June so the range has several days and
  // no daylight-saving change: on the 1st the mock's first and last days are one bar, and a range
  // across a change is queried per offset (covered under "day boundaries" below).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 18, 15, 0));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the totals with provider-reported and estimated cost apart, without any model call', async () => {
    const call = renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    expect(screen.getByText('spent · 40 calls')).toBeTruthy();
    expect(screen.getByText('$1.25')).toBeTruthy();
    expect(screen.getByText('reported by providers')).toBeTruthy();
    expect(screen.getByText('$2.25')).toBeTruthy();
    expect(screen.getByText('estimated from prices')).toBeTruthy();
    const tools = call.mock.calls.map(([req]) => req.name);
    expect(new Set(tools)).toEqual(new Set(['usage-report', 'get-settings']));
  });

  it('computes the range when it loads and buckets by local day', async () => {
    const call = renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    const byDay = call.mock.calls.map(([req]) => req.arguments).find((a) => Array.isArray(a.group_by) && a.group_by[0] === 'day')!;
    expect(byDay.since).toBe(resolveSpendRange('month').since);
    expect(byDay.utc_offset_minutes).toBe(-new Date().getTimezoneOffset());
  });

  it("shows Curator's spend today against its daily cap, or says there is no cap", async () => {
    renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('Curator today · cap $1.00')).toBeTruthy());
    expect(screen.getByText('$0.85')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-label')).toBe('Curator today: $0.85 of its $1.00 daily cap');
    cleanup();
    renderSpend(SPEC, engine({ capCents: null }));
    await waitFor(() => expect(screen.getByText('Curator today · no daily cap')).toBeTruthy());
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('has one column per day in the range, each labelled with its value', async () => {
    renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    const bars = screen.getAllByRole('listitem');
    expect(bars.length).toBe(resolveSpendRange('month').days.length);
    expect(bars.some((b) => /: \$2\.00 · 10 calls$/.test(b.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('lists the top drivers by service and purpose, with a cue when there are more', async () => {
    renderSpend(SPEC, engine({ driverCount: 9 }));
    await waitFor(() => expect(screen.getByText('wiki-synthesis')).toBeTruthy());
    expect(screen.getByText('audio-transcription')).toBeTruthy();
    expect(screen.getByText('top 2 of 9')).toBeTruthy();
  });

  it('calls out unpriced and incomplete calls only when there are some', async () => {
    renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    expect(screen.queryByText(/have no price/)).toBeNull();
    cleanup();
    renderSpend(SPEC, engine({
      totals: { unpriced_events: 165, incomplete_usage_events: 460 },
      warnings: [{ code: 'UNPRICED_MODELS', message: 'm', details: { unpriced: [{ model: 'openrouter/auto', events: 165 }] } }],
    }));
    await waitFor(() => expect(screen.getByText(/165 calls have no price \(openrouter\/auto\), so the total undercounts/)).toBeTruthy());
    expect(screen.getByText(/460 calls reported incomplete usage/)).toBeTruthy();
  });

  it("doesn't tell the owner to price Auto Router, which has no rate of its own (#340)", async () => {
    const note = () => screen.getByText(/calls have no price/).textContent ?? '';
    renderSpend(SPEC, engine({
      totals: { unpriced_events: 165 },
      warnings: [{ code: 'UNPRICED_MODELS', message: 'm', details: { unpriced: [{ model: 'openrouter/auto', events: 165, provider_priced: true }] } }],
    }));
    await waitFor(() => expect(screen.getByText(/calls have no price/)).toBeTruthy());
    expect(note()).toMatch(/openrouter\/auto has no price of its own: these calls didn't report OpenRouter's charge/);
    expect(note()).not.toMatch(/Settings\/Models/);
    cleanup();
    renderSpend(SPEC, engine({
      totals: { unpriced_events: 170 },
      warnings: [{ code: 'UNPRICED_MODELS', message: 'm', details: { unpriced: [
        { model: 'openrouter/auto', events: 165, provider_priced: true }, { model: 'some/new-model', events: 5 },
      ] } }],
    }));
    await waitFor(() => expect(screen.getByText(/calls have no price/)).toBeTruthy());
    expect(note()).toMatch(/Add a price to the model's note in Settings\/Models/);
    expect(note()).toMatch(/openrouter\/auto has no price of its own/);
  });

  it("shows what providers' own logs confirmed, only when they confirmed something", async () => {
    renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    expect(screen.queryByText(/own logs confirm/)).toBeNull();
    cleanup();
    renderSpend(SPEC, engine({ totals: { confirmed_usd: 1.62, confirmed_events: 12, confirmed_ledger_usd: 1.8 } }));
    await waitFor(() => expect(screen.getByText(/own logs confirm \$1\.62 for 12 calls we estimated at \$1\.80/)).toBeTruthy());
  });

  it("compares OpenRouter's own figure with the ledger when there are reading intervals", async () => {
    renderSpend(SPEC);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    expect(screen.queryByText(/OpenRouter reports/)).toBeNull();
    cleanup();
    renderSpend(SPEC, engine({ reconciliation: { intervals: 2, provider_usd: 1.4, ledger_usd: 1.25, gap_usd: 0.15 } }));
    await waitFor(() => expect(screen.getByText(/OpenRouter reports \$1\.40 over 2 daily readings; the ledger has \$1\.25 for the same hours, \$0\.15 less\. A difference can come from calls the ledger missed/)).toBeTruthy());
    expect(screen.getByText(/5\.5% credit fee/)).toBeTruthy();
    cleanup();
    renderSpend(SPEC, engine({ reconciliation: { intervals: 1, provider_usd: 0.5, ledger_usd: 0.8, gap_usd: -0.3 } }));
    await waitFor(() => expect(screen.getByText(/over 1 daily reading; the ledger has \$0\.80 for the same hours, \$0\.30 more\. .*spend on another key/)).toBeTruthy());
  });

  it('switches between this month and the last 30 days through the view spec', async () => {
    const onSpecChange = vi.fn();
    renderSpend(SPEC, engine(), onSpecChange);
    await waitFor(() => expect(screen.getByText('$3.50')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('date range'), { target: { value: '30d' } });
    expect(onSpecChange).toHaveBeenCalledWith({ ...SPEC, range: '30d' });
  });

  it('shows a usage-report failure', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: 'boom' } }) }] }));
    renderSpend(SPEC, call as never);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));
  });
});

describe('day boundaries (#309 review)', () => {
  const savedTz = process.env.TZ;
  afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

  it("startOfDayInZone gives midnight in the zone, matching Curator's cap day", async () => {
    const { startOfDayInZone } = await import('../src/SpendCard.js');
    expect(startOfDayInZone(new Date('2026-11-03T15:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(startOfDayInZone(new Date('2026-11-03T15:00:00Z'), 'UTC').toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(startOfDayInZone(new Date('2026-11-03T20:00:00Z'), 'Asia/Tokyo').toISOString()).toBe('2026-11-03T15:00:00.000Z');
    // The day daylight saving ends: midnight was still EDT.
    expect(startOfDayInZone(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('a range across a daylight-saving change is queried per offset, and edge buckets are kept', async () => {
    process.env.TZ = 'America/New_York';
    const { loadSpendView, offsetSegments } = await import('../src/SpendCard.js');
    expect(offsetSegments(['2026-10-31', '2026-11-01', '2026-11-02'])).toEqual([
      { days: ['2026-10-31', '2026-11-01'], offset: -240 },
      { days: ['2026-11-02'], offset: -300 },
    ]);
    const now = new Date(2026, 10, 3, 10, 0); // 3 Nov, EST
    const calls: Array<Record<string, unknown>> = [];
    const call = vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name: req.name, ...req.arguments });
      if (req.name === 'get-settings') return env({ domains: { curator: { effective: { dailyBudgetCents: 300, tz: 'Asia/Tokyo' } } } });
      const a = req.arguments;
      if (a.service === 'curator') return env({ groups: [], totals: { cost_usd: 0.4 } });
      if (Array.isArray(a.group_by) && a.group_by[0] === 'day') {
        return a.utc_offset_minutes === -240
          ? env({ groups: [{ day: '2026-10-31', cost_usd: 0.25, events: 1 }, { day: '2026-11-01', cost_usd: 1, events: 2 }], totals: { cost_usd: 1.25, events: 3 } })
          : env({ groups: [{ day: '2026-11-03', cost_usd: 2, events: 4 }], totals: { cost_usd: 2, events: 4 } });
      }
      return env({ groups: [], totals: {} });
    });
    const res = await loadSpendView(call as never, 'month', now);
    if (!res.ok) throw new Error(res.message);
    const byDay = calls.filter((c) => Array.isArray(c.group_by) && (c.group_by as string[])[0] === 'day');
    expect(byDay).toEqual([
      expect.objectContaining({ since: '2026-11-01T04:00:00.000Z', until: '2026-11-02T04:59:59.999Z', utc_offset_minutes: -240 }),
      expect.objectContaining({ since: '2026-11-02T05:00:00.000Z', utc_offset_minutes: -300 }),
    ]);
    expect(byDay[1]).not.toHaveProperty('until');
    expect(res.view.days).toEqual([
      { day: '2026-11-01', cost: 1.25, calls: 3 }, // the edge bucket joins the nearest day in range
      { day: '2026-11-02', cost: 0, calls: 0 },
      { day: '2026-11-03', cost: 2, calls: 4 },
    ]);
    expect(res.view.totals.cost_usd).toBe(3.25);
    // Curator's cap day is its own zone's.
    const curator = calls.find((c) => c.service === 'curator')!;
    expect(curator.since).toBe(new Date('2026-11-03T15:00:00.000Z').toISOString()); // 4 Nov 00:00 in Tokyo
    expect(res.view.curatorToday).toEqual({ spent: 0.4, capUsd: 3, zone: 'Asia/Tokyo' });
  });
});
