import { runProvenanceRetention } from '../provenance/retention.js';
import type { ProvenanceLimits } from '../provenance/limits.js';
// src/db/maintenance.ts
//
// Physical DB health: daily online backups via VACUUM INTO (checkpoint +
// compact + copy in one statement), backup rotation, PRAGMA optimize, and
// (Part B) retention sweeps — one interval, no extra timers.
// Spec: docs/superpowers/specs/2026-06-09-db-health-bundle-design.md

import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { runRetentionSweeps } from './retention.js';
import { runTokenCleanup } from '../auth/token-cleanup.js';

export interface MaintenanceOptions {
  provenanceLimits?: () => ProvenanceLimits;
  backupDir?: string;            // default <db dir>/backups (VAULT_BACKUP_DIR)
  backupIntervalHours?: number;  // default 24
  backupKeep?: number;           // default 7
  enabled?: boolean;             // backups only; optimize/sweeps always run. VAULT_BACKUP_DISABLED=1 → false
  editsLogRetentionDays?: number;        // default 90 (EDITS_LOG_RETENTION_DAYS)
  extractionCacheRetentionDays?: number; // default 30 (EXTRACTION_CACHE_RETENTION_DAYS)
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  durationMs: number;
  deletedBackups: string[];
  error?: string;
}

export interface LastBackupMeta {
  at: string;          // ISO timestamp of the attempt
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

const LAST_BACKUP_KEY = 'maintenance_last_backup';
const BACKUP_FILE_RE = /^vault-\d{4}-\d{2}-\d{2}\.db$/;

export function resolveBackupDir(dbPath: string): string {
  return process.env.VAULT_BACKUP_DIR ?? join(dirname(dbPath), 'backups');
}

/** Backup files in `backupDir`, sorted oldest → newest (filename = date). */
export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir).filter(f => BACKUP_FILE_RE.test(f)).sort();
}

export function readLastBackup(db: Database.Database): LastBackupMeta | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_BACKUP_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as LastBackupMeta;
  } catch {
    return null;
  }
}

export function writeLastBackup(db: Database.Database, meta: LastBackupMeta): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(LAST_BACKUP_KEY, JSON.stringify(meta));
}

function isBackupStale(backupDir: string, intervalMs: number): boolean {
  const files = listBackups(backupDir);
  if (files.length === 0) return true;
  const newest = join(backupDir, files[files.length - 1]);
  try {
    return Date.now() - statSync(newest).mtimeMs >= intervalMs;
  } catch {
    return true;
  }
}

export function startMaintenance(
  db: Database.Database,
  dbPath: string,
  opts: MaintenanceOptions = {},
): { stop: () => void } {
  const backupDir = opts.backupDir ?? resolveBackupDir(dbPath);
  // setInterval wraps above 2^31−1 ms (~596h) and would fire every tick.
  const intervalHours = Math.min(opts.backupIntervalHours ?? 24, 596);
  const backupKeep = opts.backupKeep ?? 7;
  const enabled = opts.enabled ?? true;
  const intervalMs = intervalHours * 3_600_000;

  const backup = (): void => {
    const res = runBackup(db, { backupDir, backupKeep });
    if (res.ok) {
      console.log(`[maintenance] backup → ${res.path} (${res.bytes} bytes, ${res.durationMs}ms${res.deletedBackups.length > 0 ? `, rotated out ${res.deletedBackups.join(', ')}` : ''})`);
    }
  };

  const optimize = (): void => {
    try {
      db.pragma('optimize');
    } catch (err) {
      console.error('[maintenance] optimize failed:', err instanceof Error ? err.message : err);
    }
  };

  const sweep = (): void => {
    try {
      const r = runRetentionSweeps(db, {
        editsLogRetentionDays: opts.editsLogRetentionDays,
        extractionCacheRetentionDays: opts.extractionCacheRetentionDays,
      });
      const t = runTokenCleanup(db);
      if (opts.provenanceLimits) runProvenanceRetention(db, opts.provenanceLimits());
      const total = r.editsLogDeleted + r.extractionCacheEvicted + r.embeddingVecOrphansDeleted + r.memoryEmbeddingVecOrphansDeleted + t.codesDeleted + t.tokensDeleted;
      if (total > 0) {
        console.log(`[maintenance] retention: edits_log -${r.editsLogDeleted}, extraction_cache -${r.extractionCacheEvicted}, oauth_codes -${t.codesDeleted}, oauth_tokens -${t.tokensDeleted}, embedding_vec orphans -${r.embeddingVecOrphansDeleted}, memory_embedding_vec orphans -${r.memoryEmbeddingVecOrphansDeleted}`);
      }
    } catch (err) {
      console.error('[maintenance] retention sweep failed:', err instanceof Error ? err.message : err);
    }
  };

  // Boot: only back up if the newest snapshot is stale — the mtime check
  // survives restarts without needing a meta row.
  if (enabled && isBackupStale(backupDir, intervalMs)) backup();
  optimize();
  sweep();

  const handle = setInterval(() => {
    if (enabled) backup();
    optimize();
    sweep();
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(handle);
      // Shutdown-path optimize (cheap; no backup on shutdown — must stay fast).
      optimize();
    },
  };
}

export function runBackup(
  db: Database.Database,
  opts: { backupDir: string; backupKeep?: number },
): BackupResult {
  const started = Date.now();
  const keep = opts.backupKeep ?? 7;
  const deletedBackups: string[] = [];
  try {
    mkdirSync(opts.backupDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const dest = join(opts.backupDir, `vault-${date}.db`);
    // One backup per day: VACUUM INTO refuses to overwrite, so a same-day
    // rerun replaces the existing snapshot.
    if (existsSync(dest)) unlinkSync(dest);

    // Fold the WAL into the main file so the copy is complete, and reset the
    // live -wal to zero (this is also our explicit checkpoint).
    const [cp] = db.pragma('wal_checkpoint(TRUNCATE)') as [{ busy: number; log: number; checkpointed: number }];
    if (cp.busy) {
      console.warn(`[maintenance] wal_checkpoint(TRUNCATE) busy — WAL not truncated (log=${cp.log}, checkpointed=${cp.checkpointed})`);
    }
    db.prepare('VACUUM INTO ?').run(dest);

    const bytes = statSync(dest).size;
    const files = listBackups(opts.backupDir);
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      unlinkSync(join(opts.backupDir, f));
      deletedBackups.push(f);
    }
    writeLastBackup(db, { at: new Date().toISOString(), ok: true, path: dest, bytes });
    return { ok: true, path: dest, bytes, durationMs: Date.now() - started, deletedBackups };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A failed backup must never crash the engine — log loudly and report.
    console.error(`[maintenance] backup failed: ${msg}`);
    try {
      writeLastBackup(db, { at: new Date().toISOString(), ok: false, error: msg });
    } catch {
      // meta write is best-effort on the failure path
    }
    return { ok: false, durationMs: Date.now() - started, deletedBackups, error: msg };
  }
}
