import type { ComposerSigil } from './composer-trigger.js';

export interface AutocompleteRow {
  key: string;
  label: string;
  hint?: string;
}

export function ComposerAutocomplete({ sigil, rows, active, onPick, onPreview }: {
  sigil: ComposerSigil;
  rows: AutocompleteRow[];
  active: number;
  onPick: (index: number) => void;
  onPreview?: (index: number) => void;
}) {
  return (
    <div className="composer-menu" role="listbox">
      <div className="composer-menu-head"><b>{sigil}</b></div>
      {rows.length === 0 ? (
        <div className="empty">No matches</div>
      ) : (
        rows.map((r, i) => (
          <div className="composer-item-row" key={r.key}>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active ? 'true' : 'false'}
              className="composer-item"
              // mousedown (not click) fires before the textarea blurs, keeping focus.
              onMouseDown={(e) => { e.preventDefault(); onPick(i); }}
            >
              <span className="composer-item-label">{r.label}</span>
              {r.hint && <span className="composer-item-hint">{r.hint}</span>}
            </button>
            {onPreview && (
              <button
                type="button"
                className="composer-item-preview"
                title="preview"
                aria-label={`Preview ${r.label}`}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPreview(i); }}
              >
                ⤢
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
