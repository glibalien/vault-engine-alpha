import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { UsageRecorder } from './recorder.js';
import { reconciliationIntervals } from './openrouter-reconcile.js';
import { CONFIRMED_HEADERS, CONFIRMED_SUMS, COST_HEADERS, COST_SUMS, SWEEP_COLUMN, STAGE_COLUMN, OUTCOME_COLUMN, REPORTED_MODEL_COLUMN, usageMetadata } from './cost-columns.js';

export interface CsvReportStats {
  /** Rows written per file, excluding the header line. */
  files: Record<string, number>;
}

/** RFC 4180 field: NULL/undefined → empty; quote when the value contains
 *  comma, double-quote, CR, or LF; embedded quotes double. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(header: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) lines.push(header.map((col) => csvField(row[col])).join(','));
  return `${lines.join('\n')}\n`;
}

/** Fixed-name tmp + rename: a reader never observes a partial file, and a
 *  crash mid-write strands at most one .tmp, overwritten on the next cycle. */
function writeAtomic(dir: string, name: string, content: string): void {
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, join(dir, name));
}

/** usage_events columns in file order. Explicit — not SELECT * — so a future
 *  schema migration can't silently reorder or extend the export. */
const EVENT_COLUMNS = [
  'id', 'ts', 'provider', 'model', 'service', 'purpose',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'audio_seconds', 'cost_usd', 'cost_basis', 'pricing_json',
  'conversation_id', 'run_ref', 'source_ref', 'experiment', 'variant',
  'latency_ms', 'request_id', 'metadata_json',
] as const;

/** Shared aggregate SELECT fragment for all summary files. */
const SUM_COLS = `
  COUNT(*) AS events,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
  COALESCE(SUM(cost_usd), 0) AS cost_usd`;

const SUM_HEADERS = [
  'events', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'audio_seconds', 'cost_usd',
] as const;

/** Rewrites every report in .vault-engine/reports/ from the current ledger.
 *  Full rewrite by design — the ledger is small (thousands of rows at most). */
