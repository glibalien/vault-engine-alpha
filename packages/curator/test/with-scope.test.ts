import { describe, expect, it, vi } from 'vitest';
import { withScope } from '../src/auth/with-scope.js';

describe('withScope', () => {
  it('passes through when the required scope is present', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const wrapped = withScope('curate:trigger', handler);
    const res = await wrapped({}, { authInfo: { scopes: ['curate:trigger', 'curate:read'] } });
    expect(handler).toHaveBeenCalledOnce();
    expect(res.content[0]?.text).toBe('ok');
  });

  it('rejects with FORBIDDEN when the scope is missing', async () => {
    const handler = vi.fn();
    const wrapped = withScope('curate:trigger', handler);
    const res = await wrapped({}, { authInfo: { scopes: ['curate:read'] } });
    expect(handler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('FORBIDDEN');
  });

  it('rejects when authInfo is absent', async () => {
    const wrapped = withScope('curate:trigger', vi.fn());
    const res = await wrapped({}, {});
    expect(res.isError).toBe(true);
  });
});
