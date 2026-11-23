import { describe, expect, it } from 'vitest';
import { VIZ_KINDS, isVizSpec, vizQueryArgs, type VizSpec } from '../src/viz-spec';
import { parseBoardCardSpec } from '../src/board-card-spec';

const base: VizSpec = { kind: 'calendar', title: 'due dates', query: { types: ['task'] }, display_fields: ['status'] };

describe('calendar VizKind', () => {
  it('includes calendar in VIZ_KINDS', () => {
    expect(VIZ_KINDS).toContain('calendar');
  });
  it('accepts a calendar spec with an optional date_field', () => {
    expect(isVizSpec({ ...base, date_field: 'due' })).toBe(true);
    expect(isVizSpec(base)).toBe(true); // date_field optional
  });
  it('rejects a non-string date_field', () => {
    expect(isVizSpec({ ...base, date_field: 5 })).toBe(false);
  });
  it('accepts an optional string end_date_field and rejects any other (#574)', () => {
    expect(isVizSpec({ ...base, date_field: 'start', end_date_field: 'end' })).toBe(true);
    expect(isVizSpec({ ...base, end_date_field: 5 })).toBe(false);
  });
  it('keeps end_date_field on a board card, and refuses a malformed one (#574)', () => {
    expect(parseBoardCardSpec({ ...base, date_field: 'start', end_date_field: 'end' })).toMatchObject({ end_date_field: 'end' });
    expect(parseBoardCardSpec({ ...base, end_date_field: ['end'] })).toBeNull();
  });
});

describe('vizQueryArgs for calendar', () => {
  it('includes the chosen date_field in include_fields', () => {
    const args = vizQueryArgs({ ...base, date_field: 'due' });
    expect(args.include_fields).toContain('due');
  });
  it('includes the fallback date candidates when date_field is unset', () => {
    const args = vizQueryArgs(base);
    expect(args.include_fields).toEqual(expect.arrayContaining(['due', 'date', 'scheduled']));
  });
  it('also fetches the end field (#574)', () => {
    expect(vizQueryArgs({ ...base, date_field: 'start', end_date_field: 'end' }).include_fields).toEqual(expect.arrayContaining(['start', 'end']));
    expect(vizQueryArgs({ ...base, end_date_field: 'end' }).include_fields).toEqual(expect.arrayContaining(['due', 'date', 'scheduled', 'end']));
  });
  it('leaves non-calendar specs unchanged (no date candidates injected)', () => {
    const args = vizQueryArgs({ kind: 'table', title: 't', query: {}, display_fields: ['status'] });
    expect(args.include_fields).not.toContain('scheduled');
  });
});
