import { describe, expect, it } from 'vitest';
import { wikilinksToMarkdownLinks, parseVaultHref } from '../src/index.js';

describe('wikilinksToMarkdownLinks', () => {
  it('converts a wikilink to a vault:// markdown link', () => {
    expect(wikilinksToMarkdownLinks('see [[Climate Plan]] today')).toBe('see [Climate Plan](vault://node/Climate%20Plan) today');
  });
  it('leaves text without wikilinks unchanged', () => {
    expect(wikilinksToMarkdownLinks('no links here')).toBe('no links here');
  });
  it('handles multiple wikilinks', () => {
    expect(wikilinksToMarkdownLinks('[[A]] and [[B]]')).toBe('[A](vault://node/A) and [B](vault://node/B)');
  });
  it('does not convert [[Foo]] inside an inline code span', () => {
    expect(wikilinksToMarkdownLinks('`[[Foo]]`')).toBe('`[[Foo]]`');
  });
  it('does not convert [[Bar]] inside a fenced code block', () => {
    const input = '```\nsome code [[Bar]] here\n```';
    expect(wikilinksToMarkdownLinks(input)).toBe(input);
  });
  it('converts wikilinks in plain text but not in adjacent code', () => {
    const input = 'see [[Baz]] and `[[Skip]]` and [[Also]]';
    expect(wikilinksToMarkdownLinks(input)).toBe(
      'see [Baz](vault://node/Baz) and `[[Skip]]` and [Also](vault://node/Also)'
    );
  });
  it('handles mixed fenced block + plain text with wikilinks', () => {
    const input = '[[Before]]\n```\n[[Inside]]\n```\n[[After]]';
    expect(wikilinksToMarkdownLinks(input)).toBe(
      '[Before](vault://node/Before)\n```\n[[Inside]]\n```\n[After](vault://node/After)'
    );
  });
});

describe('parseVaultHref', () => {
  it('decodes a vault node href to a title', () => {
    expect(parseVaultHref('vault://node/Climate%20Plan')).toBe('Climate Plan');
  });
  it('returns null for non-vault hrefs', () => {
    expect(parseVaultHref('https://example.com')).toBeNull();
    expect(parseVaultHref(undefined as unknown as string)).toBeNull();
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message } from '../src/index.js';

it('Message renders a chat wikilink as a clickable wl-ref button', () => {
  const msg = { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'see [[Climate Plan]]' }] } as never;
  const html = renderToStaticMarkup(createElement(Message, { message: msg, onOpenPreview: () => {} }));
  expect(html).toMatch(/<button[^>]*class="wl-ref"[^>]*>Climate Plan<\/button>/);
});
