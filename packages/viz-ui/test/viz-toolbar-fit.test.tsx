// @vitest-environment jsdom
/**
 * viz-toolbar-fit.test.tsx — #404: the view toolbar stays on one row.
 *
 * jsdom has no layout, so getBoundingClientRect is stubbed: the toolbar is `width` wide and its
 * children need a fixed width per fit level. A ResizeObserver stub lets the test "drag" the pane.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schema, SchemaField } from '@vault/query-core';
import { VizToolbar, type VizToolbarQuery } from '../src/VizToolbar.js';
import { clampToolbarPopovers, nextToolbarFitLevel } from '../src/use-toolbar-fit.js';
import type { VizQueryVM } from '../src/use-viz-query.js';
import type { VizSpec } from '../src/viz-spec.js';

describe('nextToolbarFitLevel', () => {
  it('steps down one level when the content overflows', () => {
    expect(nextToolbarFitLevel(0, 300, 600, [])).toBe(1);
    expect(nextToolbarFitLevel(2, 300, 320, [600, 400])).toBe(3);
  });
  it('stays at the last level even if it still overflows', () => {
    expect(nextToolbarFitLevel(3, 100, 180, [600, 400, 250])).toBe(3);
  });
  it('steps back up only when the fuller level is known to fit (or was never measured)', () => {
    expect(nextToolbarFitLevel(2, 300, 300, [600, 400])).toBe(2);
    expect(nextToolbarFitLevel(2, 450, 450, [600, 400])).toBe(1);
    expect(nextToolbarFitLevel(1, 450, 450, [])).toBe(0);
  });
});

// ---- layout stubs ----

/** Width the toolbar's contents need at each fit level (0 full … 3 tight). */
const NEED = [600, 380, 240, 180];
let width = 1000;
const roCallbacks = new Set<() => void>();

function levelOf(toolbar: Element): number {
  const c = toolbar.classList;
  return c.contains('is-tight') ? 3 : c.contains('is-overflow') ? 2 : c.contains('is-compact') ? 1 : 0;
}

function resizeTo(w: number) {
  width = w;
  act(() => { for (const cb of roCallbacks) cb(); });
}

