import { expect, it, vi } from 'vitest';
import type { CoreDeps } from '../src/core.js';
import { makePreviewHomeRefreshHandler, makeRefreshProjectHomeHandler, makeHomeRefreshStatusHandler } from '../src/tools/home-refresh.js';

const extra = (scopes: string[]) => ({ authInfo: { scopes } }) as any;
it('requires read scope for preview/status and trigger scope plus literal paid confirmation for execution', async () => {
  const deps = { engine: { inspectProvenance: vi.fn() } } as unknown as CoreDeps;
  const execute = makeRefreshProjectHomeHandler(deps);
  expect((await execute({} as any, extra(['curate:read']))).isError).toBe(true);
  expect((await execute({} as any, extra(['curate:trigger']))).isError).toBe(true);
  expect((await makePreviewHomeRefreshHandler(deps)({ output_revision_id: 'output' }, extra([]))).isError).toBe(true);
  expect((await makeHomeRefreshStatusHandler(deps)({ request_id: 'invalid' }, extra(['curate:read']))).isError).toBe(true);
  expect(deps.engine.inspectProvenance).not.toHaveBeenCalled();
});
