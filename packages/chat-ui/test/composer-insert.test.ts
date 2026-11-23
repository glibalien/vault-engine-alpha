import { describe, expect, it } from 'vitest';
import { applyNodePick } from '../src/composer/composer-insert.js';

describe('composer-insert', () => {
  it('applyNodePick replaces the trigger with a wikilink + trailing space', () => {
    expect(applyNodePick('see @pro now', { sigil: '@', from: 4, to: 8, query: 'pro' }, 'Project X'))
      .toEqual({ text: 'see [[Project X]]  now', caret: 18 });
  });
});
