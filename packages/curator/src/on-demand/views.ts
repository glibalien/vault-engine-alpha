import type Database from 'better-sqlite3';
import type { OnDemandRunRow } from '../db/on-demand-runs.js';
import { viewFieldFillRun, type FieldFillRunView } from '../field-fill/run.js';
import { viewTypeNotesRun, type TypeNotesRunView } from '../type-notes/run.js';
import { SUBJECT_RUN_JOB, viewSubjectRun, type SubjectRunView } from '../memory-subjects/run.js';
import { EXTRACTION_RUN_JOB, viewExtractionRun, type ExtractionRunView } from '../memory-extraction/run.js';

/** Any job's run as its own tool shows it: for places that show the run in progress whatever it is. */
export function viewOnDemandRun(db: Database.Database, run: OnDemandRunRow): FieldFillRunView | TypeNotesRunView | SubjectRunView | ExtractionRunView {
  if (run.job === SUBJECT_RUN_JOB) return viewSubjectRun(db, run);
  if (run.job === EXTRACTION_RUN_JOB) return viewExtractionRun(db, run);
  return run.job === 'type-notes' ? viewTypeNotesRun(db, run) : viewFieldFillRun(db, run);
}