export function writeUsageCsvReports(db: Database.Database, reportsDir: string): CsvReportStats {
  mkdirSync(reportsDir, { recursive: true });
  const files: Record<string, number> = {};
  const emit = (name: string, header: readonly string[], rows: Array<Record<string, unknown>>): void => {
    writeAtomic(reportsDir, name, toCsv(header, rows));
    files[name] = rows.length;
  };

  // A provider's later confirmation of a row (#329) rides beside it; the row itself is unchanged.
  emit('usage-events.csv', [...EVENT_COLUMNS, 'confirmation_status', 'confirmed_cost_usd'], db.prepare(`
    SELECT ${EVENT_COLUMNS.map((c) => `e.${c}`).join(', ')},
      c.status AS confirmation_status, c.confirmed_cost_usd
    FROM usage_events e LEFT JOIN usage_confirmations c ON c.usage_event_id = e.id
    ORDER BY e.ts ASC, e.id ASC
  `).all() as Array<Record<string, unknown>>);

  emit('usage-daily.csv',
    ['day', 'service', 'provider', 'model', 'purpose', ...SUM_HEADERS, 'unpriced_events', ...CONFIRMED_HEADERS],
    db.prepare(`
      SELECT date(ts) AS day, service, provider, model, purpose, ${SUM_COLS},
        SUM(cost_basis = 'unpriced') AS unpriced_events, ${CONFIRMED_SUMS}
      FROM usage_events
      GROUP BY day, service, provider, model, purpose
      ORDER BY day ASC, cost_usd DESC
    `).all() as Array<Record<string, unknown>>);

  emit('usage-monthly.csv',
    ['month', 'provider', ...SUM_HEADERS, 'unpriced_events', ...CONFIRMED_HEADERS],
    db.prepare(`
      SELECT strftime('%Y-%m', ts) AS month, provider, ${SUM_COLS},
        SUM(cost_basis = 'unpriced') AS unpriced_events, ${CONFIRMED_SUMS}
      FROM usage_events
      GROUP BY month, provider
      ORDER BY month ASC, cost_usd DESC
    `).all() as Array<Record<string, unknown>>);

  emit('usage-by-conversation.csv',
    ['conversation_id', 'title', 'events', 'first_ts', 'last_ts',
     'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
     'audio_seconds', 'cost_usd'],
    db.prepare(`
      SELECT u.conversation_id, COALESCE(c.title, '') AS title,
        MIN(u.ts) AS first_ts, MAX(u.ts) AS last_ts, ${SUM_COLS}
      FROM usage_events u
      LEFT JOIN conversations c ON c.id = u.conversation_id
      WHERE u.conversation_id IS NOT NULL
      GROUP BY u.conversation_id
      ORDER BY cost_usd DESC
    `).all() as Array<Record<string, unknown>>);

  emit('usage-by-run.csv',
    ['run_ref', 'source_ref', 'purposes', 'started', 'ended',
     'events', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
     'audio_seconds', 'cost_usd'],
    db.prepare(`
      SELECT run_ref, MIN(source_ref) AS source_ref,
        group_concat(DISTINCT purpose ORDER BY purpose) AS purposes,
        MIN(ts) AS started, MAX(ts) AS ended, ${SUM_COLS}
      FROM usage_events
      WHERE run_ref IS NOT NULL
      GROUP BY run_ref
      ORDER BY cost_usd DESC
    `).all() as Array<Record<string, unknown>>);

  emit('usage-curator-sweeps.csv',
    ['sweep_ref', 'run_ref', 'source_ref', 'purpose', 'provider', 'stage', 'target', 'call_outcome', 'model', 'reported_model',
      'first_ts', 'last_ts', ...SUM_HEADERS, ...COST_HEADERS],
    db.prepare(`
      SELECT ${SWEEP_COLUMN} AS sweep_ref, run_ref, source_ref, purpose, provider,
        ${STAGE_COLUMN} AS stage, ${usageMetadata('$.wiki_call.target')} AS target, ${OUTCOME_COLUMN} AS call_outcome,
        model, ${REPORTED_MODEL_COLUMN} AS reported_model,
        MIN(ts) AS first_ts, MAX(ts) AS last_ts, ${SUM_COLS}, ${COST_SUMS}
      FROM usage_events WHERE service = 'curator'
      GROUP BY sweep_ref, run_ref, source_ref, purpose, provider, stage, target, call_outcome, model, reported_model
      ORDER BY first_ts DESC, cost_usd DESC
    `).all() as Array<Record<string, unknown>>);

  // OpenRouter's own spend per reading interval against the ledger over the same hours (#328).
  emit('usage-openrouter-reconciliation.csv',
    ['start_at', 'end_at', 'provider_usd', 'ledger_usd', 'gap_usd', 'ledger_events', 'ledger_unpriced_events', 'ledger_by_service', 'ledger_other_keys_usd'],
    reconciliationIntervals(db).map((i) => ({ ...i, ledger_by_service: JSON.stringify(i.ledger_by_service) })));

  return { files };
}

export interface UsageCsvReportsHandle {
  /** Schedules the debounced rewrite, as a recorded event does. For ledger changes that don't go
   *  through the recorder, such as provider confirmations (#329). */
  changed(): void;
  /** Clears any pending timer; if one was armed, flushes a final write. */
  stop(): void;
}

/** Boot write + debounced write-through. On each recorded event, arm one
 *  unref'd timer (default 60 s); events inside the window coalesce into a
 *  single rewrite, which reads the DB at fire time. All write failures warn
 *  and give up until the next trigger — never thrown into the record path. */
export function startUsageCsvReports(opts: {
  db: Database.Database;
  recorder: UsageRecorder;
  reportsDir: string;
  debounceMs?: number;
}): UsageCsvReportsHandle {
  const debounceMs = opts.debounceMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const write = (): void => {
    try {
      writeUsageCsvReports(opts.db, opts.reportsDir);
    } catch (err) {
      console.warn(`[usage] CSV reports not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  write(); // boot write — reports exist from first startup, even with an empty ledger

  const changed = (): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => { timer = null; write(); }, debounceMs);
    timer.unref();
  };
  opts.recorder.onRecorded = changed;

  return {
    changed,
    stop(): void {
      if (stopped) return;
      stopped = true;
      opts.recorder.onRecorded = undefined;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        write(); // flush — don't strand events recorded inside the window
      }
    },
  };
}