const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  width = 1000;
  roCallbacks.clear();
  vi.stubGlobal('ResizeObserver', class {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { roCallbacks.add(this.cb); }
    disconnect() { roCallbacks.delete(this.cb); }
    unobserve() {}
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (w: number) => ({ left: 0, top: 0, right: w, bottom: 40, width: w, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    if (this.classList.contains('viz-toolbar')) return rect(width);
    if (this.classList.contains('viz-pop')) {
      // A right-anchored popover hangs leftward from near the toolbar's right edge (Filter is 440px).
      const w = this.classList.contains('viz-filter-pop') ? 440 : 220;
      const right = width - 30;
      return { ...rect(w), left: right - w, right, x: right - w } as DOMRect;
    }
    const parent = this.parentElement;
    if (parent?.classList.contains('viz-toolbar') && this === parent.lastElementChild) {
      // Everything fits → the spacer pushes the last child to the edge; otherwise it sticks out.
      return rect(Math.max(width, NEED[levelOf(parent)]));
    }
    return rect(0);
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
  vi.unstubAllGlobals();
});

// ---- fixtures ----

const FIELD: SchemaField = { name: 'status', type: 'enum', required: false, default_value: null, enum_values: ['open', 'done'], ui: null };
const SCHEMA: Schema = { name: 'task', display_name: null, fields: [FIELD] };

function makeQuery(): VizToolbarQuery {
  const vm = {
    strip: { limit: 50, query: '', title_contains: '', sort_by: undefined, sort_order: undefined },
    lockedType: null,
    chips: [],
    fragments: [],
    setStrip: vi.fn(),
    setTypeLock: vi.fn(),
  } as unknown as VizQueryVM;
  return {
    spec: { kind: 'table', query: { types: ['task'] }, display_fields: [] } as unknown as VizSpec,
    onSpecChange: vi.fn(),
    vm,
    schema: SCHEMA,
    availableTypes: ['task'],
    addableSchemaFields: [],
  };
}

function renderToolbar(onNew = vi.fn()) {
  render(
    <VizToolbar kind="table" onKind={vi.fn()} shown={12} total={300} loading={false} onRefresh={vi.fn()} query={makeQuery()} onNew={onNew} />,
  );
  return { toolbar: screen.getByRole('toolbar', { name: 'View options' }), onNew };
}

describe('VizToolbar fit (#404)', () => {
  it('shows every control with its label when there is room', () => {
    const { toolbar } = renderToolbar();
    expect(levelOf(toolbar)).toBe(0);
    expect(screen.getByRole('button', { name: /^sort$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^filter/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^properties$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^new$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'More view options' })).toBeNull();
  });

  it('drops labels first, keeping the accessible names, then moves controls into ⋯', () => {
    const { toolbar } = renderToolbar();
    resizeTo(500);
    expect(levelOf(toolbar)).toBe(1);
    expect(toolbar.classList.contains('is-compact')).toBe(true);
    expect(screen.getByRole('button', { name: /^sort$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /12 of 300 results/ }).textContent).toContain('12/300');
    expect(screen.queryByRole('button', { name: 'More view options' })).toBeNull();

    resizeTo(300);
    expect(levelOf(toolbar)).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'More view options' }));
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent?.trim());
    expect(items).toEqual(['Sort', 'Filter', 'Properties', 'New']);
  });

  it('opens an overflowed control’s popover from the ⋯ menu', () => {
    const { onNew } = renderToolbar();
    resizeTo(300);
    fireEvent.click(screen.getByRole('button', { name: 'More view options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort' }));
    expect(screen.getByRole('dialog', { name: 'Sort' })).toBeDefined();
    expect(screen.queryByRole('menu', { name: 'More view options' })).toBeNull();

    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'More view options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeDefined();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Properties' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More view options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New' }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('moves the results count into ⋯ at the narrowest width, and restores everything when widened', () => {
    const { toolbar } = renderToolbar();
    resizeTo(200);
    expect(levelOf(toolbar)).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'More view options' }));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent?.trim())).toEqual(['12 of 300 results', 'Sort', 'Filter', 'Properties', 'New']);
    fireEvent.click(screen.getByRole('menuitem', { name: '12 of 300 results' }));
    expect(screen.getByRole('dialog', { name: 'Results' })).toBeDefined();

    resizeTo(1000);
    expect(levelOf(toolbar)).toBe(0);
    expect(screen.queryByRole('button', { name: 'More view options' })).toBeNull();
  });
});

describe('popovers stay inside the toolbar (#404 follow-up)', () => {
  it('caps a popover to the toolbar width and shifts it back inside', () => {
    renderToolbar();
    resizeTo(330);
    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
    const pop = screen.getByRole('dialog', { name: 'Filters' });
    // The stubbed rect ignores inline styles, so the shift is from the unclamped position:
    // left edge at 330 - 30 - 440 = -140, moved to the 4px gutter.
    expect(pop.style.maxWidth).toBe('322px');
    expect(pop.style.transform).toBe('translateX(144px)');
  });

  it('leaves a popover alone when it already fits', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /^sort$/i }));
    const pop = screen.getByRole('dialog', { name: 'Sort' });
    expect(pop.style.transform).toBe('');
    expect(pop.style.maxWidth).toBe('992px');
  });

  it('ignores popovers nested inside another popover', () => {
    const toolbar = document.createElement('div');
    toolbar.className = 'viz-toolbar';
    toolbar.innerHTML = '<div class="viz-tb-wrap"><div class="viz-pop viz-filter-pop"><div class="viz-pop nested"></div></div></div>';
    document.body.appendChild(toolbar);
    width = 330;
    clampToolbarPopovers(toolbar);
    expect((toolbar.querySelector('.viz-filter-pop') as HTMLElement).style.transform).toBe('translateX(144px)');
    expect((toolbar.querySelector('.nested') as HTMLElement).style.transform).toBe('');
    toolbar.remove();
  });
});
