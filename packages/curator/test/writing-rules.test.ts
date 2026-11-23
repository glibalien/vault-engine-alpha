import { describe, expect, it } from 'vitest';
import { WIKI_REWRITE_RULES, WIKI_WRITING_RULES } from '../src/prompts/writing-rules.js';

/** The rewrite rules replace base rules by text; a replace that stops matching would silently
 *  leave the base rule in place, so each one is checked here. */
describe('rewrite rules (#352)', () => {
  const rule = (rules: string, n: number) => rules.split('\n').find(line => line.startsWith(`${n}. `));
  it('carry the current page forward, and change only what the changed notes change', () => {
    expect(rule(WIKI_REWRITE_RULES, 7)).toContain('The current page is the evidence for what it already says');
    expect(rule(WIKI_REWRITE_RULES, 7)).toContain('never drop a section because the CHANGED NOTES say nothing about it');
    expect(rule(WIKI_REWRITE_RULES, 7)).toContain('Page scopes and memories are context, not evidence');
    expect(rule(WIKI_REWRITE_RULES, 11)).toContain('notes the current page already links');
    expect(rule(WIKI_REWRITE_RULES, 12)).toContain('Rewrite the current page as a whole');
    expect(rule(WIKI_REWRITE_RULES, 12)).toContain('Keep every rule on what not to say, share or claim.');
    expect(rule(WIKI_REWRITE_RULES, 13)).toContain('Escape literal dollar signs');
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10]) expect(rule(WIKI_REWRITE_RULES, n)).toBe(rule(WIKI_WRITING_RULES, n));
  });
});
