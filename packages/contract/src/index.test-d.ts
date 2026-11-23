import type { Issue, Envelope, ErrorCode } from './index.js';

// Issue is the loose wire shape: code is a plain string.
const issue: Issue = { code: 'ANY_CODE', message: 'm', severity: 'warning' };
void issue;

// A success envelope carries data + warnings.
const okEnv: Envelope<{ id: string }> = { ok: true, data: { id: 'x' }, warnings: [] };
void okEnv;

// A failure envelope carries a typed error code.
const errCode: ErrorCode = 'NOT_FOUND';
const errEnv: Envelope<never> = { ok: false, error: { code: errCode, message: 'm' }, warnings: [] };
void errEnv;
