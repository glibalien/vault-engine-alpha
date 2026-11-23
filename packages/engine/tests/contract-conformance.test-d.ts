import type { Issue as ContractIssue, Envelope as ContractEnvelope, ErrorCode as ContractErrorCode } from '@vault/contract';
import type { Issue as EngineIssue, Envelope as EngineEnvelope, ErrorCode as EngineErrorCode } from '../src/mcp/tools/errors.js';

// The engine's stricter Issue (code: IssueCode) must satisfy the loose wire Issue.
const _issue: ContractIssue = {} as EngineIssue;
void _issue;

// The engine's Envelope<T> must satisfy the contract Envelope<T>.
const _env: ContractEnvelope<unknown> = {} as EngineEnvelope<unknown>;
void _env;

// The engine's ErrorCode union must be a subset of the contract's ErrorCode.
const _code: ContractErrorCode = {} as EngineErrorCode;
void _code;

const _engineReferenceWarning: EngineIssue = { code: 'REFERENCE_AMBIGUOUS', severity: 'warning', message: 'Ambiguous', op_index: 2, details: { candidate_count: 2 } };
const _referenceWarning: ContractIssue = _engineReferenceWarning;
void _referenceWarning;
