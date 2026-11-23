import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAutocomplete } from '../src/composer/ComposerAutocomplete.js';

const ROWS = [
  { key: 'a', label: 'Climate Plan', hint: 'project' },
  { key: 'b', label: 'Task triage', hint: 'task' },
];

describe('ComposerAutocomplete', () => {
  it('renders one option per row with the active row marked', () => {
    const html = renderToStaticMarkup(createElement(ComposerAutocomplete, { sigil: '@', rows: ROWS, active: 1, onPick: () => {} }));
    expect(html).toContain('Climate Plan');
    expect(html).toContain('Task triage');
    expect(html).toContain('project');
    expect(html).toMatch(/data-active="true"[^>]*>[^<]*<[^>]*>Task triage/);
  });
  it('shows the sigil in the menu header', () => {
    const html = renderToStaticMarkup(createElement(ComposerAutocomplete, { sigil: '@', rows: ROWS, active: 0, onPick: () => {} }));
    expect(html).toContain('<b>@</b>');
  });
  it('renders an empty-state note when there are no rows', () => {
    const html = renderToStaticMarkup(createElement(ComposerAutocomplete, { sigil: '@', rows: [], active: 0, onPick: () => {} }));
    expect(html).toContain('No matches');
  });
});

const PREVIEW_ROWS = [{ key: 'n1', label: 'Acme', hint: 'project' }, { key: 'n2', label: 'Beta', hint: 'note' }];

describe('ComposerAutocomplete preview affordance', () => {
  it('renders a preview control per row when onPreview is provided', () => {
    const html = renderToStaticMarkup(
      <ComposerAutocomplete sigil="@" rows={PREVIEW_ROWS} active={0} onPick={() => {}} onPreview={() => {}} />,
    );
    expect((html.match(/composer-item-preview/g) ?? []).length).toBe(2);
  });
  it('omits the preview control when onPreview is absent', () => {
    const html = renderToStaticMarkup(
      <ComposerAutocomplete sigil="@" rows={PREVIEW_ROWS} active={0} onPick={() => {}} />,
    );
    expect(html).not.toContain('composer-item-preview');
  });
});
