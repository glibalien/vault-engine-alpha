import { appendFileSync } from 'node:fs';

const pidLog = process.env.VAULT_ENGINE_MODEL_TEST_PID_LOG;
if (!pidLog) {
  console.error('[real-embedder-worker-wrapper] VAULT_ENGINE_MODEL_TEST_PID_LOG is required');
  process.exit(1);
}

appendFileSync(pidLog, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
await import('../../dist/search/embedder-worker.js');
