import { describe, expect, it } from 'vitest';
import { withoutWikiLinks } from './wiki-links.js';

describe('withoutWikiLinks', () => {
  it('reads a link as the words it shows', () => {
    expect(withoutWikiLinks('Met [[Dana Whitfield]] and [[Acme Corp|Acme]] today.')).toBe('Met Dana Whitfield and Acme today.');
  });

  it('gives the same text before and after a link is added around a name', () => {
    expect(withoutWikiLinks('Call with Dana Whitfield about Acme')).toBe(withoutWikiLinks('Call with [[Dana Whitfield]] about [[Acme Inc|Acme]]'));
  });

  it('reads a table cell link with its escaped separator', () => {
    expect(withoutWikiLinks('| [[Acme Inc\\|Acme]] | x |')).toBe('| Acme | x |');
  });

  it('leaves embeds as written', () => {
    expect(withoutWikiLinks('See ![[diagram.png]] and ![[Note|alt]]')).toBe('See ![[diagram.png]] and ![[Note|alt]]');
  });

  it('keeps a heading link readable and an empty display as its target', () => {
    expect(withoutWikiLinks('[[Note#Plan]] [[Note|]]')).toBe('Note#Plan Note');
  });

  it('still sees a change to the shown words', () => {
    expect(withoutWikiLinks('[[Acme Inc|Acme]]')).not.toBe(withoutWikiLinks('[[Acme Inc]]'));
  });
});
