import type { PointerEvent as ReactPointerEvent } from 'react';

const MIN_COLUMN_WIDTH = 90;
const MAX_COLUMN_WIDTH = 520;

/** Clamp a resizable presentation column width to the supported pixel range. */
export function clampColumnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

/**
 * Drive a column resize without rerendering on every pointer move. The caller
 * applies the live width to its column element and persists the final value.
 */
export function startColumnResize(
  event: ReactPointerEvent<HTMLElement>,
  widthSource: HTMLElement,
  applyLiveWidth: (width: number) => void,
  commitWidth: (width: number) => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
  const startWidth = widthSource.offsetWidth;
  const pointerId = event.pointerId;
  const widthAt = (clientX: number) => clampColumnWidth(startWidth + ((Number.isFinite(clientX) ? clientX : startX) - startX));
  const isActivePointer = (pointerEvent: PointerEvent): boolean => pointerEvent.pointerId === pointerId;
  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onMove = (moveEvent: PointerEvent) => {
    if (isActivePointer(moveEvent)) applyLiveWidth(widthAt(moveEvent.clientX));
  };
  const onUp = (upEvent: PointerEvent) => {
    if (!isActivePointer(upEvent)) return;
    cleanup();
    commitWidth(widthAt(upEvent.clientX));
  };
  const onCancel = (cancelEvent: PointerEvent) => {
    if (!isActivePointer(cancelEvent)) return;
    applyLiveWidth(startWidth);
    cleanup();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
