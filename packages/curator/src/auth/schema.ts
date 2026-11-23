import type Database from 'better-sqlite3';

export function createAuthSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id                TEXT PRIMARY KEY,
      client_id_issued_at      INTEGER NOT NULL,
      client_secret            TEXT,
      client_secret_expires_at INTEGER,
      metadata                 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code            TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      code_challenge  TEXT NOT NULL,
      scopes          TEXT NOT NULL DEFAULT '',
      resource        TEXT,
      state           TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      used_at         INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token       TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      client_id   TEXT NOT NULL,
      scopes      TEXT NOT NULL DEFAULT '',
      resource    TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      revoked_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id);
  `);

  // When a token was revoked and when an authorization code was exchanged (#533), so a
  // second presentation can be told from a first and timed against it. New tables have both
  // columns from the start; these add them to tables created earlier. Existing rows keep NULL.
  addColumn(db, 'oauth_tokens', 'revoked_at', 'INTEGER');
  addColumn(db, 'oauth_codes', 'used_at', 'INTEGER');
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}
