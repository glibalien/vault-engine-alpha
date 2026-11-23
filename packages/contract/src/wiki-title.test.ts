import { describe, expect, it } from 'vitest';
import { isValidWikiPageTitle, WIKI_TITLE_FORBIDDEN_CHARACTERS, wikiPageTitlePrefix, wikiTitleKey } from './wiki-title.js';

describe('isValidWikiPageTitle', () => {
  it('accepts an ordinary page title', () => {
    expect(isValidWikiPageTitle('Acme — Risks')).toBe(true);
    expect(isValidWikiPageTitle('Northwind — Q3 launch, part 2')).toBe(true);
  });

  it('refuses every listed character', () => {
    for (const ch of WIKI_TITLE_FORBIDDEN_CHARACTERS.split(' ')) {
      expect(isValidWikiPageTitle(`Acme ${ch} Risks`), ch).toBe(false);
    }
  });

  it('refuses control characters, untrimmed and empty titles, and . and ..', () => {
    for (const title of ['Acme\tRisks', 'Acme\nRisks', ' Acme', 'Acme ', '', '.', '..']) {
      expect(isValidWikiPageTitle(title), JSON.stringify(title)).toBe(false);
    }
  });
});

describe('wikiTitleKey', () => {
  it('compares titles ignoring case and Unicode normalization', () => {
    expect(wikiTitleKey('Acme — RISKS')).toBe(wikiTitleKey('acme — risks'));
    expect(wikiTitleKey('Café')).toBe(wikiTitleKey('Café'));
  });
});

describe('wikiPageTitlePrefix', () => {
  it('is the root title and an em dash', () => {
    expect(wikiPageTitlePrefix('Project Alpha')).toBe('Project Alpha — ');
  });

  it('turns forbidden characters into spaces, so the pages get valid titles', () => {
    expect(wikiPageTitlePrefix('Acme (Pilot)')).toBe('Acme Pilot — ');
    expect(wikiPageTitlePrefix('Q3: Launch / Rollout')).toBe('Q3 Launch Rollout — ');
    expect(isValidWikiPageTitle(`${wikiPageTitlePrefix('Acme (Pilot)')}Risks`)).toBe(true);
  });

  it('is empty when nothing of the root title is left', () => {
    expect(wikiPageTitlePrefix('(?)')).toBe('');
  });
});
