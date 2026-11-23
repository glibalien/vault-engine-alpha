import { useState, useRef } from "react";
import { useDismissOnOutside } from "./use-dismiss-on-outside.js";

/** Dropdown chip showing the current type lock.
 *  When lockedType is null, renders "Mixed results" (unlocked state).
 *  Clicking the chip toggles an inline menu listing availableTypes + an unlock option. */
export function TypeLockChip({
  lockedType,
  availableTypes,
  counts,
  onPick,
  onUnlock,
}: {
  lockedType: string | null;
  availableTypes: string[];
  counts?: Record<string, number>;
  onPick: (type: string) => void;
  onUnlock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(wrapRef, open, () => setOpen(false));

  // Mirror the engine chip-strip logic: always include the locked type in the menu.
  const menuTypes =
    lockedType !== null
      ? Array.from(new Set([lockedType, ...availableTypes]))
      : availableTypes;

  function handlePick(type: string) {
    setOpen(false);
    onPick(type);
  }

  function handleUnlock() {
    setOpen(false);
    onUnlock();
  }

  return (
    <div className="typelock-wrap" ref={wrapRef}>
      <button
        className="typelock-chip"
        aria-label="type lock"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="typelock-k">type:</span>{" "}
        <span className="typelock-v">
          {lockedType !== null ? lockedType : "Mixed results"}
        </span>
        <span className="typelock-caret">▾</span>
      </button>

      {open && (
        <div className="typelock-menu" role="menu">
          {menuTypes.map((tn) => (
            <button
              key={tn}
              className="typelock-mi"
              role="menuitemradio"
              aria-checked={tn === lockedType}
              onClick={() => handlePick(tn)}
            >
              {tn}{counts?.[tn] != null ? <span className="typelock-count"> ({counts[tn]})</span> : null}
            </button>
          ))}
          <hr className="typelock-sep" />
          <button
            className="typelock-mi typelock-unlock"
            role="menuitem"
            onClick={handleUnlock}
          >
            Unlock type
          </button>
        </div>
      )}
    </div>
  );
}
