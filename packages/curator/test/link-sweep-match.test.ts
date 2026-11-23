import { describe, expect, it } from 'vitest';
import { buildNameIndex, findMentions, proseRanges, type LinkTarget } from '../src/link-sweep-match.js';

// #332: deterministic mention finding for the link sweep. Names are made up.

const TARGETS: LinkTarget[] = [
  { id: 'acme', title: 'Acme', aliases: ['Acme Corp'] },
  { id: 'sam', title: 'Sam Rivera', aliases: ['Samantha Rivera'] },
  { id: 'alpha', title: 'Project Alpha', aliases: [] },
  { id: 'northwind', title: 'Northwind Traders', aliases: ['NWT'] },
  { id: 'q3', title: 'Q3', aliases: [] },                     // too short
  { id: 'jo1', title: 'Jo Park', aliases: ['Jordan'] },
  { id: 'jo2', title: 'Jordan Lee', aliases: ['Jordan'] },     // "Jordan" is ambiguous
  { id: 'date', title: '2026-11-16', aliases: [] },            // a date, never a name
];
const index = buildNameIndex(TARGETS);
const none = { selfId: 'note', linkedIds: new Set<string>() };
const names = (body: string, opts = none) => findMentions(body, index, opts).map(m => `${m.title}=${m.text}`);

describe('buildNameIndex', () => {
  it('leaves out short, date-like and ambiguous names', () => {
    expect(index.ambiguous).toEqual(['Jordan']);
    expect(index.names.has('q3')).toBe(false);
    expect(index.names.has('2026-11-16')).toBe(false);
    expect(index.names.has('nwt')).toBe(true);
  });
});

