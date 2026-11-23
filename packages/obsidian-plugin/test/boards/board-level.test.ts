import { describe, it, expect } from 'vitest';
import type { TemplateCard } from '@vault/chat-core';
import { substitute, instantiateTemplateCards } from '../../src/boards/board-level.js';

const HIT = { id: 'p1', title: 'Vault Engine' };

describe('substitute', () => {
  it('replaces {{title}}/{{id}} in nested strings, leaves non-strings untouched, does not mutate input', () => {
    const input = { title: 'Tasks — {{title}}', query: { references: { target: '{{title}}', rel_type: 'project' }, node_ids: ['{{id}}'], limit: 50 }, flag: true };
    const out = substitute(input, HIT) as typeof input;
    expect(out.title).toBe('Tasks — Vault Engine');
    expect(out.query.references.target).toBe('Vault Engine');
    expect(out.query.node_ids).toEqual(['p1']);
    expect(out.query.limit).toBe(50);
    expect(out.flag).toBe(true);
    expect(input.title).toBe('Tasks — {{title}}');
  });
  it('replaces repeated placeholders in one string', () => {
    expect(substitute('{{title}} / {{title}} ({{id}})', HIT)).toBe('Vault Engine / Vault Engine (p1)');
  });
  it('does not interpret $-patterns in the title as replacement syntax', () => {
    const dollarHit = { id: 'p2', title: 'Budget $$ & $& done' };
    expect(substitute('{{title}}', dollarHit)).toBe('Budget $$ & $& done');
    const input = { query: { references: { target: '{{title}}', rel_type: 'project' } } };
    const out = substitute(input, dollarHit) as typeof input;
    expect(out.query.references.target).toBe('Budget $$ & $& done');
  });
});

describe('instantiateTemplateCards', () => {
  it('node templates take the hit identity; viz templates substitute', () => {
    const templates: TemplateCard[] = [
      { kind: 'node' },
      { kind: 'viz', spec: { kind: 'table', title: '{{title}} tasks', query: { references: { target: '{{title}}', rel_type: 'project' } }, display_fields: ['status'] } },
    ];
    const cards = instantiateTemplateCards(templates, HIT);
    expect(cards[0]).toEqual({ kind: 'node', title: 'Vault Engine', node_id: 'p1' });
    expect(cards[1]).toMatchObject({ kind: 'table', title: 'Vault Engine tasks', query: { references: { target: 'Vault Engine' } } });
  });
  it('stats templates instantiate with or without a hit; viz without a hit passes through verbatim', () => {
    expect(instantiateTemplateCards([{ kind: 'stats' }], HIT)).toEqual([{ kind: 'stats', title: 'Vault stats' }]);
    expect(instantiateTemplateCards([{ kind: 'stats', title: 'Health' }])).toEqual([{ kind: 'stats', title: 'Health' }]);
    const viz = { kind: 'viz' as const, spec: { kind: 'table', title: 'Overdue', query: { types: ['task'] }, display_fields: ['due'] } };
    expect(instantiateTemplateCards([viz])).toEqual([viz.spec]);
  });
  it('node templates throw without a hit (sanitize prevents this upstream)', () => {
    expect(() => instantiateTemplateCards([{ kind: 'node' }])).toThrow(/target note/);
  });
});
