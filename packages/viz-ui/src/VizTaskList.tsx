import { Icon } from './icon.js';
import type { VizRow } from './viz-spec.js';
import { fieldText, groupRows } from './viz-state.js';
import type { PreviewRef } from './preview-ref.js';
import { RefValue } from './RefValue.js';
import { SectionHead, StatusPill, type RowSections } from './VizTable.js';
import { useStatusScale, useVizVocabulary } from './viz-client-context.js';
import { namedFields, taskCheckboxOn } from './view-vocabulary.js';

/**
 * A checkbox list. The checkbox is the vault map's task status: ticked when the status is one of
 * the done statuses; a click writes the tick or untick value. A vault with no task status field
 * gets no checkbox. Nor does one whose tick values cannot work (taskCheckboxOn: no done tick value,
 * no usable untick value, or a value the field's enum does not take): each row then shows its status.
 */
export function VizTaskList({ rows, displayFields, onOpenPreview, refFields, onToggle, statusEnum, sections }: {
  rows: VizRow[];
  /** Group the rows into sections by a field (#573). Absent: one run of rows. */
  sections?: RowSections;
  displayFields?: string[];
  onOpenPreview?: (ref: PreviewRef) => void;
  refFields?: Set<string>;
  onToggle?: (rowId: string, field: string, value: string) => void;
  /** The values the task status field takes, when the view knows it is an enum (enumValuesOf). */
  statusEnum?: readonly string[];
}) {
  const vocabulary = useVizVocabulary();
  const statusField = vocabulary.taskStatusField;
  const checkbox = taskCheckboxOn(vocabulary, statusEnum);
  // Show up to two non-status fields as meta; fall back to project/due when unspecified.
  const meta = (displayFields ?? []).filter((f) => f !== statusField).slice(0, 2);
  const metaFields = meta.length > 0 ? meta : namedFields('project', vocabulary.dueField);
  const scale = useStatusScale();
  const renderRow = (r: VizRow) => {
    const status = statusField === null ? '' : fieldText(r.fields[statusField]);
    const done = statusField !== null && vocabulary.taskDoneStatuses.includes(status);
    return (
      <div className={`vtask${done ? ' done' : ''}`} key={r.id}>
        {statusField === null || !checkbox ? null : onToggle ? (
          <button
            className={`cbox${done ? ' done' : ''}`}
            aria-label={`toggle ${r.title}`}
            onClick={() => onToggle(r.id, statusField, done ? vocabulary.taskUntickStatus : vocabulary.taskTickStatus)}
          >
            {done && <Icon name="check" />}
          </button>
        ) : (
          <div className={`cbox${done ? ' done' : ''}`} aria-hidden="true">{done && <Icon name="check" />}</div>
        )}
        <span className="ttext">{onOpenPreview ? <button className="viz-ref" onClick={() => onOpenPreview({ nodeId: r.id })}>{r.title}</button> : r.title}</span>
        <div className="tmeta">
          {!checkbox && status !== '' && <StatusPill value={status} />}
          {metaFields.map((f, i) => (
            <span className={i === 0 ? 'tproj' : 'tdue'} key={f}>
              {refFields?.has(f)
                ? <RefValue raw={r.fields[f]} isRef onOpenPreview={onOpenPreview} className="" />
                : fieldText(r.fields[f])}
            </span>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="viz-body">
      <div className="vtasks">
        {sections
          ? groupRows(rows, sections.field, scale, sections.byDay).map((g) => {
            const folded = sections.folded.has(g.value);
            return (
              <div className="vsection" key={`section:${g.value}`}>
                <SectionHead group={g} folded={folded} onToggle={() => sections.onToggle(g.value)} />
                {!folded && g.rows.map(renderRow)}
              </div>
            );
          })
          : rows.map(renderRow)}
      </div>
    </div>
  );
}
