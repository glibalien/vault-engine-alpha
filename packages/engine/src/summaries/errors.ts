export class SummaryError extends Error {
    constructor(public readonly code: 'INVALID_PARAMS' | 'VALIDATION_FAILED', message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}
export function invalid(message: string): never {
    throw new SummaryError('INVALID_PARAMS', message);
}
export function capacity(stage: 'parents' | 'relationships' | 'response_bytes', limit: number, observed: number): never {
    throw new SummaryError('INVALID_PARAMS', 'Summary capacity exceeded; narrow filters or lookups.', {
        reason: 'QUERY_LIMIT_EXCEEDED', stage, limit, observed_at_least: observed,
    });
}
