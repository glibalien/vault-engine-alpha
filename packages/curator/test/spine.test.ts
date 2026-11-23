import { describe, expect, it } from 'vitest';
import { subpageTitle, partitionSubpages, resolveRequestedTitle } from '../src/spine.js';
import type { WikiSubpageRef } from '../src/types.js';

describe('subpageTitle', () => {
  it('project-qualifies the node title', () => {
    expect(subpageTitle('Demo', 'Task Board')).toBe('Demo — Task Board');
  });
});

describe('partitionSubpages', () => {
  const subs: WikiSubpageRef[] = [
    { id: 's1', title: 'Demo — Task Board' },
    { id: 's2', title: 'Demo — Contacts' },
    { id: 's3', title: 'Demo — ID Verification Pilot', wiki_state: 'active' },
    { id: 's4', title: 'Demo — Vendor Bake-off', wiki_state: 'dormant' },
    { id: 's5', title: 'Demo — Meetings' },
  ];

  it('routes retired spine labels (incl. Contacts/Notes) to legacy, everything else to themed', () => {
    const { spine, themed, legacy } = partitionSubpages('Demo', subs);
    expect(spine.map(s => s.id)).toEqual([]);
    expect(themed.map(s => s.id)).toEqual(['s3', 's4']);
    expect(legacy.map(s => s.id)).toEqual(['s1', 's2', 's5']); // Task Board, Contacts, Meetings
  });

  it('is empty-safe', () => {
    expect(partitionSubpages('Demo', [])).toEqual({ spine: [], themed: [], legacy: [] });
  });

  it('routes a page named after a retired spine label (e.g. "— Notes") to legacy, not themed', () => {
    const { spine, themed, legacy } = partitionSubpages('Demo', [{ id: 'x', title: 'Demo — Notes' }]);
    expect(spine).toEqual([]);
    expect(themed).toEqual([]);
    expect(legacy.map(s => s.id)).toEqual(['x']);
  });
});

describe('resolveRequestedTitle', () => {
  const existing: WikiSubpageRef[] = [
    { id: 's1', title: 'Demo — Contacts' },
    { id: 's2', title: 'Demo — ID Check Pilot', wiki_state: 'active' },
  ];

  it('qualifies a brand-new title', () => {
    expect(resolveRequestedTitle('Demo', 'Rollout Plan', existing))
      .toEqual({ qualifiedTitle: 'Demo — Rollout Plan', existingId: null });
  });

  it('resolves a bare title to its existing page (refresh)', () => {
    expect(resolveRequestedTitle('Demo', 'ID Check Pilot', existing))
      .toEqual({ qualifiedTitle: 'Demo — ID Check Pilot', existingId: 's2' });
  });

  it('resolves an already-qualified title to its existing page (refresh)', () => {
    expect(resolveRequestedTitle('Demo', 'Demo — ID Check Pilot', existing))
      .toEqual({ qualifiedTitle: 'Demo — ID Check Pilot', existingId: 's2' });
  });

  it('matches spine pages too', () => {
    expect(resolveRequestedTitle('Demo', 'Contacts', existing))
      .toEqual({ qualifiedTitle: 'Demo — Contacts', existingId: 's1' });
  });
});