describe('findMentions', () => {
  it('finds titles and aliases as whole words, longest name first', () => {
    expect(names('Met Sam Rivera from Acme Corp about Project Alpha.'))
      .toEqual(['Sam Rivera=Sam Rivera', 'Acme=Acme Corp', 'Project Alpha=Project Alpha']);
    expect(names('Acme\'s plan; Northwind  Traders\nagreed.')).toEqual(['Acme=Acme', 'Northwind Traders=Northwind  Traders']);
  });

  it('matches a one-word name only in its own case, a longer name in any case', () => {
    expect(names('acme and ACME are words here; nwt too')).toEqual([]);
    expect(names('NWT and project alpha')).toEqual(['Northwind Traders=NWT', 'Project Alpha=project alpha']);
  });

  it('needs whole words', () => {
    expect(names('Acmeville and SuperAcme and Acme_x')).toEqual([]);
  });

  it('keeps only the first mention of each target', () => {
    const mentions = findMentions('Acme met Acme again.', index, none);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ targetId: 'acme', start: 0, end: 4 });
  });

  it('skips ambiguous and too-short names, the note itself and targets it already links to', () => {
    expect(names('Jordan said Q3 is fine.')).toEqual([]);
    expect(names('Acme and Sam Rivera', { selfId: 'acme', linkedIds: new Set(['sam']) })).toEqual([]);
  });

  it('leaves code, links, URLs, comments, tags, headings and tables alone', () => {
    const body = [
      '# Acme kickoff',
      'See [[Acme]] and [Acme site](https://acme.example/Acme) or <https://x.example/Acme>.',
      'Run `Acme` locally; https://example.com/Project%20Alpha',
      '```',
      'Acme in a code block',
      '```',
      '<!-- Acme in a comment --> %% Acme %% #Acme',
      '| Company | Contact |',
      '| --- | --- |',
      '| Acme | Sam Rivera |',
      '',
      'Then Project Alpha shipped.',
    ].join('\n');
    expect(names(body)).toEqual(['Project Alpha=Project Alpha']);
  });

  it('never matches a shorter name inside an ambiguous longer one (Codex on #624)', () => {
    const shadowed = buildNameIndex([
      { id: 'acme', title: 'Acme', aliases: [] },
      { id: 'x', title: 'Acme Corp Holdings', aliases: ['Acme Corp'] },
      { id: 'y', title: 'Acme Corp Labs', aliases: ['Acme Corp'] },
    ]);
    expect(findMentions('Met Acme Corp yesterday.', shadowed, none)).toEqual([]);
    expect(findMentions('Met Acme Corp, then Acme.', shadowed, none).map(m => m.text)).toEqual(['Acme']);
  });

  it('closes a fence only with one at least as long (Codex on #624)', () => {
    const body = ['````md', 'Example:', '```', 'Acme inside the example', '```', '````', 'Then Acme outside.'].join('\n');
    const mentions = findMentions(body, index, none);
    expect(mentions).toHaveLength(1);
    expect(body.slice(0, mentions[0]!.start)).toContain('````\nThen ');
    expect(names('~~~\nAcme\n~~~~\nSam Rivera')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(names('```\nAcme\n``` not a close\nSam Rivera')).toEqual([]);
  });

  it('protects whole inline code spans, any backtick count, across lines (Codex on #624)', () => {
    expect(names('Run ``first ` second Acme`` now.')).toEqual([]);
    expect(names('Run `first\nsecond Acme` now, then Sam Rivera.')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(names('A lone ` backtick, then Acme.')).toEqual(['Acme=Acme']);
    expect(names('`open\n\nAcme after a blank line')).toEqual(['Acme=Acme']);
  });

  it('leaves reference-style links and their definitions alone (Codex on #624)', () => {
    const defs = '\n\n[site]: https://example.com\n[acme]: https://acme.example';
    expect(names(`See [Acme][site] and [Acme Corp][] here.${defs}`)).toEqual([]);
    expect(names(`Shortcut [Acme] link.${defs}`)).toEqual([]);
    expect(names('Brackets [Acme] with no definition.')).toEqual(['Acme=Acme']);
  });

  it('reads code, tables and headings as Markdown does (Codex on #624)', () => {
    expect(names('Example:\n\n    Acme.run()\n\nThen Sam Rivera.')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(names('- item\n\n    Acme stays list text')).toEqual(['Acme=Acme']);
    expect(names('Company | Status\n--- | ---\nAcme | Active\n\nAfter: Sam Rivera')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(names('Acme Corp plans\n===\n\nbody')).toEqual([]);
    expect(names('<div>Acme</div>\n\nand Sam Rivera')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(names('**Acme** and _Sam Rivera_')).toEqual(['Acme=Acme', 'Sam Rivera=Sam Rivera']);
  });

  it('treats an unclosed code fence as running to the end', () => {
    expect(names('Intro.\n```\nAcme stays inside')).toEqual([]);
    expect(proseRanges('a\n```\nb')).toEqual([[0, 1]]);
  });

  it('gives a short excerpt for the journal', () => {
    const [m] = findMentions(`${'x '.repeat(40)}we met Acme Corp today${' y'.repeat(40)}`, index, none);
    expect(m!.context.startsWith('…')).toBe(true);
    expect(m!.context).toContain('we met Acme Corp today');
    expect(m!.context.length).toBeLessThan(90);
  });

  it('flattens link syntax in the excerpt, so the journal links nothing', () => {
    const [m] = findMentions('See [[Weekly sync|the sync]] and [[Budget]]: Acme Corp agreed.', index, none);
    expect(m!.context).toBe('…the sync and Budget: Acme Corp agreed.');
    const [cut] = findMentions(`${'z'.repeat(20)}[[Some Long Note Title]] then Acme`, index, none);
    expect(cut!.context).not.toMatch(/\[\[|\]\]/);
  });

  it('finds nothing without targets', () => {
    expect(findMentions('Acme', buildNameIndex([]), none)).toEqual([]);
  });
});

describe('people and longer names (#332 tightening)', () => {
  const people: LinkTarget[] = [
    { id: 'sam', title: 'Sam Rivera', aliases: ['Sam', 'S. Rivera'], person: true },
    { id: 'kim', title: 'Kim', aliases: [], person: true },
    { id: 'acme', title: 'Acme', aliases: [] },
    { id: 'dana-person', title: 'Dana Fox', aliases: ['Dana'], person: true },
    { id: 'dana-co', title: 'Dana', aliases: [] },
  ];
  const peopleIndex = buildNameIndex(people);
  const found = (body: string) => findMentions(body, peopleIndex, none).map(m => `${m.title}=${m.text}`);

  it('matches a person only by a name of two or more words', () => {
    expect(found('Sam said Kim agreed.')).toEqual([]);
    expect(found('Sam Rivera said so.')).toEqual(['Sam Rivera=Sam Rivera']);
    expect(found('Per S. Rivera, yes.')).toEqual(['Sam Rivera=S. Rivera']);
  });

  it("keeps a person's first name ambiguous with a note of that name, so neither matches", () => {
    expect(peopleIndex.ambiguous).toContain('Dana');
    expect(found('Dana sent it.')).toEqual([]);
  });

  it('leaves a mention followed by another capitalized word, and takes a later plain one', () => {
    expect(found('Acme Cloud is down.')).toEqual([]);
    expect(found('Sam Rivera Jones joined.')).toEqual([]);
    expect(found('Acme Cloud is down, so Acme called.')).toEqual(['Acme=Acme']);
    expect(found('Acme.\nNext Acme, then Acme-wide.')).toEqual(['Acme=Acme']);
  });

  it('still matches before a lowercase word, punctuation or a line break', () => {
    expect(found('Acme said')).toEqual(['Acme=Acme']);
    expect(found('Sam Rivera, Acme\nThen more')).toEqual(['Sam Rivera=Sam Rivera', 'Acme=Acme']);
  });
});
