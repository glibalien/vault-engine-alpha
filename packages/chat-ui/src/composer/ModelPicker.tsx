import { useEffect, useState } from 'react';

/** chat-ui's own item shape — plain props, NO @vault/settings-registry dependency. */
export interface ModelPickerItem {
  title: string;
  provider: string;        // group label ('fireworks' | 'anthropic' today; data-driven)
  available: boolean;      // false → greyed, "key not configured"
  unpriced?: boolean;      // true → "unpriced" badge
}

export interface ModelPickerProps {
  items: ModelPickerItem[];
  selected: string | null;     // catalog title, or null = surface default
  defaultTitle: string;        // shown on the chip when selected === null, and in the Default row
  onSelect: (title: string | null) => void;   // null = clear back to default
}

export function ModelPicker({ items, selected, defaultTitle, onSelect }: ModelPickerProps) {
  const [open, setOpen] = useState(false);

  // Close on an outside click (mirrors ConversationSwitcher's ⋯ menu) and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest('.model-menu, .model-chip')) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setOpen(false); return; }
      // Any other keydown outside the menu = the user resumed typing (focus stays in
      // the textarea via the rows' mousedown preventDefault). Close, so this menu can't
      // stack with the composer's typed '@' autocomplete.
      if (!(e.target as HTMLElement | null)?.closest('.model-menu')) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Group by provider, preserving the order providers first appear in `items`.
  const groups: Array<{ provider: string; items: ModelPickerItem[] }> = [];
  for (const item of items) {
    let g = groups.find((g) => g.provider === item.provider);
    if (!g) { g = { provider: item.provider, items: [] }; groups.push(g); }
    g.items.push(item);
  }

  const pick = (title: string | null) => {
    onSelect(title);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className={`ctx-chip model-chip${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ?? defaultTitle}
      </button>
      {open && (
        <div className="model-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected === null}
            // mousedown (not click) fires before the textarea blurs, keeping focus.
            onMouseDown={(e) => { e.preventDefault(); pick(null); }}
          >
            Default — {defaultTitle}
          </button>
          {groups.map((g) => (
            <div key={g.provider}>
              <div className="model-menu-group">{g.provider}</div>
              {g.items.map((it) => (
                <button
                  key={it.title}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected === it.title}
                  disabled={!it.available}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!it.available) return;
                    pick(it.title);
                  }}
                >
                  {it.title}
                  {!it.available && <span className="model-hint">key not configured</span>}
                  {it.unpriced && <span className="model-badge">unpriced</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
