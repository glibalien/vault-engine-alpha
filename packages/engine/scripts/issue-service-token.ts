#!/usr/bin/env tsx
//
// scripts/issue-service-token.ts
//
// Issues a long-lived bearer token for a non-OAuth client (e.g. an app that
// can't run the interactive authorization flow but accepts a static Bearer
// header). Inserts a synthetic oauth_clients row and an oauth_tokens row
// directly into the engine's DB. The cleartext token is printed once and
// only the SHA-256 hash is stored.
//
// Usage:
//   npx tsx scripts/issue-service-token.ts --name <client-name> [--ttl-days N]
//   npx tsx scripts/issue-service-token.ts --name <client-name> --revoke
//   npx tsx scripts/issue-service-token.ts --revoke-sign-ins
//
// --revoke revokes every token of client service-<client-name> instead of issuing one.
//
// --revoke-sign-ins ends every connection made through the sign-in page (claude.ai, Claude
// Code): it revokes those clients' tokens and leaves service tokens alone. Changing
// OAUTH_OWNER_PASSWORD does not do this, so run it after a rotation that should cut off
// whoever held a token. Each client signs in again afterwards.
//
// Example:
//   npx tsx scripts/issue-service-token.ts --name some-app --ttl-days 365
//
// To revoke:
//   sqlite3 $VAULT_PATH/.vault-engine/vault.db \
//     "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = 'service-some-app';"

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../src/auth/schema.js';
import { hashToken } from '../src/auth/provider.js';
import { serviceClientId } from '../src/auth/service-client.js';
import { revokeSignIns } from '../src/auth/revoke-sign-ins.js';

const VAULT_PATH = process.env.VAULT_PATH;
if (!VAULT_PATH) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

function readFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const DB_PATH = process.env.DB_PATH ?? join(VAULT_PATH, '.vault-engine/vault.db');

if (process.argv.includes('--revoke-sign-ins')) {
  // Revoking never creates a database: Engine treats an existing file as an older install.
  if (!existsSync(DB_PATH)) {
    console.log(`No database at ${DB_PATH}; nothing to revoke.`);
    process.exit(0);
  }
  const signInDb = new Database(DB_PATH);
  signInDb.pragma('journal_mode = WAL');
  signInDb.pragma('foreign_keys = ON');
  createAuthSchema(signInDb);
  const { tokens, clients, codes } = revokeSignIns(signInDb);
  console.log(`Revoked ${tokens} sign-in token${tokens === 1 ? '' : 's'} of ${clients} client${clients === 1 ? '' : 's'}`
    + ` and deleted ${codes} pending authorization code${codes === 1 ? '' : 's'}. Service tokens are unchanged.`);
  process.exit(0);
}

const rawName = readFlag('name');
if (!rawName || !/^[a-z0-9][a-z0-9-]*$/.test(rawName)) {
  console.error('Usage: --name <slug>   (lowercase letters, digits, hyphens; must start alphanumeric)');
  process.exit(1);
}

const revoke = process.argv.includes('--revoke');
const ttlDays = Number(readFlag('ttl-days') ?? '36500');
if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
  console.error('--ttl-days must be a positive number');
  process.exit(1);
}

// Revoking never creates a database: Engine treats an existing file as an older install.
if (revoke && !existsSync(DB_PATH)) {
  console.log(`No database at ${DB_PATH}; nothing to revoke.`);
  process.exit(0);
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

createAuthSchema(db);

const clientId = serviceClientId(rawName);
if (revoke) {
  const { changes } = db
    .prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0')
    .run(clientId);
  console.log(`Revoked ${changes} token${changes === 1 ? '' : 's'} for client_id=${clientId}`);
  process.exit(0);
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
    VALUES (?, 'access', ?, '', NULL, ?, ?, 0)
  `).run(tokenHash, clientId, now, expiresAt);
});
tx();

const expiresIso = new Date(expiresAt * 1000).toISOString();
console.log(`Issued service token for client_id=${clientId}`);
console.log(`Expires: ${expiresIso} (${ttlDays} days)`);
console.log('');
console.log('Authorization header (copy to the app; this is the only time it will be shown):');
console.log('');
console.log(`  Authorization: Bearer ${secret}`);
console.log('');
console.log(`To revoke later:`);
console.log(`  sqlite3 ${DB_PATH} "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = '${clientId}';"`);
