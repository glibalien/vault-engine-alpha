import { describe, expect, it } from 'vitest';
import { parseCadence, isCadenceDue } from '../src/cadence.js';

describe('parseCadence', () => {
  it('parses d/h/m/w units to milliseconds', () => {
    expect(parseCadence('7d', 0)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseCadence('24h', 0)).toBe(24 * 60 * 60 * 1000);
    expect(parseCadence('90m', 0)).toBe(90 * 60 * 1000);
    expect(parseCadence('2w', 0)).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });
  it('returns the default for null/undefined/empty', () => {
    expect(parseCadence(null, 123)).toBe(123);
    expect(parseCadence(undefined, 123)).toBe(123);
    expect(parseCadence('   ', 123)).toBe(123);
  });
  it('throws on a malformed non-empty string', () => {
    expect(() => parseCadence('soon', 0)).toThrow();
    expect(() => parseCadence('7', 0)).toThrow();   // missing unit
    expect(() => parseCadence('0d', 0)).toThrow();   // must be >= 1
    expect(() => parseCadence('7y', 0)).toThrow();   // unknown unit
  });
});

describe('isCadenceDue', () => {
  const now = new Date('2026-06-26T12:00:00.000Z');
  it('is due when never curated (null prior)', () => {
    expect(isCadenceDue(null, 1000, now)).toBe(true);
  });
  it('is due when the prior timestamp is unparseable', () => {
    expect(isCadenceDue('not-a-date', 1000, now)).toBe(true);
  });
  it('is not due inside the window', () => {
    const oneDayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
    expect(isCadenceDue(oneDayAgo, 7 * 24 * 3600_000, now)).toBe(false);
  });
  it('is due past the window', () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600_000).toISOString();
    expect(isCadenceDue(eightDaysAgo, 7 * 24 * 3600_000, now)).toBe(true);
  });
  it('is due exactly at the boundary (age === cadenceMs)', () => {
    const exactlyAtWindow = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    expect(isCadenceDue(exactlyAtWindow, 7 * 24 * 3600_000, now)).toBe(true);
  });
});
