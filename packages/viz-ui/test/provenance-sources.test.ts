import { expect, it } from 'vitest';
import type { ProvenanceInputMetadata } from '@vault/query-core';
import {
  diffBuilds,
  friendlyTime,
  groupSources,
  inBuildOrder,
  internalInputLabel,
  linesMentioning,
  memoryText,
  sourceUse,
} from '../src/provenance-sources.js';

const input = (
  over: Partial<ProvenanceInputMetadata> & { native?: string; kind?: 'node' | 'memory' | 'curator_correction' },
): ProvenanceInputMetadata => {
  const { native, kind = 'node', ...rest } = over;
  return {
    id: `${native ?? 'opaque'}:${over.selection ?? 'x'}`,
    source_id: native ?? null,
    source: native ? { kind, namespace: 'ns', native_id: native } : null,
    role: 'engine_projection',
    selection: 'task-fields:v1',
    origin: native ? 'identified' : 'opaque',
    truncated: false,
    retained_bytes: 10,
    observation_digest: null,
    observed_at: null,
    label: native ? `Title ${native}` : null,
    path: null,
    comparison: 'unchanged',
    ...rest,
  };
};

it('maps curator selections to plain uses', () => {
  expect(sourceUse('formatted-node-body-prefix:v1')).toBe('read');
  expect(sourceUse('gap-fill-candidate:v1')).toBe('lead');
  expect(sourceUse('requested-related:v1')).toBe('lead');
  expect(sourceUse('timeline-projection:v1')).toBe('timeline');
  expect(sourceUse('salience-projection:v1')).toBe('active');
  expect(sourceUse('requested-tasks:open:row:v2')).toBe('task');
  expect(sourceUse('subpage-title-context:v1')).toBe('page_list');
  expect(sourceUse('something-new:v3')).toBe('other');
  expect(sourceUse(null)).toBe('other');
  expect(internalInputLabel('system:v1')).toBe('Curator instructions');
  expect(internalInputLabel('opaque-timeline-projection:v1')).toBe(
    'Heading and layout of the timeline of dated tasks and meetings',
  );
  expect(internalInputLabel('mystery:v1')).toBe('Other curator input');
});

it('folds each source into one row and groups rows by how they were used', () => {
  const groups = groupSources(
    [
      input({ native: 'a', selection: 'timeline-projection:v1' }),
      input({ native: 'a', selection: 'formatted-node-body-prefix:v1', role: 'source_material', truncated: true }),
      input({ native: 'b', selection: 'task-fields:v1' }),
      input({ native: 'b', selection: 'salience-projection:v1', comparison: 'changed' }),
      input({ native: 'home', selection: 'wiki-narrative-context:v1', role: 'generated_context', comparison: 'expected_self_transition' }),
      input({ native: 'sib', selection: 'subpage-title-context:v1', role: 'generated_context' }),
      input({ native: '12', kind: 'memory', selection: 'memory:v1', role: 'generated_context', label: null }),
      input({ native: '30', kind: 'memory', selection: 'memory:v1', role: 'human_correction', label: null }),
      input({ selection: 'system:v1', role: 'generated_context' }),
    ],
    'home',
  );
  expect(groups.read.map((r) => r.title)).toEqual(['Title a']);
  expect(groups.read[0]!.uses).toEqual(['read', 'timeline']);
  expect(groups.read[0]!.primary.selection).toBe('formatted-node-body-prefix:v1');
  expect(groups.read[0]!.truncated).toBe(true);
  expect(groups.mentioned.map((r) => [r.title, r.status])).toEqual([['Title b', 'changed']]);
  expect(groups.pages.map((r) => [r.title, r.isTarget, r.status])).toEqual([
    ['Title home', true, 'self'],
    ['Title sib', false, 'unchanged'],
  ]);
  expect(groups.memories.map((r) => [r.source?.native_id, r.fromOwner])).toEqual([
    ['30', true],
    ['12', false],
  ]);
  expect(groups.internal).toHaveLength(1);
});

it('lists memories in the order the build gave them, not by id (#551)', () => {
  const memory = (native: string, start?: number, field = 'evidence') =>
    input({ native, kind: 'memory', selection: 'memory:v2', role: 'generated_context', label: null,
      ...(start === undefined ? {} : { position: { field, start } }) });
  // The build put an older memory from the project's own meeting before newer ones.
  const groups = groupSources([memory('900', 300), memory('12', 100), memory('450', 200)], null);
  expect(groups.memories.map((r) => r.source?.native_id)).toEqual(['12', '450', '900']);
  expect(inBuildOrder(groups.memories)).toBe(true);

  // Without positions (an older Engine, or purged spans) they fall back to newest first, after the rest.
  const mixed = groupSources([memory('5'), memory('7'), memory('3', 50)], null);
  expect(mixed.memories.map((r) => r.source?.native_id)).toEqual(['3', '7', '5']);
  expect(inBuildOrder(mixed.memories)).toBe(false);
});

