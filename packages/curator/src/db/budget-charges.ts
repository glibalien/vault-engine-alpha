import type Database from 'better-sqlite3';
import type { BudgetChargeStore } from '../budget.js';

/** Charges older than this can no longer affect a local day's budget. */
const RETAIN_MS = 48 * 3_600_000;

/** DDL for migration 29: daily-budget charges the Engine usage ledger never records. */
export function createBudgetChargesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE budget_charges (
      charged_at TEXT NOT NULL,
      amount_usd REAL NOT NULL CHECK (amount_usd > 0)
    );
    CREATE INDEX idx_budget_charges_charged_at ON budget_charges(charged_at);
  `);
}

export function budgetChargeStore(db: Database.Database): BudgetChargeStore {
  return {
    totalSince: sinceIso => (db.prepare('SELECT COALESCE(SUM(amount_usd), 0) AS total FROM budget_charges WHERE charged_at >= ?')
      .get(sinceIso) as { total: number }).total,
    record: (atIso, usd) => {
      db.transaction(() => {
        db.prepare('INSERT INTO budget_charges (charged_at, amount_usd) VALUES (?, ?)').run(atIso, usd);
        db.prepare('DELETE FROM budget_charges WHERE charged_at < ?')
          .run(new Date(Date.parse(atIso) - RETAIN_MS).toISOString());
      })();
    },
  };
}
