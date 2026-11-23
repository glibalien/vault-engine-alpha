#!/usr/bin/env tsx
//
// scripts/issue-service-token.ts
//
// Issues a long-lived, scoped bearer token for a non-OAuth client (e.g. a cron
// job or programmatic caller that can't run the interactive OAuth flow but
// accepts a static Bearer header). Inserts a synthetic oauth_clients row and an
// oauth_tokens access row directly into the curator's DB. The cleartext token
// is printed once; only the SHA-256 hash is stored.
//
// Usage:
//   npx tsx scripts/issue-service-token.ts --name <slug> [--scope <csv>] [--ttl-days N]
//   npx tsx scripts/issue-service-token.ts --name <slug> --revoke
//   npx tsx scripts/issue-service-token.ts --revoke-sign-ins
//
// --revoke revokes every token of client service-<slug> instead of issuing one.
//
// --revoke-sign-ins ends every connection made through the sign-in page (claude.ai, Claude
// Code): it revokes those clients' tokens and leaves service tokens alone. Changing
// OAUTH_OWNER_PASSWORD does not do this, so run it after a rotation that should cut off
// whoever held a token. Each client signs in again afterwards.
//
// Examples:
//   npx tsx scripts/issue-service-token.ts --name nightly-cron
//   npx tsx scripts/issue-service-token.ts --name reader --scope curate:read
//
// Scopes default to "curate:trigger,curate:read"; unknown scopes are rejected.
// Every Curator MCP tool checks one of them (withScope, src/auth/with-scope.ts):
// curate:read for the read-only tools, curate:trigger for the rest.
//
// Target DB: CURATOR_DB_PATH (default <repo>/.state/curator.db).
//
// To revoke:
//   sqlite3 <db> "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = 'service-<slug>';"

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../src/auth/schema.js';
import { hashToken } from '../src/auth/provider.js';
import { parseScopes } from '../src/auth/scopes.js';
import { revokeSignIns } from '../src/auth/revoke-sign-ins.js';

function readFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

export function main(): void {
  if (process.argv.includes('--revoke-sign-ins')) {
    const signInDbPath = process.env['CURATOR_DB_PATH']?.trim() || resolve(process.cwd(), '.state/curator.db');
    // Revoking never creates a database.
    if (!existsSync(signInDbPath)) {
      console.log(`No database at ${signInDbPath}; nothing to revoke.`);
      return;
    }
    const signInDb = new Database(signInDbPath);
    signInDb.pragma('journal_mode = WAL');
    signInDb.pragma('foreign_keys = ON');
    createAuthSchema(signInDb);
    const { tokens, clients, codes } = revokeSignIns(signInDb);
    console.log(`Revoked ${tokens} sign-in token${tokens === 1 ? '' : 's'} of ${clients} client${clients === 1 ? '' : 's'}`
      + ` and deleted ${codes} pending authorization code${codes === 1 ? '' : 's'}. Service tokens are unchanged.`);
    return;
  }

  const rawName = readFlag('name');
  if (!rawName || !/^[a-z0-9][a-z0-9-]*$/.test(rawName)) {
    console.error('Usage: --name <slug>   (lowercase letters, digits, hyphens; must start alphanumeric)');
    process.exit(1);
  }

  const revoke = process.argv.includes('--revoke');
  let scopes: string[];
  try {
    scopes = parseScopes(readFlag('scope'));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const ttlDays = Number(readFlag('ttl-days') ?? '36500');
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    console.error('--ttl-days must be a positive number');
    process.exit(1);
  }

  const dbPath = process.env['CURATOR_DB_PATH']?.trim() || resolve(process.cwd(), '.state/curator.db');
  // Revoking never creates a database.
  if (revoke && !existsSync(dbPath)) {
    console.log(`No database at ${dbPath}; nothing to revoke.`);
    return;
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createAuthSchema(db);

  const clientId = `service-${rawName}`;
  if (revoke) {
    const { changes } = db
      .prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0')
      .run(clientId);
    console.log(`Revoked ${changes} token${changes === 1 ? '' : 's'} for client_id=${clientId}`);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + Math.floor(ttlDays * 86400);
  const secret = randomBytes(32).toString('hex');
  const tokenHash = hashToken(secret);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO oauth_clients (client_id, client_id_issued_at, client_secret, client_secret_expires_at, metadata)
      VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT(client_id) DO NOTHING
    `).run(clientId, now, JSON.stringify({
      client_id: clientId,
      client_name: rawName,
      grant_types: [],
      response_types: [],
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
      note: 'service token — provisioned via scripts/issue-service-token.ts',
    }));

    db.prepare(`
      INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
      VALUES (?, 'access', ?, ?, NULL, ?, ?, 0)
    `).run(tokenHash, clientId, scopes.join(' '), now, expiresAt);
  });
  tx();

  const expiresIso = new Date(expiresAt * 1000).toISOString();
  console.log(`Issued service token for client_id=${clientId}`);
  console.log(`Scopes:  ${scopes.join(' ')}`);
  console.log(`Expires: ${expiresIso} (${ttlDays} days)`);
  console.log('');
  console.log('Authorization header (copy to the app; this is the only time it will be shown):');
  console.log('');
  console.log(`  Authorization: Bearer ${secret}`);
  console.log('');
  console.log('To revoke later:');
  console.log(`  sqlite3 ${dbPath} "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = '${clientId}';"`);
}

// Only run the CLI when invoked directly (so tests can import helpers safely).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