it('treats an unchecked comparison as unknown rather than unchanged', () => {
  const groups = groupSources(
    [input({ native: 'a', comparison: undefined }), input({ native: 'b', comparison: 'unavailable' })],
    null,
  );
  expect(groups.mentioned.map((r) => r.status)).toEqual(['unknown', 'unknown']);
});

it('diffs builds by source identity, counting memories and naming notes', () => {
  const diff = diffBuilds(
    [
      input({ native: 'kept' }),
      input({ native: 'new', label: 'New note' }),
      input({ native: '2', kind: 'memory', label: null }),
      input({ selection: 'system:v1' }),
    ],
    [
      input({ native: 'kept' }),
      input({ native: 'old', label: 'Old note' }),
      input({ native: '1', kind: 'memory', label: null }),
      input({ native: '0', kind: 'memory', label: null }),
    ],
  );
  expect(diff.addedNotes.map((n) => n.title)).toEqual(['New note']);
  expect(diff.removedNotes.map((n) => n.title)).toEqual(['Old note']);
  expect(diff.addedMemories).toBe(1);
  expect(diff.removedMemories).toBe(2);
  expect([...diff.newKeys]).toEqual(['node:ns:new', 'memory:ns:2']);
});

it('formats times relative to today', () => {
  const now = new Date(2026, 9, 31, 14, 0);
  const at = (d: Date) => d.toISOString();
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const morning = new Date(2026, 9, 31, 5, 26);
  const yesterday = new Date(2026, 9, 30, 5, 45);
  const earlier = new Date(2026, 9, 28, 5, 37);
  const lastYear = new Date(2025, 11, 3, 8, 0);
  expect(friendlyTime(at(morning), now)).toBe(`today ${time(morning)}`);
  expect(friendlyTime(at(yesterday), now)).toBe(`yesterday ${time(yesterday)}`);
  expect(friendlyTime(at(earlier), now)).toBe(
    `${earlier.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(earlier)}`,
  );
  expect(friendlyTime(at(lastYear), now)).toContain('2025');
  expect(friendlyTime('not a date', now)).toBe('not a date');
  expect(friendlyTime(null, now)).toBe('an unknown time');
});

it('reads memory evidence lines and picks the lines that mention a source', () => {
  expect(memoryText('- [fact] Policy needs approval. (id: 1086)')).toEqual({
    kind: 'fact',
    text: 'Policy needs approval.',
  });
  expect(memoryText('- just text')).toEqual({ kind: null, text: 'just text' });
  expect(
    linesMentioning('## SALIENCE\n  - Alpha (score 0.7)\n  - Beta (score 0.5)\n', 'Beta'),
  ).toEqual(['Beta (score 0.5)']);
  expect(linesMentioning('anything', null)).toEqual([]);
});

it('names a dossier\'s selections and keeps its past facts apart from its memories (#554)', () => {
  expect(['dossier-subject:v1', 'dossier-subject-note:v1', 'dossier-body:v1', 'dossier-meeting:v1', 'dossier-note-title:v1',
    'dossier-task:v1', 'dossier-people:v1', 'dossier-memory:v1', 'dossier-rule:v1', 'dossier-past-memory:v1'].map(sourceUse))
    .toEqual(['subject_note', 'subject_note', 'full', 'meeting_list', 'linked_notes', 'task', 'people', 'memory', 'rule', 'past']);
  const groups = groupSources([
    input({ native: 'subject', selection: 'dossier-subject-note:v1', role: 'source_material' }),
    input({ native: 'meeting', selection: 'dossier-body:v1', role: 'source_material' }),
    input({ native: 'listed', selection: 'dossier-meeting:v1' }),
    input({ native: '1', kind: 'memory', selection: 'dossier-memory:v1' }),
    input({ native: '2', kind: 'memory', selection: 'dossier-past-memory:v1' }),
  ], 'page');
  expect(groups.read.map(r => r.source?.native_id)).toEqual(['meeting', 'subject']);
  expect(groups.mentioned.map(r => r.source?.native_id)).toEqual(['listed']);
  expect(groups.memories.map(r => r.source?.native_id)).toEqual(['1']);
  expect(groups.past.map(r => r.source?.native_id)).toEqual(['2']);
  expect(internalInputLabel('dossier-owner:v1')).toBe('Your name, as the vault’s owner');
  // A dossier's memory lines lead with the ref its model cites.
  expect(memoryText('- [m812] [preference] Kickoff call: Prefers mornings.')).toEqual({ kind: 'preference', text: 'Kickoff call: Prefers mornings.' });
  expect(memoryText('- [m9] Don\'t share the pilot price.')).toEqual({ kind: null, text: 'Don\'t share the pilot price.' });
});

it('shows a dossier\'s subject by its note\'s text, not the heading that only names it (#554)', () => {
  const heading = input({ native: 'subject', selection: 'dossier-subject:v1' });
  const note = input({ native: 'subject', selection: 'dossier-subject-note:v1', role: 'source_material' });
  for (const order of [[heading, note], [note, heading]]) {
    const [row] = groupSources(order, 'page').read;
    expect(row!.primary.selection).toBe('dossier-subject-note:v1');
    expect(row!.uses).toEqual(['subject_note']);
  }
});
