import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Toolbar fit levels, cumulative — each level keeps the previous level's changes:
 *   0 full     — icons + labels
 *   1 compact  — labels hidden (kept for screen readers), results count shortened
 *   2 overflow — Sort / Filter / Properties / New move into a ⋯ menu
 *   3 tight    — the results count moves into the ⋯ menu too
 */
export type ToolbarFitLevel = 0 | 1 | 2 | 3;
export const MAX_TOOLBAR_FIT_LEVEL: ToolbarFitLevel = 3;

/** Width the toolbar's in-flow children need: the furthest child right edge plus end padding/border.
 *  Only direct children count, so open popovers (absolutely positioned inside a wrap) never read
 *  as overflow. When everything fits, the flexible spacer pushes this to exactly the toolbar width. */
export function toolbarContentWidth(el: HTMLElement): number {
  const box = el.getBoundingClientRect();
  let right = box.left;
  for (const child of Array.from(el.children)) right = Math.max(right, child.getBoundingClientRect().right);
  const cs = getComputedStyle(el);
  return right - box.left + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderRightWidth) || 0);
}

const POP_GUTTER = 4;

/** Keep the toolbar's open popovers inside the toolbar: cap their width to it and shift them sideways
 *  (translateX) when their anchor would push them past either edge. A narrow pane otherwise cuts
 *  off a right-anchored 440px Filter popover, or a left-anchored Layout menu, at the pane's edge.
 *  Only the toolbar's own popovers move; menus nested inside one move with it. */
export function clampToolbarPopovers(toolbar: HTMLElement): void {
  const pops = toolbar.querySelectorAll<HTMLElement>(':scope > .viz-tb-wrap > .viz-pop, :scope > .col-picker-wrap > .viz-pop');
  if (pops.length === 0) return;
  const tb = toolbar.getBoundingClientRect();
  const room = tb.width - 2 * POP_GUTTER;
  if (room <= 0) return;
  for (const pop of Array.from(pops)) {
    pop.style.transform = '';
    pop.style.minWidth = '';
    pop.style.maxWidth = '';
    const cs = getComputedStyle(pop);
    if ((parseFloat(cs.minWidth) || 0) > room) pop.style.minWidth = `${room}px`;
    const max = parseFloat(cs.maxWidth); // NaN for 'none'
    if (!(max <= room)) pop.style.maxWidth = `${room}px`;
    const r = pop.getBoundingClientRect();
    const dx = r.left < tb.left + POP_GUTTER ? tb.left + POP_GUTTER - r.left
      : r.right > tb.right - POP_GUTTER ? tb.right - POP_GUTTER - r.right
        : 0;
    if (Math.abs(dx) >= 0.5) pop.style.transform = `translateX(${Math.round(dx)}px)`;
  }
}

/** One step of the fit search. `needs[l]` is the width level `l` was measured to need when it
 *  overflowed (undefined = never measured since the content last changed). */
export function nextToolbarFitLevel(level: ToolbarFitLevel, width: number, need: number, needs: (number | undefined)[]): ToolbarFitLevel {
  if (need > width + 0.5) return level < MAX_TOOLBAR_FIT_LEVEL ? ((level + 1) as ToolbarFitLevel) : level;
  if (level > 0) {
    const up = needs[level - 1];
    if (up === undefined || up <= width + 0.5) return (level - 1) as ToolbarFitLevel;
  }
  return level;
}

/**
 * useToolbarFit — keeps a toolbar on one row by picking the least-collapsed level that fits, and
 * keeps its open popovers inside it (clampToolbarPopovers).
 *
 * Re-checks after every render (layout effect, so level changes land before paint) and whenever
 * the toolbar is resized. `contentKey` must change whenever the toolbar's contents change width
 * (results text, search open, which buttons exist); that clears the recorded widths so the hook
 * re-tries the fuller levels instead of trusting stale measurements.
 */
export function useToolbarFit(ref: RefObject<HTMLElement | null>, contentKey: string): ToolbarFitLevel {
  const [level, setLevel] = useState<ToolbarFitLevel>(0);
  const levelRef = useRef(level);
  levelRef.current = level;
  const needs = useRef<(number | undefined)[]>([]);
  const keyRef = useRef(contentKey);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width <= 0) return; // hidden (inactive tab, collapsed card): nothing to measure
    clampToolbarPopovers(el);
    const cur = levelRef.current;
    const need = toolbarContentWidth(el);
    if (need > width + 0.5) needs.current[cur] = need;
    const next = nextToolbarFitLevel(cur, width, need, needs.current);
    if (next !== cur) setLevel(next);
  }, [ref]);

  useLayoutEffect(() => {
    if (keyRef.current !== contentKey) {
      keyRef.current = contentKey;
      needs.current = [];
    }
    fit();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fit]);

  return level;
}
