import { describe, expect, it } from 'vitest';
import { assertWikiSectionStructure } from '../../src/wiki/section-integrity.js';
import { mergeManagedSections } from '../../src/wiki/sections.js';

describe('mergeManagedSections', () => {
  it.each([
    '<!-- ve:managed:Summary -->\n<!-- ve:managed:Summary -->\nold\n<!-- /ve:managed:Summary -->\n<!-- /ve:managed:Summary -->',
    '<!-- ve:managed:Summary -->\nold\n<!-- /ve:managed:Summary -->\n<!-- /ve:managed:Summary -->',
    '<!-- ve:managed:Summary -->\nold',
    '<!-- ve:managed:Summary -->old<!-- /ve:managed:Log -->',
    '<!-- ve:managed:Summary -->one<!-- /ve:managed:Summary --><!-- ve:managed:Summary -->two<!-- /ve:managed:Summary -->',
  ])('refuses ambiguous existing boundaries instead of leaving stale content: %s', body => {
    expect(() => mergeManagedSections(body, { live: {}, managed: [
      { name: 'Summary', mode: 'replace', content: 'New narrative' },
    ] })).toThrow(/wiki section/i);
  });

  it.each([' Summary', '\tSummary', '\u00a0Summary'])('rejects leading padding in existing marker names upfront: %j', name => {
    const body = `<!-- ve:managed:${name} -->Old<!-- /ve:managed:${name} -->`;
    expect(() => assertWikiSectionStructure(body)).toThrow(/padded marker name/);
    expect(() => mergeManagedSections(body, { live: {}, managed: [
      { name: 'Summary', mode: 'replace', content: 'New' },
    ] })).toThrow(/padded marker name/);
  });

  it.each([
    { separator: '\n', historical: '    const old = true;', ending: '\n' },
    { separator: '\r\n', historical: '\tcode\r\n    more code', ending: '\r\n' },
    { separator: '', historical: '    inline boundary code', ending: '' },
    { separator: '\n', historical: 'Hard break  \n    continuation', ending: '\n\n  ' },
  ])('preserves historical indentation and hard breaks when appending: $historical', ({ separator, historical, ending }) => {
    const body = `<!-- ve:managed:Log -->${separator}${historical}${ending}<!-- /ve:managed:Log -->`;
    const result = mergeManagedSections(body, { live: {}, managed: [
      { name: 'Log', mode: 'append', content: 'New entry' },
    ] });
    expect(result.body).toBe(`<!-- ve:managed:Log -->\n${historical}\n\nNew entry\n<!-- /ve:managed:Log -->`);
  });

  it.each(['<!-- ve:managed:Summary -->nested<!-- /ve:managed:Summary -->', '<!-- /ve:managed:Summary -->', '<!-- ve:live:tasks -->'])('rejects section content supplying reserved markers: %s', content => {
    expect(() => mergeManagedSections('', { live: {}, managed: [
      { name: 'Summary', mode: 'replace', content },
    ] })).toThrow(/wiki section/i);
  });

  it.each([' Summary', 'Summary ', '\tSummary', 'Summary\t', '\u00a0Summary'])('rejects surrounding whitespace in incoming section names: %j', name => {
    expect(() => mergeManagedSections('', { live: {}, managed: [
      { name, mode: 'replace', content: 'Narrative' },
    ] })).toThrow(/invalid section name/);
    expect(() => mergeManagedSections('', { live: { [name]: 'Appendix' }, managed: [] }))
      .toThrow(/invalid section name/);
  });

  it('preserves literal replacement metacharacters and Markdown newlines', () => {
    const body = 'Intro\n<!-- ve:managed:Summary -->old<!-- /ve:managed:Summary -->\nOutro';
    const content = '# Budget\n\n- $100\n- $&\n- $`\n- $\'\n- $$';
    expect(mergeManagedSections(body, { live: {}, managed: [
      { name: 'Summary', mode: 'replace', content },
    ] }).body).toBe(`Intro\n<!-- ve:managed:Summary -->\n${content}\n<!-- /ve:managed:Summary -->\nOutro`);
  });

  it.each([
    ['<!-- ve:managed:Log -->', '<!-- /ve:managed:Log-->'],
    ['<!--ve:managed:Log-->', '<!--/ve:managed:Log -->'],
    ['<!--  ve:managed:Log \t-->', '<!-- \t/ve:managed:Log\n-->'],
  ])('appends using accepted marker whitespace: %s %s', (open, close) => {
    const body = `Owner intro\n${open}\nOld $& entry\n${close}\nOwner outro`;
    expect(mergeManagedSections(body, { live: {}, managed: [
      { name: 'Log', mode: 'append', content: 'New entry' },
    ] }).body).toBe('Owner intro\n<!-- ve:managed:Log -->\nOld $& entry\n\nNew entry\n<!-- /ve:managed:Log -->\nOwner outro');
  });

  it('replaces live sections while preserving human text', () => {
    const body = [
      'Human intro',
      '<!-- ve:live:tasks -->',
      'old',
      '<!-- /ve:live:tasks -->',
      'Human outro',
    ].join('\n');
    const result = mergeManagedSections(body, { live: { tasks: 'new' }, managed: [] });
    expect(result.body).toContain('Human intro');
    expect(result.body).toContain('Human outro');
    expect(result.body).toContain('<!-- ve:live:tasks -->\nnew\n<!-- /ve:live:tasks -->');
    expect(result.body).not.toContain('old');
  });

  it('replaces managed sections and appends Log entries', () => {
    const body = [
      '<!-- ve:managed:Now -->',
      'old now',
      '<!-- /ve:managed:Now -->',
      '<!-- ve:managed:Log -->',
      'first',
      '<!-- /ve:managed:Log -->',
    ].join('\n');
    const result = mergeManagedSections(body, {
      live: {},
      managed: [
        { name: 'Now', mode: 'replace', content: 'new now' },
        { name: 'Log', mode: 'append', content: 'second' },
      ],
    });
    expect(result.body).toContain('new now');
    expect(result.body).not.toContain('old now');
    expect(result.body).toContain('first\n\nsecond');
  });

  it('inserts missing blocks deterministically and is idempotent for replace sections', () => {
    const first = mergeManagedSections('Intro', {
      live: { tasks: '- [[Task]]' },
      managed: [{ name: 'Now', mode: 'replace', content: 'Snapshot' }],
    });
    const second = mergeManagedSections(first.body, {
      live: { tasks: '- [[Task]]' },
      managed: [{ name: 'Now', mode: 'replace', content: 'Snapshot' }],
    });
    expect(second.body).toBe(first.body);
    expect(first.created).toEqual(['managed:Now', 'live:tasks']);
  });

  it('inserts newly managed narrative sections before existing live appendices', () => {
    const body = [
      '<!-- ve:managed:Now -->',
      'Old',
      '<!-- /ve:managed:Now -->',
      '',
      '<!-- ve:live:tasks -->',
      'Tasks',
      '<!-- /ve:live:tasks -->',
      '',
      '<!-- ve:live:related -->',
      'Related',
      '<!-- /ve:live:related -->',
      '',
      '<!-- ve:managed:Log -->',
      'Old log',
      '<!-- /ve:managed:Log -->',
    ].join('\n');

    const result = mergeManagedSections(body, {
      live: { tasks: 'Tasks', related: 'Related' },
      managed: [
        { name: 'Focus', mode: 'replace', content: 'Focus' },
        { name: 'Open threads', mode: 'replace', content: 'Open' },
      ],
    });

    // Narrative brief (Now, Focus, Open threads) strictly precedes live
    // appendices; Log stays at the bottom as the journal.
    expect(result.body.indexOf('ve:managed:Now')).toBeLessThan(result.body.indexOf('ve:managed:Focus'));
    expect(result.body.indexOf('ve:managed:Focus')).toBeLessThan(result.body.indexOf('ve:managed:Open threads'));
    expect(result.body.indexOf('ve:managed:Open threads')).toBeLessThan(result.body.indexOf('ve:live:tasks'));
    expect(result.body.indexOf('ve:live:tasks')).toBeLessThan(result.body.indexOf('ve:live:related'));
    expect(result.body.indexOf('ve:live:related')).toBeLessThan(result.body.indexOf('ve:managed:Log'));
  });

  it('places a managed Summary above a live appendix on a fresh sub-page', () => {
    const result = mergeManagedSections('', {
      live: { contacts: '- [[Alice]]' },
      managed: [{ name: 'Summary', mode: 'replace', content: 'Why these contacts matter.' }],
    });
    expect(result.body.indexOf('ve:managed:Summary')).toBeLessThan(result.body.indexOf('ve:live:contacts'));
  });

  it('orders a new "At a glance" managed section at the very top', () => {
    // Start from a body that already has Now + Log, then add At a glance.
    const first = mergeManagedSections('', { live: {}, managed: [
      { name: 'Now', mode: 'replace', content: 'now text' },
      { name: 'Log', mode: 'append', content: 'log text' },
    ]}).body;
    const out = mergeManagedSections(first, { live: {}, managed: [
      { name: 'At a glance', mode: 'replace', content: 'glance text' },
    ]});
    const body = out.body;
    expect(body.indexOf('ve:managed:At a glance')).toBeGreaterThanOrEqual(0);
    // At a glance must come before Now and before Log
    expect(body.indexOf('ve:managed:At a glance')).toBeLessThan(body.indexOf('ve:managed:Now'));
    expect(body.indexOf('ve:managed:At a glance')).toBeLessThan(body.indexOf('ve:managed:Log'));
  });
});
