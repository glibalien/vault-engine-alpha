import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { ParsedArgs } from '../transport/args.js';
import { applyReferenceActivation, previewReferenceActivation, type ReferenceActivationPreview, type ReferenceActivationReceipt } from './activation.js';

/** Offline is an operator assertion: deployment must stop every Engine writer. */
export function runReferenceAdministration(args: ParsedArgs, env: NodeJS.ProcessEnv): ReferenceActivationPreview | ReferenceActivationReceipt {
  if (!args.referenceResolution) throw new Error('Missing reference resolution mode');
  const vaultPath = args.vaultPath ?? env.VAULT_PATH;
  const dbPath = args.dbPath ?? env.DB_PATH ?? (vaultPath ? resolve(vaultPath, '.vault-engine', 'vault.db') : undefined);
  if (!dbPath) throw new Error('Reference administration requires a database path or VAULT_PATH');
  if (args.referenceResolution === 'apply' && (!args.offline || !args.previewFingerprint)) {
    throw new Error('Reference activation requires --offline and --preview-fingerprint');
  }
  // Never call Engine openDatabase: it creates directories and changes journal mode.
  const db = new Database(dbPath, { readonly: args.referenceResolution === 'preview', fileMustExist: true });
  try {
    return args.referenceResolution === 'preview'
      ? previewReferenceActivation(db)
      : applyReferenceActivation(db, args.previewFingerprint!);
  } finally { db.close(); }
}
