import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { jsonDigest } from '../provenance-evidence.js';
import type { Json } from '../provenance-types.js';
import { isHomeRefreshTerminal, type HomeRefreshRequest, type HomeRefreshPhase, type HomeRefreshStatus } from '../home-refresh-types.js';

export interface HomeRefreshRow {
  request_id: string; request_digest: string; request_json: string;
  vault_namespace: string; home_node_id: string; project_id: string;
  phase: HomeRefreshPhase; resume_phase: HomeRefreshPhase | null; message: string;
  attempt_key: string; run_ref: string; generated_at: string;
  predecessor_attempt_id: string | null; lease_expires_at: string | null;
  stage_json: string | null; publication_json: string | null; result_json: string | null;
  usage_json: string | null; created_at: string; updated_at: string;
}
export function createHomeRefreshRequests(db: Database.Database): void {
  db.exec(`CREATE TABLE home_refresh_requests (
    request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, request_json TEXT NOT NULL,
    vault_namespace TEXT NOT NULL,home_node_id TEXT NOT NULL,project_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','dispatch_intent','stage_pending','publishing','awaiting_recovery','committed','conflict','failed','uncertain')),
    resume_phase TEXT, message TEXT NOT NULL, attempt_key TEXT NOT NULL,run_ref TEXT NOT NULL,generated_at TEXT NOT NULL,
    predecessor_attempt_id TEXT, lease_expires_at TEXT,
    stage_json TEXT,publication_json TEXT,result_json TEXT,usage_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX home_refresh_active ON home_refresh_requests(vault_namespace,home_node_id)
      WHERE phase IN ('queued','preparing','dispatch_intent','stage_pending','publishing','awaiting_recovery');`);
}
export function createHomeRefreshAliases(db: Database.Database): void {
  db.exec(`CREATE TABLE home_refresh_aliases (
    request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
    target_request_id TEXT NOT NULL REFERENCES home_refresh_requests(request_id));`);
}
export function getHomeRefresh(db: Database.Database, id: string, expectedDigest?: string): HomeRefreshRow | null {
  let row = db.prepare('SELECT * FROM home_refresh_requests WHERE request_id=?').get(id) as HomeRefreshRow | undefined;
  let requestDigest = row?.request_digest;
  if (!row) {
    const alias = db.prepare('SELECT * FROM home_refresh_aliases WHERE request_id=?').get(id) as
      { target_request_id: string; request_digest: string } | undefined;
    if (alias) {
      row = db.prepare('SELECT * FROM home_refresh_requests WHERE request_id=?').get(alias.target_request_id) as HomeRefreshRow | undefined;
      requestDigest = alias.request_digest;
    }
  }
  if (row && expectedDigest !== undefined && requestDigest !== expectedDigest) throw new Error('REQUEST_CONFLICT');
  return row ?? null;
}
export function admitHomeRefresh(db: Database.Database, request: HomeRefreshRequest): HomeRefreshRow {
  const digest = jsonDigest(request as unknown as Json);
  // The home_node_id column holds the node being rewritten, so requests coalesce per page.
  const targetNodeId = request.guard.page_node_id ?? request.guard.home_node_id;
  return db.transaction(() => {
    const old = getHomeRefresh(db, request.request_id, digest);
    if (old) return old;
    const active = db.prepare("SELECT * FROM home_refresh_requests WHERE vault_namespace=? AND home_node_id=? AND phase IN ('queued','preparing','dispatch_intent','stage_pending','publishing','awaiting_recovery')")
      .get(request.guard.vault_namespace, targetNodeId) as HomeRefreshRow | undefined;
    if (active) {
      db.prepare('INSERT INTO home_refresh_aliases(request_id,request_digest,target_request_id) VALUES (?,?,?)')
        .run(request.request_id, digest, active.request_id);
      return active;
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO home_refresh_requests(request_id,request_digest,request_json,vault_namespace,home_node_id,project_id,
      phase,message,attempt_key,run_ref,generated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?)`)
      .run(request.request_id,digest,JSON.stringify(request),request.guard.vault_namespace,targetNodeId,request.guard.project_id,
        `Waiting to rebuild this ${request.guard.page_node_id ? 'page' : 'home'}.`,randomUUID(),randomUUID(),now,now,now);
    return getHomeRefresh(db, request.request_id)!;
  }).immediate();
}
type Patch = Partial<Pick<HomeRefreshRow, 'phase' | 'resume_phase' | 'message' | 'attempt_key' | 'predecessor_attempt_id' | 'lease_expires_at' | 'stage_json' | 'publication_json' | 'result_json' | 'usage_json'>>;
export function transitionHomeRefresh(db: Database.Database, id: string, expected: HomeRefreshPhase, patch: Patch): HomeRefreshRow {
  return db.transaction(() => {
    const row = getHomeRefresh(db, id);
    if (!row || row.phase !== expected) throw new Error('REQUEST_STATE_CONFLICT');
    const next = { ...row, ...patch, updated_at: new Date().toISOString() };
    if (isHomeRefreshTerminal(next.phase)) { next.stage_json = null; next.publication_json = null; next.resume_phase = null; }
    db.prepare(`UPDATE home_refresh_requests SET phase=@phase,resume_phase=@resume_phase,message=@message,attempt_key=@attempt_key,
      predecessor_attempt_id=@predecessor_attempt_id,lease_expires_at=@lease_expires_at,
      stage_json=@stage_json,publication_json=@publication_json,result_json=@result_json,usage_json=@usage_json,updated_at=@updated_at WHERE request_id=@request_id`).run(next);
    return next;
  }).immediate();
}
export function listRecoverableHomeRefreshes(db: Database.Database): HomeRefreshRow[] {
  return db.prepare("SELECT * FROM home_refresh_requests WHERE phase IN ('queued','preparing','dispatch_intent','stage_pending','publishing','awaiting_recovery') ORDER BY created_at,request_id").all() as HomeRefreshRow[];
}
export function homeRefreshStatus(row: HomeRefreshRow): HomeRefreshStatus {
  const req = JSON.parse(row.request_json) as HomeRefreshRequest;
  return { request_id: row.request_id, phase: row.phase, message: row.message, created_at: row.created_at, updated_at: row.updated_at,
    replaces_output_revision_id: req.guard.output_revision_id, output: row.result_json ? JSON.parse(row.result_json) : null,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null };
}
