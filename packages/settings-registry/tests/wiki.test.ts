import { describe, expect, it } from 'vitest';
import { validateDomainPatch, defaultsFor, descriptorsFor } from '../src/index.js';

describe('wiki domain', () => {
  it('keeps only rendering settings and task windows; the names moved to the vault domain', () => {
    expect(descriptorsFor('wiki')).toHaveLength(7);
    expect(defaultsFor('wiki')).toEqual({
      subpageCap: 20, liveTaskGroupCap: 8, liveRelatedCap: 12, renderRelatedLive: true,
      staleDays: 30, upcomingDays: 14, recentDays: 7,
    });
  });
  it('bounds the task windows to whole days from 1 to 3650', () => {
    for (const key of ['staleDays', 'upcomingDays', 'recentDays']) {
      expect(validateDomainPatch('wiki', { [key]: 0 }).issues).toHaveLength(1);
      expect(validateDomainPatch('wiki', { [key]: 1.5 }).issues).toHaveLength(1);
      expect(validateDomainPatch('wiki', { [key]: 3651 }).issues).toHaveLength(1);
      expect(validateDomainPatch('wiki', { [key]: 3650 }).valid).toEqual({ [key]: 3650 });
    }
  });
  it('validates its own keys and treats the moved names as unknown here', () => {
    expect(validateDomainPatch('wiki', { subpageCap: 0 }).issues).toHaveLength(1);
    expect(validateDomainPatch('wiki', { renderRelatedLive: 'yes' }).issues).toHaveLength(1);
    expect(validateDomainPatch('wiki', { subpageCap: 5 }).valid).toEqual({ subpageCap: 5 });
    // Aliases are resolved by the Engine's settings service, not by the registry validator.
    expect(validateDomainPatch('wiki', { wikiDir: 'Wiki' }).issues[0]?.code).toBe('SETTINGS_UNKNOWN_KEY');
  });
});
