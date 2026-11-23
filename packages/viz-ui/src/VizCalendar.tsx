import { useState } from 'react';
import type { VizRow } from './viz-spec.js';
import type { PreviewRef } from './preview-ref.js';
import { monthMatrix, calendarItems, calendarZone, dayKeyInZone, hiddenPerDay, layoutWeek } from './calendar-grid.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Lanes shown per week row: a day shows at most this many items, then "+N more". */
const MAX_PER_DAY = 3;

/**
 * A month grid. Each item is a bar over the days it covers, from its `dateField` day to its
 * `endField` day (its start day only without one); a bar crossing weeks continues on the next row.
 * Days are taken in `timeZone` (Curator's `tz`), else the viewer's zone.
 */
export function VizCalendar({ rows, dateField, endField, timeZone, canPickField, onOpenPreview, initialYear, initialMonth0 }: {
  rows: VizRow[];
  dateField: string | null;
  endField?: string | null;
  timeZone?: string | null;
  /** The Layout menu has a Date field picker (an editable view): the empty state points to it. */
  canPickField?: boolean;
  onOpenPreview?: (ref: PreviewRef) => void;
  initialYear?: number;
  initialMonth0?: number;
}) {
  const zone = calendarZone(timeZone);
  // The month shown: the one the user moved to, else this month in the zone, worked out on every
  // render so a zone that arrives after mount (the settings read landing) still opens on its month.
  const [moved, setMoved] = useState<{ year: number; month0: number } | null>(null);
  const today = dayKeyInZone(new Date(), zone);
  const year = moved?.year ?? initialYear ?? Number(today.slice(0, 4));
  const month0 = moved?.month0 ?? initialMonth0 ?? Number(today.slice(5, 7)) - 1;

  if (!dateField) {
    return (
      <div className="viz-body">
        <div className="cal-empty">{canPickField ? 'No date field — pick one under Layout › Date field.' : 'No date field.'}</div>
      </div>
    );
  }

  const step = (delta: number) => {
    setMoved((prev) => {
      const from = prev ?? { year, month0 };
      const m = from.month0 + delta;
      return { year: from.year + Math.floor(m / 12), month0: ((m % 12) + 12) % 12 };
    });
  };
  const end = endField && endField !== dateField ? endField : null;
  const { items, undated } = calendarItems(rows, dateField, end, zone);
  const weeks = monthMatrix(year, month0);

  return (
    <div className="viz-body">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <span className="cal-month">{MONTHS[month0]} {year}</span>
        <button className="cal-nav" onClick={() => step(1)} aria-label="Next month">›</button>
        <span className="cal-by">by {dateField}{end ? ` → ${end}` : ''}</span>
      </div>
      <div className="cal-grid">
        <div className="cal-dows">
          {WEEKDAYS.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        </div>
        {weeks.map((week) => {
          const bars = layoutWeek(week, items);
          const lanes = Math.min(MAX_PER_DAY, bars.reduce((n, b) => Math.max(n, b.lane + 1), 0));
          const hidden = hiddenPerDay(bars, MAX_PER_DAY, week.length);
          const moreRow = lanes + 2;
          // Day numbers, the shown lanes, a "+N more" row, then the rest of the cell's height.
          const rowsTemplate = ['auto', ...Array<string>(lanes).fill('auto'), 'auto', '1fr'].join(' ');
          return (
            <div className="cal-week" key={week[0]!.iso} style={{ gridTemplateRows: rowsTemplate }}>
              {/* Each day's box spans the whole row; its number, bars and "+N more" sit on top. */}
              {week.map((cell, d) => (
                <div className={`cal-cell${cell.inMonth ? '' : ' out'}`} key={cell.iso} style={{ gridColumn: d + 1, gridRow: '1 / -1' }} />
              ))}
              {week.map((cell, d) => (
                <div className={`cal-day${cell.inMonth ? '' : ' out'}`} key={`day-${cell.iso}`} style={{ gridColumn: d + 1, gridRow: 1 }}>{cell.day}</div>
              ))}
              {bars.filter((b) => b.lane < MAX_PER_DAY).map((b) => {
                const r = b.item.row;
                const multiDay = b.item.end !== b.item.start;
                const cls = `cal-ev${b.continuesBefore ? ' cont-before' : ''}${b.continuesAfter ? ' cont-after' : ''}`;
                return (
                  <button
                    className={cls}
                    key={r.id}
                    style={{ gridColumn: `${b.col + 1} / span ${b.span}`, gridRow: b.lane + 2 }}
                    onClick={() => onOpenPreview?.({ nodeId: r.id })}
                    title={multiDay ? `${r.title} (${b.item.start} → ${b.item.end})` : r.title}
                  >{r.title}</button>
                );
              })}
              {hidden.map((n, d) => n > 0 && (
                <div className="cal-more" key={`more-${week[d]!.iso}`} style={{ gridColumn: d + 1, gridRow: moreRow }}>+{n} more</div>
              ))}
            </div>
          );
        })}
      </div>
      {undated > 0 && <div className="cal-undated">{undated} undated</div>}
    </div>
  );
}
