import { describe, expect, it } from 'vitest';
import { computeNextRun, needsCatchUp, startScheduler, SWEEP_INTERVAL_MS } from '../src/scheduler.js';

const TZ = 'America/New_York';
const iso = (d: Date) => d.toISOString();

describe('computeNextRun (DST-correct via IANA tz)', () => {
  it('same day before the time → today', () => {
    expect(iso(computeNextRun(new Date('2026-06-01T00:00:00Z'), '05:00', TZ))).toBe('2026-06-01T09:00:00.000Z');
  });

  it('same day after the time → tomorrow', () => {
    expect(iso(computeNextRun(new Date('2026-06-01T12:00:00Z'), '05:00', TZ))).toBe('2026-06-02T09:00:00.000Z');
  });

  it('crosses spring-forward correctly (not naive +24h)', () => {
    expect(iso(computeNextRun(new Date('2026-03-07T12:00:00Z'), '05:00', TZ))).toBe('2026-03-08T09:00:00.000Z');
  });

  it('crosses fall-back correctly (not naive +24h)', () => {
    expect(iso(computeNextRun(new Date('2026-10-31T12:00:00Z'), '05:00', TZ))).toBe('2026-11-01T10:00:00.000Z');
  });
});

describe('needsCatchUp', () => {
  it('true when there is no prior sweep', () => {
    expect(needsCatchUp(null, new Date('2026-06-01T00:00:00Z'), SWEEP_INTERVAL_MS)).toBe(true);
  });
  it('false when the last sweep is recent', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    expect(needsCatchUp(new Date('2026-06-01T05:00:00Z'), now, SWEEP_INTERVAL_MS)).toBe(false);
  });
  it('true when the last sweep is older than the interval', () => {
    const now = new Date('2026-06-03T12:00:00Z');
    expect(needsCatchUp(new Date('2026-06-01T05:00:00Z'), now, SWEEP_INTERVAL_MS)).toBe(true);
  });
});

describe('startScheduler', () => {
  it('arms a timer, fires the injected sweep, then re-arms; stop cancels', async () => {
    let captured: (() => void) | null = null;
    let arms = 0;
    let cleared = 0;
    const setTimer = (cb: () => void, _ms: number) => { captured = cb; arms += 1; return { clear: () => { cleared += 1; } }; };
    const clock = { now: () => new Date('2026-06-01T00:00:00Z') };
    let sweeps = 0;
    const handle = startScheduler({
      schedule: () => ({ hhmm: '05:00', tz: TZ }), clock, setTimer, sweep: async () => { sweeps += 1; },
    });
    expect(arms).toBe(1);
    await captured!(); // fire
    expect(sweeps).toBe(1);
    expect(arms).toBe(2); // re-armed after the fire
    handle.stop();
    expect(cleared).toBeGreaterThanOrEqual(1);
  });

  it('calls onError and keeps running if the sweep throws', async () => {
    const errors: unknown[] = [];
    let captured: (() => void | Promise<void>) | null = null;
    let arms = 0;
    const setTimer = (cb: () => void | Promise<void>) => { captured = cb; arms += 1; return { clear: () => {} }; };
    const clock = { now: () => new Date('2026-06-01T00:00:00Z') };
    startScheduler({
      schedule: () => ({ hhmm: '05:00', tz: TZ }), clock, setTimer,
      sweep: async () => { throw new Error('boom'); },
      onError: (e) => { errors.push(e); },
    });
    await captured!();
    expect(errors).toHaveLength(1);
    expect(arms).toBe(2); // loop re-armed despite the failure
  });

  it('re-arms with FRESH schedule values after a sweep (sweepAt edits apply after the next run)', async () => {
    let hhmm = '05:00';
    const fires: number[] = [];
    let captured: (() => void | Promise<void>) | null = null;
    const setTimer = (cb: () => void | Promise<void>, ms: number) => {
      fires.push(ms); captured = cb; return { clear: () => {} };
    };
    const clock = { now: () => new Date('2026-07-11T00:00:00Z') };
    startScheduler({ schedule: () => ({ hhmm, tz: 'UTC' }), sweep: async () => { hhmm = '07:00'; }, clock, setTimer });
    expect(fires[0]).toBe(5 * 3600_000);        // armed for 05:00
    await captured!();                          // fire → sweep changes the setting
    expect(fires[1]).toBe(7 * 3600_000);        // re-armed from the FRESH value
  });
});
