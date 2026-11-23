import type Database from 'better-sqlite3';

export class SyncLogger {
  private insertCount = 0;
  private retentionMs: number;
  private readonly stmt: Database.Statement;

  /**
   * `retentionHours` is the live setting value (engine domain,
   * `syncLogRetentionHours`); when omitted it falls back to the
   * `SYNC_LOG_RETENTION_HOURS` env var (default 24) for callers without a
   * SettingsService (e.g. the one-shot `--normalize` path). SyncLogger is a
   * shared singleton, so a live settings change re-arms it in place via
   * `setRetentionHours` rather than by reconstruction.
   */
  constructor(
    private db: Database.Database,
    retentionHours?: number,
    options: { deferInitialPrune?: boolean } = {},
  ) {
    const hours = retentionHours ?? parseInt(process.env.SYNC_LOG_RETENTION_HOURS ?? '24', 10);
    this.retentionMs = (isNaN(hours) ? 24 : hours) * 3_600_000;
    this.stmt = db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)',
    );
    this.pruneStmt = db.prepare('DELETE FROM sync_log WHERE timestamp < ?');
    if (!options.deferInitialPrune) this.prune();
  }

  watcherEvent(filePath: string, hash: string, size: number): void {
    this.log(filePath, 'watcher-event', 'watcher', { hash, size });
  }

  parseRetry(filePath: string, attempt: number, error: string): void {
    this.log(filePath, 'parse-retry', 'watcher', { attempt, error });
  }

  fileWritten(filePath: string, source: string, hash: string): void {
    this.log(filePath, 'file-written', source, { hash });
  }

  renameDetected(fromPath: string, toPath: string, nodeId: string, source: string): void {
    this.log(toPath, 'rename-detected', source, { from: fromPath, node_id: nodeId });
  }

  noop(filePath: string, source: string): void {
    this.log(filePath, 'noop', source, {});
  }

  /**
   * Re-arm the retention window (settings `syncLogRetentionHours`). Prunes
   * eagerly — mirroring the constructor — so tightening the window takes
   * effect immediately instead of waiting for the next 1000-insert sweep.
   */
  setRetentionHours(hours: number): void {
    this.retentionMs = hours * 3_600_000;
    this.prune();
  }

  private log(filePath: string, event: string, source: string, details: Record<string, unknown>): void {
    this.stmt.run(Date.now(), filePath, event, source, JSON.stringify(details));
    if (++this.insertCount % 1000 === 0) this.prune();
  }

  private readonly pruneStmt: Database.Statement;

  private prune(): void {
    this.pruneStmt.run(Date.now() - this.retentionMs);
  }
}
