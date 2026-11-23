import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The embedder model cache for tests that start a real Engine. Without it the Engine
 * downloads the model (about 130 MB) into each throwaway vault's `.vault-engine/models`,
 * and an embedder process that outlives the Engine can recreate that folder after the
 * test removed it. `VAULT_ENGINE_MODELS_DIR` (the dedicated test cache) wins; otherwise
 * a folder under the repo's `node_modules/.cache`, which sits on disk and is git-ignored.
 */
export function sharedTestModelsDir(): string {
  const configured = process.env.VAULT_ENGINE_MODELS_DIR?.trim();
  const dir = configured
    ? resolve(configured)
    : resolve(import.meta.dirname, '../../../../node_modules/.cache/vault-engine-test-models');
  mkdirSync(dir, { recursive: true });
  return dir;
}
