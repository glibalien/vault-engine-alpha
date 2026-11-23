import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message } from '../src/index.js';
import type { ChatUIMessage } from '../src/index.js';

function assistantText(text: string): ChatUIMessage {
  return { id: 'm1', role: 'assistant', parts: [{ type: 'text', text }] };
}

describe('Message markdown', () => {
  it('renders GFM tables as <table>, not collapsed prose', () => {
    const md = '| # | Title |\n|---|-------|\n| 1 | Buy milk |\n| 2 | Walk dog |';
    const html = renderToStaticMarkup(createElement(Message, { message: assistantText(md) }));
    expect(html).toContain('<table>');
    expect(html).toContain('<td>Buy milk</td>');
  });

  it('still renders plain markdown', () => {
    const html = renderToStaticMarkup(createElement(Message, { message: assistantText('**40 open tasks**') }));
    expect(html).toContain('<strong>40 open tasks</strong>');
  });

  describe('URL sanitization', () => {
    it('strips javascript: scheme from markdown links (XSS prevention)', () => {
      const html = renderToStaticMarkup(
        createElement(Message, { message: assistantText('[click me](javascript:alert(1))') }),
      );
      expect(html).not.toMatch(/href="javascript:/);
    });

    it('strips data: scheme from markdown links', () => {
      const html = renderToStaticMarkup(
        createElement(Message, { message: assistantText('[x](data:text/html,<script>alert(1)</script>)') }),
      );
      expect(html).not.toMatch(/href="data:/);
    });

    it('preserves https:// links', () => {
      const html = renderToStaticMarkup(
        createElement(Message, { message: assistantText('[site](https://example.com)') }),
      );
      expect(html).toContain('href="https://example.com"');
    });

    it('renders [[Note Title]] as a .wl-ref button when onOpenPreview is provided', () => {
      const opened: string[] = [];
      const html = renderToStaticMarkup(
        createElement(Message, {
          message: assistantText('[[Note Title]]'),
          onOpenPreview: (ref) => opened.push(ref.title),
        }),
      );
      expect(html).toContain('class="wl-ref"');
      expect(html).not.toContain('href="vault://');
    });
  });
});
