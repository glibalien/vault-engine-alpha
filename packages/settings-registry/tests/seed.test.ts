import { describe, expect, it } from 'vitest';
import { seedFromEnv, staleEnvVars } from '../src/index.js';

describe('seedFromEnv(engine)', () => {
  it('parses, inverts, and validates env values', () => {
    const seeded = seedFromEnv('engine', {
      VAULT_EXCLUDE_DIRS: 'Templates, Archive',
      VAULT_BACKUP_DISABLED: '1',
      VAULT_BACKUP_KEEP: '5',
      NORMALIZE_CRON: '0 3 * * *',
      EDITS_LOG_RETENTION_DAYS: 'garbage',   // unparseable → dropped
    });
    expect(seeded).toEqual({
      excludeDirs: ['Templates', 'Archive'],
      backupsEnabled: false,
      backupKeep: 5,
      normalizeCron: '0 3 * * *',
    });
  });
  it('returns {} when no seed vars are set', () => {
    expect(seedFromEnv('engine', {})).toEqual({});
  });
  it('maps the legacy VISION_PROVIDER=qwen raw value to the new "model" enum value', () => {
    // Back-compat: the old third provider was named "qwen"; the descriptor's
    // envSeed.parse rewrites that raw env value to the generalized "model".
    expect(seedFromEnv('engine', { VISION_PROVIDER: 'qwen' })).toEqual({ visionProvider: 'model' });
    expect(seedFromEnv('engine', { VISION_PROVIDER: 'QWEN' })).toEqual({ visionProvider: 'model' });
    // A non-legacy value passes through untouched (and still validates against the enum).
    expect(seedFromEnv('engine', { VISION_PROVIDER: 'claude' })).toEqual({ visionProvider: 'claude' });
  });
  it('seeds visionModel from the (kept) QWEN_VISION_MODEL env var', () => {
    expect(seedFromEnv('engine', { QWEN_VISION_MODEL: '[[Kimi K2.6]]' })).toEqual({ visionModel: '[[Kimi K2.6]]' });
  });
  it('seeds extractionEnabled off only from EXTRACTION_ENABLED=false', () => {
    expect(seedFromEnv('engine', { EXTRACTION_ENABLED: 'false' })).toEqual({ extractionEnabled: false });
    expect(seedFromEnv('engine', { EXTRACTION_ENABLED: ' FALSE ' })).toEqual({ extractionEnabled: false });
    expect(seedFromEnv('engine', { EXTRACTION_ENABLED: 'true' })).toEqual({ extractionEnabled: true });
  });
});

describe('staleEnvVars', () => {
  it('names set migrated vars for the requested domain only', () => {
    const env = { VAULT_BACKUP_KEEP: '5', NORMALIZE_CRON: '0 3 * * *', VAULT_PATH: '/x', EMPTY: ' ' };
    expect(staleEnvVars('engine', env).map(s => s.var).sort())
      .toEqual(['NORMALIZE_CRON', 'VAULT_BACKUP_KEEP']);
    expect(staleEnvVars('engine', env).find(s => s.var === 'VAULT_BACKUP_KEEP')!.key).toBe('backupKeep');
    expect(staleEnvVars('wiki', env)).toEqual([]);   // wiki has no envSeed vars
  });
});
