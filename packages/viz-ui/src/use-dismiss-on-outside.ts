import { useEffect, useRef, type RefObject } from "react";

/**
 * useDismissOnOutside — closes a floating menu when the user clicks outside it.
 *
 * Attaches a `pointerdown` listener on the document while `open` is true.
 * When the event's target is outside `ref.current`, calls `onClose`.
 *
 * @param ref    - ref attached to the menu/trigger container
 * @param open   - whether the menu is currently open
 * @param onClose - callback to close the menu
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, ref]);
}
