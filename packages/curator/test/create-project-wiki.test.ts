import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../src/core.js', () => ({ createProjectWiki: vi.fn(async () => ({ ok: true, project: 'Atlas', created: true })) }));

import { createProjectWiki } from '../src/core.js';
import { makeCreateProjectWikiHandler } from '../src/tools/create-project-wiki.js';

describe('create-project-wiki handler', () => {
  it('forwards the project, dry run and caller, and enforces curate:trigger', async () => {
    const handler = makeCreateProjectWikiHandler({} as never);
    const res = await handler({ project: 'Atlas', dry_run: true }, { authInfo: { scopes: ['curate:trigger'], clientId: 'client-1' } } as never);
    expect(createProjectWiki).toHaveBeenCalledWith({}, { project: 'Atlas', dryRun: true, by: 'client-1' });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true, project: 'Atlas' });
    const denied = await handler({ project: 'Atlas', dry_run: false }, { authInfo: { scopes: ['curate:read'] } } as never);
    expect(denied.isError).toBe(true);
    expect((createProjectWiki as Mock).mock.calls).toHaveLength(1);
  });
});
