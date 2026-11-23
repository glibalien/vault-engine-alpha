import type Database from 'better-sqlite3';

/** Service tokens (scripts/issue-service-token.ts) carry this client id prefix. */
const SERVICE_PREFIX = 'service-';

export interface RevokedSignIns {
  /** Access and refresh tokens that were live and are now revoked. */
  tokens: number;
  /** Clients those tokens belonged to. */
  clients: number;
  /** Authorization codes approved but not yet exchanged, now deleted. */
  codes: number;
}

/**
 * End every connection made through the sign-in page: revoke the tokens of every client
 * that is not a service client, and delete the authorization codes still waiting to be
 * exchanged. Service tokens are left alone.
 *
 * Changing the owner password does not do this. A token issued under the old password
 * keeps working and its refresh token keeps renewing it, so this is the step that makes a
 * rotation cut off whoever held the old password's tokens. Each client signs in again
 * afterwards. Takes effect at once: tokens are checked against the database on every request.
 */
export function revokeSignIns(db: Database.Database): RevokedSignIns {
  return db.transaction((): RevokedSignIns => {
    const live = 'revoked = 0 AND substr(client_id, 1, length(@prefix)) != @prefix';
    const { clients } = db.prepare(`SELECT COUNT(DISTINCT client_id) AS clients FROM oauth_tokens WHERE ${live}`)
      .get({ prefix: SERVICE_PREFIX }) as { clients: number };
    const tokens = db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE ${live}`).run({ prefix: SERVICE_PREFIX }).changes;
    const codes = db.prepare('DELETE FROM oauth_codes').run().changes;
    return { tokens, clients, codes };
  })();
}
