#!/usr/bin/env node
// ONE-TIME journal backfill — reconstructs historical Curator Journal entries
// from journald + the curator runs table. Prints markdown to stdout, grouped by
// month; a human reviews and applies it. Delete this script after the backfill.
//
// Usage:
//   journalctl -u vault-curator --output=short-iso > /tmp/curator.log   # on the prod host
//   node scripts/one-time-backfill-journal.mjs \
//     --log /tmp/curator.log --db /path/to/vault-suite-data/.state/curator.db > /tmp/journal-backfill.md
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1]; };
const logPath = opt('log');
const dbPath = opt('db');
if (!dbPath) { console.error('usage: --db <curator.db> [--log <journalctl output>]'); process.exit(1); }

// --- runs table → one line per recorded run, grouped by local date ---
const db = new Database(dbPath, { readonly: true });
const runs = db.prepare("SELECT ts, project, \"trigger\", outcome, themed_created, themed_retired, error FROM runs WHERE dry_run = 0 ORDER BY ts").all();

// --- journald lines → sweep summaries and action lines keyed by their ISO timestamp ---
const sweepLines = [];
if (logPath) {
  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    // short-iso format: "2026-07-11T05:00:12-0400 host process[pid]: [curator] ..."
    const m = raw.match(/^(\S+) \S+ \S+: \[curator\]\s+(.*)$/);
    if (!m) continue;
    const [, ts, line] = m;
    if (/^(org sweep|memory sweep):/.test(line) || /^(typed|moved|would type|would move) /.test(line.trim())) {
      sweepLines.push({ ts, line: line.trim() });
    }
  }
}

// --- group everything by YYYY-MM-DD (timestamps are already local-ish; good enough for backfill) ---
const days = new Map();
const dayOf = (ts) => ts.slice(0, 10);
const push = (day, line) => { if (!days.has(day)) days.set(day, []); days.get(day).push(line); };
for (const r of runs) {
  const outcome = r.error ? `ERROR: ${r.error}` : r.outcome;
  const themed = r.themed_created > 0 ? ` (+${r.themed_created} themed)` : '';
  push(dayOf(r.ts), `- ${r.project} — ${outcome}${themed} [${r.trigger}]`);
}
for (const s of sweepLines) push(dayOf(s.ts), `- ${s.line}`);

// --- emit one section per month, one entry per day, marked (backfilled) ---
let month = '';
for (const [day, lines] of [...days.entries()].sort()) {
  if (day.slice(0, 7) !== month) {
    month = day.slice(0, 7);
    console.log(`\n<!-- append to: Curator Journal — ${month} -->\n`);
  }
  console.log(`## ${day} — reconstructed *(backfilled)*\n`);
  for (const line of lines) console.log(line);
  console.log('');
}
db.close();
