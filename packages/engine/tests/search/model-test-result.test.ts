import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const resultScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/verify-model-test-result.mjs',
);

const sevenPasses = {
  numTotalTests: 7,
  numPassedTests: 7,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
};

function runValidator(report: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'model-test-result-'));
  const reportPath = join(directory, 'vitest.json');
  writeFileSync(reportPath, typeof report === 'string' ? report : JSON.stringify(report));
  const result = spawnSync(process.execPath, [resultScript, reportPath], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe('model test result validator', () => {
  it('accepts exactly seven passing tests', () => {
    const result = runValidator(sevenPasses);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[model-tests] result=7 passed, 0 failed, 0 skipped, 0 todo');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['total count', { numTotalTests: 6 }],
    ['passed count', { numPassedTests: 6 }],
    ['failed count', { numFailedTests: 1 }],
    ['pending count', { numPendingTests: 1 }],
    ['todo count', { numTodoTests: 1 }],
    ['success flag', { success: false }],
    ['string count', { numTotalTests: '7' }],
  ])('rejects a report with an invalid %s', (_field, change) => {
    const result = runValidator({ ...sevenPasses, ...change });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^\[model-tests\] ERROR:/);
  });

  it('rejects malformed JSON with a model-tests error', () => {
    const result = runValidator('{not valid json');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^\[model-tests\] ERROR:/);
  });

  it('rejects a nonexistent report with a model-tests error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-test-result-'));
    const result = spawnSync(process.execPath, [resultScript, join(directory, 'missing.json')], { encoding: 'utf8' });
    rmSync(directory, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^\[model-tests\] ERROR:/);
  });

  it('rejects missing or extra CLI arguments with usage exit code 2', () => {
    const missing = spawnSync(process.execPath, [resultScript], { encoding: 'utf8' });
    const extra = spawnSync(process.execPath, [resultScript, 'report.json', 'extra'], { encoding: 'utf8' });

    expect(missing.status).toBe(2);
    expect(extra.status).toBe(2);
    expect(missing.stderr).toContain('Usage: node scripts/verify-model-test-result.mjs <vitest-json-report>');
    expect(extra.stderr).toContain('Usage: node scripts/verify-model-test-result.mjs <vitest-json-report>');
  });
});
