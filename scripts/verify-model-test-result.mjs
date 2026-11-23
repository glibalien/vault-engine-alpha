#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const expected = {
  numTotalTests: 7,
  numPassedTests: 7,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
};

function fail(message) {
  console.error(`[model-tests] ERROR: ${message}`);
  process.exit(1);
}

const [reportPath, extra] = process.argv.slice(2);
if (!reportPath || extra) {
  console.error('Usage: node scripts/verify-model-test-result.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`Vitest JSON report is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
}
if (!report || typeof report !== 'object' || Array.isArray(report)) {
  fail('Vitest JSON report has an unsupported schema');
}
for (const [field, value] of Object.entries(expected)) {
  if (report[field] !== value) {
    fail(`Vitest JSON report expected ${field}=${String(value)}, received ${String(report[field])}`);
  }
}
console.log('[model-tests] result=7 passed, 0 failed, 0 skipped, 0 todo');
